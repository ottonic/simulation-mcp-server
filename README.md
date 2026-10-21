# Simulation MCP

Independent local stdio MCP: STEP → explicit physical groups → Gmsh → ElmerGrid
→ typed thermal/structural/modal/DC conduction/laminar-flow studies → ElmerSolver → revisioned VTU/scalars/logs.
Node 24 / TypeScript uses MCP SDK 2.3.1. A Python Gmsh
worker uses a one-request/one-response JSON-file protocol (`protocol: 1`).
No other MCP service, cloud service or prepared SIF is required.

**Local validation (2026-10-17):** Nix Gmsh 4.15.0 and Elmer 26.2 completed
production-SIF qualifications for steady/transient thermal, static-structural,
modal frequency, DC potential, and steady/transient laminar flow, each against an
analytic reference with mesh (or timestep) refinement. This is local runtime
evidence, not verification of every target platform.

## Install and launch

Distribution targets match Geometry MCP: Windows x64, macOS ARM64 (Apple
Silicon), and Linux x64. Intel macOS, Linux ARM64, and Windows ARM64 are outside
the target matrix. CI runs unit/artifact/process checks on these three targets,
builds the pinned serial Elmer solver on each target, caches the native install,
runs the analytic integration and qualification suites, then packs and
smoke-tests the published tarball. This validates native execution; a standalone
runtime package is not yet published.

The repository owns its artifact schema in `contracts/`. Builds bundle that
schema and the Python worker; Gmsh and Elmer runtimes are installed separately.

From this directory:

```sh
nix develop
just setup
just build
export SIMULATION_INPUT_ROOTS='["/absolute/path/to/models"]'
export SIMULATION_WORKSPACE=/absolute/path/to/run-workspace
just start
```

`.envrc` already contains `use flake`; `direnv allow` is an alternative to
`nix develop`. `.env.example` documents variables; `.env` is not auto-loaded.
`just setup` installs npm dependencies without lifecycle scripts. The flake
pins nixpkgs (and thus Gmsh) by commit, and pins upstream Elmer by commit.
Elmer's transitive inputs use its checked-in lock.

Nix provisions the solver toolchain only on x86_64-linux.
`packages.<system>.toolchain` provisions Node, Gmsh, the Python wrapper and
headless upstream Elmer built serially without MPI, OpenMP, ElmerIce or Lua. The analytic
thermal benchmark passes with that serial solver. The dev shell also provisions
Python, Ruff and Nix tooling;
TypeScript language server/formatter/linter/test deps are project-local npm
dependencies. Gmsh's Python module lives under its Nix package's `lib`, supplied
through `PYTHONPATH`. Elmer is an external package, not compiled by npm.

Non-Nix deployments must provide compatible Gmsh Python bindings and native
library plus `ElmerGrid` and `ElmerSolver` with `HeatSolve`, `FluxSolver`,
`SaveData` and `ResultOutputSolve` modules. Executables are operator configuration:

| Variable                 | Default / meaning                                    |
| ------------------------ | ---------------------------------------------------- |
| `SIMULATION_INPUT_ROOTS` | Required JSON array of existing absolute input roots |
| `SIMULATION_WORKSPACE`   | `.simulation-runs`; local run/artifact storage       |
| `SIMULATION_PYTHON`      | `python3` (Windows: `python`); Nix sets its wrapper  |
| `SIMULATION_ELMERGRID`   | `ElmerGrid`                                          |
| `SIMULATION_ELMERSOLVER` | `ElmerSolver`                                        |
| `SIMULATION_TIMEOUT_MS`  | 120000 per worker/conversion/solve; maximum 3600000  |

Generic host configuration example (environment may instead be inherited from
the Nix shell):

```json
{
  "command": "node",
  "args": ["/absolute/path/to/simulation/dist/src/index.js"],
  "env": {
    "SIMULATION_INPUT_ROOTS": "[\"/absolute/path/to/models\"]",
    "SIMULATION_WORKSPACE": "/absolute/path/to/run-workspace",
    "SIMULATION_PYTHON": "/absolute/path/to/provisioned/simulation-python",
    "SIMULATION_ELMERGRID": "/absolute/path/to/ElmerGrid",
    "SIMULATION_ELMERSOLVER": "/absolute/path/to/ElmerSolver"
  }
}
```

## Study tools

The public workflow is `get_capabilities` → `inspect_model` → `query_model` →
`validate_study` → `prepare_study` → `run_study` → `inspect_job` →
`query_results`. `list_jobs` recovers recent jobs after context loss and
`cancel_job` stops an active preparation or solver process.

