# Simulation MCP Server — contributor instructions

- Keep engineering choices explicit: never infer materials or boundary conditions,
  and never substitute a stale entity selection.
- Preserve exact-byte artifact revisions, configured-root checks for local path
  mistakes, bounded child processes, and failure/result verification.
- Solver processes inherit the trusted local environment; override only
  deterministic numerical/runtime settings unless a specific solver requires more.
- Treat the service as trusted-local, not a filesystem sandbox. Hosted deployment
  needs an external isolation boundary.
- Keep dependencies and test inputs in this repository; do not invoke other MCP
  servers from the implementation.
- Advertised tool schemas must be self-contained: inline `$defs`, no external
  `$ref` that a client would have to dereference.
- Use strict TypeScript, ESM imports with `.js` extensions, single quotes, and the
  existing Prettier/oxlint conventions.
- Prefer the `just` recipes. Run `just check` in the `checks` Nix shell for fast
  validation; use `just test-integration` in the full shell for native solver
  changes.
- Keep credentials out of the repository and document placeholders only.
- Report which native checks ran; do not treat skipped tests as solver evidence.

See the [README](README.md) for commands, supported physics, and build limits.
