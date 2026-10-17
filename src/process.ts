import { spawn, type ChildProcess } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ErrorCode } from './errors.js';

export type ProcessResult = {
  exitCode: number | null;
  signal: string | null;
  status: 'exited' | 'timeout' | 'cancelled' | 'output_limit' | 'spawn_error';
  startedAt: string;
  endedAt: string;
  stdout: string;
  stderr: string;
};
export function solverEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LANG: 'C',
    LC_ALL: 'C',
    OMP_NUM_THREADS: '1',
    OPENBLAS_NUM_THREADS: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}
function terminateTree(child: ChildProcess, force = false): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // taskkill /T includes descendants; avoid shell interpretation of the PID.
    const args = ['/PID', String(child.pid), '/T'];
    if (force) args.push('/F');
    const killer = spawn('taskkill', args, {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {
      try {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        /* already exited */
      }
    });
    return;
  }
  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    /* process group already gone */
  }
}
export async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  prefix: string,
  timeoutMs: number,
  signal?: AbortSignal,
  maxOutputBytes = 64 * 1024 * 1024,
): Promise<ProcessResult> {
  let stdoutFile: Awaited<ReturnType<typeof open>> | undefined;
  let stderrFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    stdoutFile = await open(join(cwd, `${prefix}.stdout`), 'wx', 0o600);
    stderrFile = await open(join(cwd, `${prefix}.stderr`), 'wx', 0o600);
  } catch (error) {
    // Do not leak the stdout handle if the stderr log cannot be created.
    await stdoutFile?.close();
    throw error;
  }
  if (!stdoutFile || !stderrFile) throw new Error('Failed to open process log files.');
  const startedAt = new Date().toISOString();
  let status: ProcessResult['status'] = 'exited';
  let size = 0,
    stdout = '',
    stderr = '';
  let writes = Promise.resolve();
  const child = spawn(executable, args, {
    cwd,
    env: solverEnvironment(),
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let killTimer: NodeJS.Timeout | undefined;
  const kill = (reason: ProcessResult['status']) => {
    if (status !== 'exited') return;
    status = reason;
    terminateTree(child);
    killTimer = setTimeout(() => terminateTree(child, true), 1000);
  };
  const timer = setTimeout(() => kill('timeout'), timeoutMs);
  const abort = () => kill('cancelled');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const receive = (which: 'stdout' | 'stderr', bytes: Buffer) => {
    const remaining = Math.max(0, maxOutputBytes - size);
    size += bytes.length;
    const kept = bytes.subarray(0, remaining);
    if (which === 'stdout') stdout += kept.toString('utf8');
    else stderr += kept.toString('utf8');
    writes = writes
      .then(async () => {
        await (which === 'stdout' ? stdoutFile : stderrFile).writeFile(kept);
      })
      .catch(() => {
        kill('output_limit');
      });
    if (size > maxOutputBytes) kill('output_limit');
  };
  child.stdout.on('data', (b: Buffer) => receive('stdout', b));
  child.stderr.on('data', (b: Buffer) => receive('stderr', b));
  child.on('error', () => {
    status = 'spawn_error';
  });
  try {
    const result = await new Promise<{
      exitCode: number | null;
      signal: string | null;
    }>((done) => child.once('close', (exitCode, sig) => done({ exitCode, signal: sig })));
    if (status !== 'exited' && child.pid) {
      terminateTree(child, true);
    }
    await writes;
    return {
      ...result,
      status,
      startedAt,
      endedAt: new Date().toISOString(),
      stdout,
      stderr,
    };
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    signal?.removeEventListener('abort', abort);
    await Promise.all([stdoutFile.close(), stderrFile.close()]);
  }
}
export function termination(
  result: ProcessResult,
  code: ErrorCode = 'solver_failed',
): ErrorCode | undefined {
  if (result.status !== 'exited') return result.status;
  if (result.exitCode !== 0) return 'process_failed';
  // Only explicit, unambiguous failure phrases count. Elmer prints `ERROR::`
  // for benign unknown-keyword warnings under `CHECK KEYWORDS Warn`, so a bare
  // `error:`/`fatal` match would mislabel successful runs.
  if (
    /\bFATAL ERROR\b|\b(did not converge|failed to converge|not converged)\b/i.test(
      `${result.stdout}\n${result.stderr}`,
    )
  )
    return code;
  return undefined;
}
