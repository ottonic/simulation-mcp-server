# Analytic bar (MIT)

**Nothing here is committed.** `generate_bar.py` writes both fixtures with the Gmsh Python API,
through `just fixture` — and `just test-integration` runs that first. A stored STEP file cannot
be reviewed in a diff, and nothing would regenerate it.

| File            | Geometry      | Declared unit                                                                                                          |
| --------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `bar.step`      | 100 × 10 × 10 | mm — the thermal benchmark below.                                                                                      |
| `bar-inch.step` | 4 × 0.5 × 0.5 | in — a separate specification, not the same shape relabelled: 0.1016 m long and 1 in³, which is what its test asserts. |

Both are independently specified, axis-aligned OCC solids, not meshes, and MIT-licensed original
fixture sources. The generator declares each file's length unit, because Gmsh's STEP writer omits
unit metadata.

The gym's thermal scenario owns its own generated fixture
(`gym/scenarios/steady-thermal-slab-v1/fixtures/generate_slab.py`) and must not import these.

- World frame: right handed; length 100 mm along X, width/height 10 mm.
- Conductivity: 10 W/(m.K); no source.
- X=0: 400 K; X=0.1 m: 300 K; four side faces insulated.
- Analytic solution: T(x)=400−1000x K for x in meters.
- Flux: (10000,0,0) W/m²; end area 0.0001 m²; heat rate 1 W.
- Linear tetrahedra should reproduce linear T; integration acceptance uses
  0.1 K temperature and 1% flux/derived heat-rate tolerances; real Elmer
  integration now verifies the benchmark against these tolerances.

The analytic thermal benchmark is self-contained in this server's test tree.
The direct-service benchmark runs only through the explicit `just test-integration`
recipe; the server's unit/security/process suite does not require solver tools.