`inspect_job` accepts `waitMs` (up to 60 s) and then waits in-process for a
terminal state instead of returning immediately, so
`prepare_study → inspect_job(waitMs) → run_study → inspect_job(waitMs) →
query_results` is normally five calls rather than dozens of polls. The state
is returned whether or not the window expires. A cancelled or timed-out
client request stops the mesh or the solve: `ctx.signal` is forwarded to the
job's abort path and the record ends `cancelled`. Preparation and
solver execution return job IDs immediately. Jobs survive client disconnects,
not server shutdown. Interrupted jobs are recorded and are not resumed.

`get_capabilities` reports the available physics and the study shape
(required and optional fields, notes, and a worked example); the machine-readable
`simulation://help` resource carries the full study schema — per-physics
material and boundary fields with units, regimes, observation quantities with
time/mode selectors, enums, and a parseable example. Both are generated from one
catalog so discovery cannot drift from the accepted study schema.

`steady-thermal`, `transient-thermal`, `static-structural`, `modal`,
`dc-conduction`, and `laminar-flow` are implemented and benchmarked. Other physics reported by
`get_capabilities` remain unavailable, not implied by the fact that Elmer has
upstream solvers for them.

Transient studies require explicit density and heat capacity per solid,
one uniform initial temperature, a positive timestep, and a step count capped
at 10,000. Fixed-temperature, insulated and inward-heat-flux boundaries are
supported; time-varying conditions and per-region initial
temperatures are not. Transient scalar and VTU results are validated at every
step. An observation may select a positive timestep-aligned time in seconds;
without `time`, it observes the final step. Acceptance thresholds remain in the
quantity's units (for example, K), not seconds.

Static structural studies require an explicit isotropic Young's modulus and
Poisson ratio for every solid, and an explicit fixed-displacement,
prescribed-displacement, uniform-traction, or free condition for every surface.
The supported model is static, linear-elastic, and small-strain; displacement
and stress summaries are unweighted nodal samples, not volume averages.

Modal studies require explicit density in addition to elastic properties,
fixed-displacement/free surface assignments, and request 1–20 modes. The first
modal implementation reports eigenfrequencies only; it does not expose mode
shapes, damping, prestress, or harmonic response. Modal observations select a
mode number and use Hz.

DC conduction studies require explicit positive isotropic electrical
conductivity per solid, explicit prescribed-potential or insulated conditions
on every surface, and at least two distinct prescribed potentials per
disconnected conductive component. Results report the nodal potential field;
current, Joule heating, magnetic effects, and transient/capacitive behavior are
not modeled.

Laminar-flow studies model incompressible Newtonian fluids with explicitly
assigned constant density and dynamic viscosity. Every fluid surface must be
explicitly assigned either a prescribed pressure or a no-slip wall; each
disconnected fluid region needs at least two distinct prescribed pressures.
Steady and transient runs are supported; transient runs use first-order BDF,
constant timestep, and an explicit quiescent initial velocity. The solver is
Elmer's monolithic `FlowSolve` module; qualification covers pressure-driven
square-duct flow and transient startup against the analytic rectangular-duct
solution, inlet/outlet flux conservation, and mesh/timestep refinement. Flux and
section averages are not exposed; reported velocity and pressure values are nodal
extrema. Elmer's segregated `IncompressibleNS` module is installed but not
qualified. Turbulence, compressibility, moving walls, nonzero initial velocity,
and thermal/electric coupling are not modeled.

Selections use dimension-qualified inspection entity IDs (for example `3:1`
for a volume or `2:7` for a surface), have unique names and cannot mix solids
and surfaces. Every inspected entity must be assigned exactly once. Each solid
selection needs one material; every surface selection defaults to insulated
in thermal studies unless explicitly overridden. Structural, modal, and DC
studies require explicit conditions on every surface. A thermal default is a
declared engineering assumption, not an inferred boundary condition. Linear
tetrahedra use SI units.

Example steady thermal study after inspecting the STEP file:

