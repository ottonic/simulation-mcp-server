/**
 * Waiting on job handles.
 *
 * `inspect_job` can wait in-process for a terminal state, so a caller replaces
 * dozens of round-trips with one call. The wait is always bounded and always
 * returns a state, terminal or not.
 */

import { isTerminalJobStatus } from './schemas.js';

const DEFAULT_POLL_MS = 500;

export interface PollOptions {
  /** Interval between reads, in milliseconds. */
  pollMs?: number;
  /** Injectable clock, so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable time source, so tests do not depend on wall time. */
  now?: () => number;
}

/**
 * Read a job's state until it is terminal or `waitMs` elapses, then return the
 * last state read.
 */
export async function pollUntilTerminal<T extends { status: string }>(
  read: () => Promise<T>,
  waitMs: number,
  options: PollOptions = {},
): Promise<T> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const deadline = now() + waitMs;

  for (;;) {
    const state = await read();
    if (isTerminalJobStatus(state.status)) return state;
    const remaining = deadline - now();
    if (remaining <= 0) return state;
    await sleep(Math.min(pollMs, remaining));
  }
}
