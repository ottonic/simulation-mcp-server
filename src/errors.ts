// Closed vocabulary of domain error codes returned by the server. Every
// `SimulationError` and `requireThat` must use one of these, so a typo is a
// compile error rather than a new undocumented code. `errorData` maps unexpected
// native errors to `internal_error`.
export const ERROR_CODES = [
  // Input and validation
  'invalid_input',
  'invalid_study',
  'invalid_physics',
  'invalid_selection',
  'invalid_job_kind',
  'unsupported_condition',
  'unsupported_physics',
  'unsupported_format',
  // Artifacts and paths
  'stale_artifact',
  'path_policy',
  'file_not_found',
  'too_large',
  // Mesh
  'bad_mesh',
  'bad_groups',
  // Execution
  'malformed_results',
  'solver_failed',
  'worker_failed',
  'conversion_failed',
  'process_failed',
  'spawn_error',
  'output_limit',
  'persistence_failed',
  // Lifecycle
  'cancelled',
  'timeout',
  'interrupted',
  // Worker protocol
  'worker_protocol',
  // Fallback
  'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class SimulationError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function requireThat(value: unknown, code: ErrorCode, message: string): asserts value {
  if (!value) throw new SimulationError(code, message);
}
export function errorData(error: unknown) {
  if (error instanceof SimulationError)
    return { code: error.code, message: error.message, details: error.details };
  if (error instanceof Error && error.name === 'ZodError')
    return { code: 'invalid_input' as const, message: error.message };
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'ENOENT')
      return {
        code: 'file_not_found' as const,
        message: 'A required local artifact or run record does not exist.',
      };
    if (['EACCES', 'EPERM', 'ELOOP', 'EISDIR'].includes(String(error.code)))
      return {
        code: 'path_policy' as const,
        message: 'A required artifact is inaccessible or is not an allowed regular file.',
      };
  }
  // Native errors may contain arbitrary host paths or environment data.
  return {
    code: 'internal_error' as const,
    message: 'Operation failed; inspect the retained workspace diagnostics.',
  };
}

/** The tool-level error pair: a stable code and a model-readable message. */
export function describeError(error: unknown): { code: string; message: string } {
  const { code, message } = errorData(error);
  return { code, message };
}
