import { requireThat } from './errors.js';

// Group assignments must be unique and reference known groups. When `complete`
// is set they must also cover every expected group exactly once.
export function assertGroupCoverage(ids: number[], expected: number[], message: string) {
  requireThat(
    new Set(ids).size === ids.length &&
      ids.length === expected.length &&
      ids.every((id) => expected.includes(id)),
    'invalid_physics',
    message,
  );
}

export function assertGroupSubset(ids: number[], expected: number[], message: string) {
  requireThat(
    new Set(ids).size === ids.length && ids.every((id) => expected.includes(id)),
    'invalid_physics',
    message,
  );
}
