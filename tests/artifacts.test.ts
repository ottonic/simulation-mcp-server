import { expect, it } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Artifacts, digest } from '../src/artifacts.js';
import { errorData } from '../src/errors.js';
import { temporary } from './helpers.js';

it('limits inputs to configured local roots', async () => {
  const root = await temporary(),
    outside = await temporary();
  const path = join(root, 'part.step');
  await writeFile(path, 'allowed');
  await writeFile(join(outside, 'secret.step'), 'secret');
  const artifacts = await Artifacts.create(await temporary(), [root]);
  expect(await artifacts.bytes(pathToFileURL(path).href)).toEqual(Buffer.from('allowed'));
  await expect(
    artifacts.bytes(pathToFileURL(join(outside, 'secret.step')).href),
  ).rejects.toMatchObject({ code: 'path_policy' });

  const nested = join(root, 'nested');
  await mkdir(nested);
  await symlink(outside, join(nested, 'escape'), 'junction');
  await expect(
    artifacts.bytes(pathToFileURL(join(nested, 'escape', 'secret.step')).href),
  ).rejects.toMatchObject({ code: 'path_policy' });
  await expect(artifacts.bytes(pathToFileURL(root).href)).rejects.toMatchObject({
    code: 'path_policy',
  });
});

it('rejects an artifact whose exact-byte revision changed', async () => {
  const root = await temporary(),
    path = join(root, 'part.step');
  await writeFile(path, 'original');
  const artifacts = await Artifacts.create(await temporary(), [root]);
  const ref = {
    revision: digest('original'),
    uri: pathToFileURL(path).href,
    format: 'step',
  };
  await writeFile(path, 'modified');
  await expect(artifacts.verify(ref)).rejects.toMatchObject({
    code: 'stale_artifact',
  });
});

it('reports a locator that names no artifact here as a miss, never as internal', async () => {
  const artifacts = await Artifacts.create(await temporary(), [await temporary()]);
  // Node rejects an encoded separator in a `file:` URL on every platform: a
  // malformed locator, not a missing artifact.
  await expect(artifacts.bytes('file:///part%2Fname.step')).rejects.toMatchObject({
    code: 'path_policy',
  });
  // Windows refuses a `file:` URL whose path has no drive letter. It names no
  // artifact there, so the caller must see a miss rather than an internal error.
  const refused = Object.assign(new Error('must be absolute'), {
    code: 'ERR_INVALID_FILE_URL_PATH',
  });
  expect(errorData(refused)).toMatchObject({ code: 'file_not_found' });
});
