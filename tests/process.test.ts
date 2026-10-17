import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess, termination } from '../src/process.js';
import { temporary } from './helpers.js';

it('inherits the local environment and applies deterministic solver settings', async () => {
  const dir = await temporary();
  vi.stubEnv('HOME', dir);
  vi.stubEnv('SIMULATION_TEST_LOCAL_ENV', 'available');
  try {
    const result = await runProcess(
      process.execPath,
      [
        '-e',
        'console.log(JSON.stringify({home: process.env.HOME, local: process.env.SIMULATION_TEST_LOCAL_ENV, lang: process.env.LANG, threads: process.env.OMP_NUM_THREADS}))',
      ],
      dir,
      'environment',
      5000,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      home: dir,
      local: 'available',
      lang: 'C',
      threads: '1',
    });
  } finally {
    vi.unstubAllEnvs();
  }
});

it('passes arguments without a shell and captures exact bounded logs', async () => {
  const dir = await temporary();
  const argument = '$(touch SHOULD_NOT_EXIST); spaces "quoted"';
  const result = await runProcess(
    process.execPath,
    ['-e', 'process.stdout.write(process.argv[1]);process.stderr.write("diagnostic")', argument],
    dir,
    'args',
    5000,
  );
  expect(result.exitCode).toBe(0);
  expect(await readFile(join(dir, 'args.stdout'), 'utf8')).toBe(argument);
  expect(result.stderr).toBe('diagnostic');
});
it('classifies missing executable, nonzero exit, timeout, cancellation and output overflow', async () => {
  const dir = await temporary();
  const missing = await runProcess('/nonexistent-simulation-binary', [], dir, 'missing', 5000);
  expect(termination(missing)).toBe('spawn_error');
  const failed = await runProcess(process.execPath, ['-e', 'process.exit(7)'], dir, 'failed', 5000);
  expect(termination(failed)).toBe('process_failed');
  const timeout = await runProcess(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    dir,
    'timeout',
    50,
  );
  expect(termination(timeout)).toBe('timeout');
  const abort = new AbortController();
  const pending = runProcess(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    dir,
    'cancel',
    5000,
    abort.signal,
  );
  setTimeout(() => abort.abort(), 50);
  expect(termination(await pending)).toBe('cancelled');
  const overflow = await runProcess(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(65536))'],
    dir,
    'overflow',
    5000,
    undefined,
    1024,
  );
  expect(termination(overflow)).toBe('output_limit');
  expect((await readFile(join(dir, 'overflow.stdout'))).length).toBeLessThanOrEqual(1024);
});
it('never treats explicit nonconvergence as success', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', 'console.log("Linear solver did not converge")'],
    await temporary(),
    'convergence',
    5000,
  );
  expect(result.exitCode).toBe(0);
  expect(termination(result)).toBe('solver_failed');
});

it('ignores benign Elmer error-level warnings but flags real failures', async () => {
  const benign = await runProcess(
    process.execPath,
    ['-e', 'console.log("ERROR:: LoadInputFile: Unknown specifier:[true]")'],
    await temporary(),
    'benign',
    5000,
  );
  expect(benign.exitCode).toBe(0);
  expect(termination(benign)).toBeUndefined();
  const fatal = await runProcess(
    process.execPath,
    ['-e', 'console.log("FATAL ERROR: solver aborted")'],
    await temporary(),
    'fatal',
    5000,
  );
  expect(termination(fatal)).toBe('solver_failed');
  const worker = await runProcess(
    process.execPath,
    ['-e', 'console.log("did not converge")'],
    await temporary(),
    'worker',
    5000,
  );
  expect(termination(worker, 'worker_failed')).toBe('worker_failed');
});
