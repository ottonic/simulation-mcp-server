# Simulation MCP Contributor Instructions

- Keep engineering choices explicit: never infer materials, boundary conditions,
  or substitute stale entity selections.
- Preserve exact-byte artifact revisions, configured-root checks for local
  path mistakes, bounded child processes, and failure/result verification.
- Solver processes inherit the trusted local environment; override only
  deterministic numerical/runtime settings unless a specific solver requires otherwise.
- Treat the service as trusted-local, not a filesystem sandbox. Hosted deployment
  requires an external isolation boundary.
- Keep dependencies and test inputs server-local. Do not invoke other MCP servers
  from the implementation or rely on another repository's tests.
- Use strict TypeScript, ESM imports with `.js` extensions, single quotes, and
  existing Prettier/oxlint conventions.
- Prefer `just` recipes. Run `just check` in the `checks` Nix shell for fast
  validation; use `just test-integration` in the full shell for native solver changes.
- `.envrc` activates the flake; require `direnv allow` after changes. Server logs
  go to stderr as pino JSON; `MCP_LOG_LEVEL` and `MCP_LOG_FORMAT` tune them. Keep
  credentials out of the repository and document placeholders only.
- Keep language tooling and additive editor/agent configuration project-local.
- Report which native checks ran; do not treat skipped tests as solver evidence.

See [README](README.md) for commands, supported physics, and current build limitations.
