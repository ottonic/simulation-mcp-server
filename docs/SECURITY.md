# Security

## Posture

STEP files are sensitive engineering IP and are treated as untrusted input. The
server is local-first and runs solver toolchains as child processes; it is not a
filesystem sandbox. Hosted deployment requires an external isolation boundary.

## Current local mode

Assumptions:

- The operator supplies local file paths and configures allowed input roots.
- The server runs on the user's machine or a controlled environment.
- Tools read STEP files, mesh with Gmsh, and solve with Elmer; no CAD edits.
- No network upload is required by the analysis path.

Guardrails already implemented:

- **Root confinement.** Every artifact read is canonicalized with `realpath` and
  must resolve inside a configured input root or the workspace; traversal
  segments, non-`file:` schemes, queries, fragments, and non-regular files are
  rejected (`src/artifacts.ts`).
- **Bounded inputs and outputs.** A single artifact read is capped at 1 GiB and
  collected solver outputs at 2 GiB (`MAX_ARTIFACT_BYTES`, `MAX_OUTPUT_BYTES`);
  child processes have a wall-clock timeout and a bounded stdout/stderr capture
  (`src/process.ts`).
- **No shell, no arbitrary code.** Child processes use fixed argument arrays with
  `shell: false`. Callers cannot supply SIF text, procedures, expressions, paths,
  or scripts; generated SIFs interpolate only validated finite numbers and
  integer group ids (`src/thermal.ts`, `src/structural.ts`, `src/electric.ts`,
  `src/flow.ts`).
- **Explicit engineering inputs.** Materials, loads, and conditions are never
  inferred; unavailable physics are refused.
- **Secrets.** No credentials are read or logged; `.env` is not auto-loaded.

Local precautions:

- Only point the server at models you intend to analyze.
- Treat import/mesh/solve failures as expected, not exceptional.
- Do not log raw STEP contents.

## Hosted or composed mode

If this server is hosted, or a remote capability receives its artifacts, add a
hardened intake path:

- allowlist extensions and validate file signatures;
- size-limit uploads and store them outside any public webroot;
- compute hashes and scan files before processing;
- parse in isolated workers with capped CPU, memory, file size, and wall clock;
- disable worker network access by default and run workers as non-root;
- keep processing libraries patched.

A domain server must not infer consent from being connected through an MCP host;
the host must show users which capabilities receive their data and whether
processing is local or remote.

## Sensitive outputs

Even structured outputs can reveal design information (file names, product names,
dimensions, volumes, feature counts, meshes). For hosted use, treat reports and
generated artifacts with the same access controls as the source CAD.

## Report language

Findings are computed facts from the supplied model and current tool
capabilities, not manufacturing approval or compliance. Engineering judgment,
drawings, supplier confirmation, and native CAD/PMI remain required for final
decisions; absence of findings does not guarantee manufacturability or compliance.
