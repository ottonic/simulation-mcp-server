# External toolchain notices

The MCP does not embed or download Gmsh/Elmer at runtime and does not use PyElmer.
The Nix environment provisions these independently licensed tools:

- Gmsh: https://gmsh.info/ — GPL-2.0-or-later with upstream exceptions/options;
  consult the pinned Nix package metadata and upstream `LICENSE.txt` for the
  exact distribution terms. OpenCASCADE is used by Gmsh for STEP import.
- Elmer FEM: https://github.com/ElmerCSC/elmerfem — component-specific GPL/LGPL
  licensing. The solver library uses LGPL terms; ElmerGrid and other components
  carry their own notices. Preserve upstream `license_texts` when redistributing
  the toolchain. Pinned source: `61a3d3d9b971923555bb56a800ebec8df9482acd`.
- MCP TypeScript SDK: Apache-2.0; Zod: MIT; unitsnet-js: MIT; Node.js and Python
  retain their upstream distribution notices.

Upstream sources consulted for implemented protocol/keywords:

- `elmergrid/src/egconvert.c`: MSH2 physical tags and node connectivity.
- `elmergrid/src/egnative.c`: format 14→2 and `-out` arguments.
- `fem/tests/fluxsolver/flux.sif`: HeatSolve/FluxSolver procedure configuration.
- `fem/src/modules/HeatSolve.F90`: volumetric heat source and flux keywords.
- `fem/src/modules/SaveData/SaveScalars.F90`: named scalar columns and convergence.
- `fem/src/modules/ResultOutputSolve/VtuOutputSolver.F90`: ASCII VTU output.

See the README for runtime setup and validation commands.
