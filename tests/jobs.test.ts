import { describe, expect, it } from 'vitest';
import { onAbort } from '../src/abort.js';
import { pollUntilTerminal } from '../src/jobs.js';

describe('onAbort', () => {
  it('runs the handler immediately when the signal is already aborted', () => {
    let fired = 0;
    const controller = new AbortController();
    controller.abort();
    onAbort(controller.signal, () => {
      fired += 1;
    });
    expect(fired).toBe(1);
  });

  it('runs the handler when the signal aborts later, and only once', () => {
    let fired = 0;
    const controller = new AbortController();
    const dispose = onAbort(controller.signal, () => {
      fired += 1;
    });
    controller.abort();
    controller.abort();
    expect(fired).toBe(1);
    dispose();
  });

  it('does nothing without a signal, and the disposer detaches', () => {
    let fired = 0;
    expect(() =>
      onAbort(undefined, () => {
        fired += 1;
      })(),
    ).not.toThrow();
    const controller = new AbortController();
    onAbort(controller.signal, () => {
      fired += 1;
    })();
    controller.abort();
    expect(fired).toBe(0);
  });
});

describe('pollUntilTerminal', () => {
  it('returns a terminal state without sleeping', async () => {
    const slept: number[] = [];
    const state = await pollUntilTerminal(async () => ({ status: 'succeeded' }), 5_000, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(state.status).toBe('succeeded');
    expect(slept).toEqual([]);
  });

  it('polls until the state is terminal', async () => {
    const slept: number[] = [];
    let reads = 0;
    const state = await pollUntilTerminal(
      async () => ({ status: ++reads < 3 ? 'running' : 'succeeded' }),
      5_000,
      {
        pollMs: 10,
        now: () => 0,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );
    expect(state.status).toBe('succeeded');
    expect(reads).toBe(3);
    expect(slept).toEqual([10, 10]);
  });

  it('gives up at the deadline, clipping the final wait', async () => {
    let clock = 0;
    const slept: number[] = [];
    const state = await pollUntilTerminal(async () => ({ status: 'preparing' }), 1_000, {
      pollMs: 400,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    expect(state.status).toBe('preparing');
    expect(slept).toEqual([400, 400, 200]);
    expect(clock).toBe(1_000);
  });
});