```json
{
  "schemaVersion": "1",
  "name": "Bar conduction",
  "objective": "Estimate the steady temperature and heat flux",
  "model": {
    "source": {
      "revision": "sha256:<64 lowercase hex digits>",
      "uri": "file:///.../source.step",
      "format": "step",
      "units": "mm"
    },
    "inspection": {
      "revision": "sha256:<64 lowercase hex digits>",
      "uri": "file:///.../inspection.json",
      "format": "json"
    }
  },
  "selections": [
    { "name": "bar", "entities": ["3:1"] },
    { "name": "hot_end", "entities": ["2:2"] },
    { "name": "cold_end", "entities": ["2:3"] },
    { "name": "other_faces", "entities": ["2:4", "2:5", "2:6", "2:7"] }
  ],
  "mesh": { "minSize": 0.003, "maxSize": 0.006, "elementOrder": 1 },
  "physics": {
    "kind": "steady-thermal",
    "defaultBoundary": "insulated",
    "materials": [
      {
        "selection": "bar",
        "conductivity": { "value": 10, "units": "W/(m.K)" }
      }
    ],
    "sources": [],
    "boundaries": [
      {
        "selection": "hot_end",
        "kind": "temperature",
        "temperature": { "value": 400, "units": "K" }
      },
      {
        "selection": "cold_end",
        "kind": "temperature",
        "temperature": { "value": 300, "units": "K" }
      }
    ]
  },
  "observations": [{ "id": "max_temperature", "quantity": "temperature_max" }],
  "acceptanceCriteria": [
    {
      "observationId": "max_temperature",
      "operator": "<",
      "threshold": { "value": 410, "units": "K" }
    }
  ],
  "assumptions": []
}
```

The example entity tags are illustrative; use tags from `query_model` and
confirm each selection against the actual part. `prepare_study` returns a
`jobId`; poll `inspect_job` until it succeeds, then pass its `prepared` artifact
to `run_study`, which returns another `jobId`. `query_results` reports solver
evidence separately from observation
values and criterion outcomes; a failed criterion is an engineering result, not
a solver error. Its response is bounded by default — summaries backing the
returned observations, de-duplicated field descriptors, and one page of artifact
refs (`limit`/`cursor`, `artifactCount`). Pass `include:["summaries"]` for the
full history, `time` to select one frame, or `observations` to filter. Scalar
means are nodal, not volume averages or integrated heat
rates. Arbitrary SIF, procedures, expressions, scripts and solver commands are
never study inputs.

Tool failures use MCP `isError`. Domain failures from the service return a JSON
`{ code, message }` object (with revisioned diagnostic log refs where available);
invalid tool arguments are rejected by the MCP layer before the handler runs and
are returned as plain text. The domain error codes are a closed, documented set
(listed under `enums.error_codes` in `simulation://help`): `invalid_input`,
`invalid_study`, `invalid_physics`, `invalid_selection`, `invalid_job_kind`,
`unsupported_condition`, `unsupported_physics`, `unsupported_format`,
`stale_artifact`, `path_policy`, `file_not_found`, `too_large`, `bad_mesh`,
`bad_groups`, `malformed_results`, `solver_failed`, `worker_failed`,
`conversion_failed`, `process_failed`, `spawn_error`, `output_limit`,
`persistence_failed`, `cancelled`, `timeout`, `interrupted`, `worker_protocol`,
and `internal_error`. Failed solves return inspectable run metadata rather than
disguising partial outputs as successful results.

Server diagnostics are written as newline-delimited JSON to stderr (stdout is the
MCP channel). Set `MCP_LOG_LEVEL` (`debug`|`info`|`warn`|`error`, default
`info`), `MCP_LOG_FORMAT=human` for a compact form, and
`MCP_TRACE_ID` to correlate events; secret-like fields are redacted.

## Boundaries, security and retention

- This is a trusted-local tool, not a filesystem sandbox. Input roots are
  canonicalized and used to catch accidental path mistakes; the server assumes
  the local user and files are trusted. Do not expose it to untrusted clients.
- Artifact revisions are SHA-256 digests of the exact bytes read or produced.
  Reusing a ref after its file changes fails explicitly, but concurrent edits
  during an operation are not defended against.
- Processes use configured executables and argument arrays, no shell. The local
  process environment is inherited for runtime compatibility, with deterministic
  locale/thread settings applied; child tools therefore also inherit local env vars.
- Per-process wall timeout, serial execution and 8 MiB combined captured-output
  bound are enforced. There is no portable memory, mesh-size, input-size or
  workspace-disk quota; provision OS quotas/cgroups if deployment needs them.
- V1 supports separate solid regions and exterior BC groups. Internal/orphan
  native boundaries fail; no contact resistance, automatic fragmentation,
  repairs, nonconformal coupling, radiation, plasticity, or geometric
  nonlinearity. Transient thermal supports only the explicit constant-property/
  time-step model above; structural support is isotropic, linear small-strain;
  modal support is undamped and unloaded.
- Selectors are tied to exact source revision, Gmsh version and
  `gmsh-occ-import-v1`. No Geometry SubjectRef-to-Gmsh topology equivalence is
  claimed. Imported names are hints, never engineering intent.
