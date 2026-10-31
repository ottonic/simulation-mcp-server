import { mkdir, realpath, writeFile, stat, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { artifactSchema, type ArtifactRef } from './schemas.js';
import { SimulationError, requireThat } from './errors.js';

export const digest = (bytes: Uint8Array | string) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
// Local, trusted-tool safety bounds: a single artifact read is capped at 1 GiB
// and the solver output collection at 2 GiB, so a runaway model or run cannot
// exhaust memory/disk. Both are intentionally generous for engineering meshes.
export const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;
export const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
export class Artifacts {
  private constructor(
    public workspace: string,
    public roots: string[],
  ) {}
  static async create(workspace: string, roots: string[]) {
    requireThat(roots.every(isAbsolute), 'path_policy', 'Input roots must be absolute paths.');
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const canonical = await realpath(workspace);
    const canonicalRoots = await Promise.all(
      roots.map(async (root) => {
        const path = await realpath(root);
        requireThat(
          (await stat(path)).isDirectory(),
          'path_policy',
          'Input roots must be directories.',
        );
        return path;
      }),
    );
    return new Artifacts(canonical, [...canonicalRoots, canonical]);
  }
  async directory() {
    const path = join(this.workspace, randomUUID());
    await mkdir(path, { mode: 0o700 });
    return path;
  }
  async bytes(uri: string): Promise<Buffer> {
    let url: URL;
    try {
      requireThat(
        !decodeURIComponent(uri).split('/').includes('..'),
        'path_policy',
        'Traversal segments are not allowed.',
      );
      url = new URL(uri);
    } catch (error) {
      if (error instanceof SimulationError) throw error;
      throw new SimulationError('invalid_input', 'Malformed artifact URI.');
    }
    requireThat(
      url.protocol === 'file:' && !url.host && !url.search && !url.hash,
      'path_policy',
      'Only local file URIs without query or fragment are supported.',
    );
    // Node rejects an encoded separator in a `file:` URL on every platform; that
    // is a malformed locator, not a missing artifact.
    requireThat(
      !/%(2f|5c)/i.test(url.pathname),
      'path_policy',
      'Only local file URIs without query or fragment are supported.',
    );
    const path = fileURLToPath(url);
    const canonical = await realpath(path);
    requireThat(
      this.roots.some((root) => inside(root, canonical)),
      'path_policy',
      'Input lies outside allowed roots.',
    );
    const file = await stat(canonical);
    requireThat(file.isFile(), 'path_policy', 'Artifact must be a regular file.');
    requireThat(
      file.size <= MAX_ARTIFACT_BYTES,
      'too_large',
      `Artifact exceeds the ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MiB local limit.`,
    );
    return readFile(canonical);
  }
  async verify(ref: ArtifactRef, format?: string) {
    artifactSchema.parse(ref);
    requireThat(ref.uri, 'invalid_input', 'A local artifact locator is required.');
    requireThat(!format || ref.format === format, 'unsupported_format', `Expected ${format}.`);
    const bytes = await this.bytes(ref.uri);
    requireThat(
      digest(bytes) === ref.revision,
      'stale_artifact',
      'Artifact revision no longer matches its exact bytes.',
    );
    return bytes;
  }
  async put(
    dir: string,
    name: string,
    bytes: string | Uint8Array,
    format: string,
    units?: string,
  ): Promise<ArtifactRef> {
    requireThat(
      inside(this.workspace, resolve(dir, name)),
      'path_policy',
      'Output escaped workspace.',
    );
    const path = join(dir, name);
    await writeFile(path, bytes, { flag: 'wx' });
    return artifactSchema.parse({
      revision: digest(bytes),
      uri: pathToFileURL(path).href,
      format,
      ...(units ? { units } : {}),
    });
  }
  async capture(path: string, format: string, units?: string): Promise<ArtifactRef> {
    requireThat(
      inside(this.workspace, await realpath(path)),
      'path_policy',
      'Output escaped workspace.',
    );
    const bytes = await this.bytes(pathToFileURL(path).href);
    return artifactSchema.parse({
      revision: digest(bytes),
      uri: pathToFileURL(path).href,
      format,
      ...(units ? { units } : {}),
    });
  }
  async json<T>(ref: ArtifactRef, schema: { parse(x: unknown): T }): Promise<T> {
    return schema.parse(JSON.parse((await this.verify(ref, 'json')).toString('utf8')));
  }
}
