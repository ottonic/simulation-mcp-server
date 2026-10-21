/**
 * Shared abort plumbing for long-running work.
 *
 * A cancelled or timed-out MCP request must stop the work it started. The
 * `AbortSignal` arrives from the request context (`ctx.signal`), so both
 * `prepare_study` and `run_study` need the same three-case handling: already
 * aborted, aborted later, and never.
 */

/** Run `handler` when `signal` aborts (immediately if it already has). */
export function onAbort(signal: AbortSignal | undefined, handler: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    handler();
    return () => {};
  }
  signal.addEventListener('abort', handler, { once: true });
  return () => signal.removeEventListener('abort', handler);
}
