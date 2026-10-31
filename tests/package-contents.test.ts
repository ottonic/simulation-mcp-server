import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `src/index.ts` imports `../package.json`, which TypeScript emits to
 * `dist/package.json`, so that copy is what the built server reads at runtime.
 * Omitting it from `files` shipped a package that crashed on startup with
 * ERR_MODULE_NOT_FOUND, and the packed smoke that catches it is not a required
 * check — so guard it here, in `just check`, where the failure is cheap.
 */
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('published package contents', () => {
  it('ships the package.json the built entry point resolves', () => {
    expect(packageJson.files).toContain('dist/package.json');
  });
});