- No automatic deletion. Shut down the server, then explicitly archive/remove
  UUID operation directories when refs are no longer needed. `just clean`
  removes only compiled code. Interrupted records are not resumed. After an
  ungraceful termination inspect/reap any orphaned solver processes before
  restarting against that workspace. Graceful shutdown cancels owned runs.
- Hosted deployments need an external isolation boundary (e.g. a container or VM
  with explicit input mounts and resource limits); application path checks are
  not a substitute. These outputs are numerical evidence, not engineering certification.

## Implementation choices

- The Gmsh Python API owns STEP import, topology inventory, and mesh generation.
  It communicates with TypeScript through a bounded JSON-file worker protocol;
  no generated `.geo` script is required.
- Typed inputs generate deterministic SIF. PyElmer and model-authored SIF are
  unnecessary for supported workflows.
- ASCII MSH 2.2 transfers explicit physical groups to ElmerGrid; converted group
  membership and connectivity are verified instead of trusting labels alone.
- Upstream Elmer and Gmsh are external tools provisioned by Nix, not downloaded
  by npm at server startup. Non-Nix deployments can configure executable paths.
- Scalar summaries and VTU inventory are intentionally limited to the supported
  solver output. Geometry IDs are not cross-kernel mesh selectors.

## Artifact references

Every reference identifies one exact byte stream with `revision: "sha256:<64
lowercase hex digits>"` and a `format`. A URI is an optional locator; operations
requiring bytes need an accessible local `file:` URI. Supported format identifiers
are `step`, `gmsh-msh`, `elmer-mesh`, `vtu`, `elmer-sif`, `text`, and `json`.
Derived artifacts receive their own digests. An Elmer mesh directory is not a
single artifact: its metadata references individual native files.

## Development

Requires Node.js 24+ and [`just`](https://github.com/casey/just). A Nix flake and
`.envrc` provide the toolchain; run `direnv allow` after changing either.

| Recipe             | Purpose                                         |
| ------------------ | ----------------------------------------------- |
| `just setup`       | Install dependencies (npm scripts disabled).    |
| `just dev`         | Run the server over stdio.                      |
| `just start`       | Run the compiled server.                        |
| `just build`       | Compile into `dist/`.                           |
| `just test`        | Run solver-independent unit tests.              |
| `just test-integration` | Run the opt-in Gmsh/Elmer integration benchmark.|
| `just lint`        | Run oxlint.                                     |
| `just fmt`         | Rewrite formatting with Prettier.               |
| `just fmt-check`   | Verify formatting.                              |
| `just typecheck`   | Run `tsc --noEmit`.                             |
| `just check`       | `fmt-check` + `lint` + `typecheck` + `test`.    |
| `just fixture`     | Regenerate the analytic bar fixture.            |
| `just clean`       | Remove build output.                            |

Server logs go to stderr as newline-delimited pino JSON. `MCP_LOG_LEVEL`
(`debug`|`info`|`warn`|`error`), `MCP_LOG_FORMAT=human`, and `MCP_TRACE_ID` tune
them; secret-like fields are redacted.

The lightweight `checks` shell includes Node and Ruff without building the
Gmsh/Elmer solver toolchain:

```sh
# Run from this repository.
nix develop .#checks --accept-flake-config --command just setup
nix develop .#checks --accept-flake-config --command just check
nix develop --accept-flake-config --command just test-integration
nix develop --accept-flake-config --command just check
nix develop --accept-flake-config --command just build
```

`just test-integration` runs the opt-in direct-service Gmsh/Elmer benchmark. It is
server-owned integration coverage; public stdio acceptance runs separately
against the built server artifact.

In a source checkout, `tests/fixtures/README.md` documents analytic bar dimensions,
generation, and temperature/heat-flux tolerances. Unit checks do not require a
solver runtime. Native integration checks additionally cover malformed inputs,
solver failures, timeout/cancellation, restart persistence, and stale outputs.
Tests use the operating system's temporary directory;
`SIMULATION_TEST_TMP` can select another temporary root.

Licensing and upstream source references are recorded in
[third-party notices](THIRD_PARTY_NOTICES.md).

## Package preparation

`npm pack` builds first and includes compiled runtime code, the local artifact
schema, Python worker, README, and third-party notices. Tests, source maps, and
Python caches are excluded. Install the tarball to check `simulation-mcp-server`
with a compatible MCP client. The server serves both protocol eras: the
`2025-11-25` handshake that stock MCP hosts negotiate, and `2026-07-28`
through `server/discover`. Native tools still require separate installation.

`just check` includes solver-independent stdio protocol tests for modern
discovery, workflow resources, tool errors, and both protocol eras.

A project license must be selected and added before public release; third-party
notices do not license this server's own code.
