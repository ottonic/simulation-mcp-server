import { expect, it } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Artifacts, digest } from '../src/artifacts.js';
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
