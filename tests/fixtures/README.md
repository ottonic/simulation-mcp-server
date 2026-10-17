# Analytic bar (MIT)

> Intentionally duplicated: gym owns its fixtures independently and must not
> import server fixtures, so this README and the gym benchmark copy are kept in
> sync by hand.

`bar.step` is an independently specified, axis-aligned OCC solid, not a mesh.
`generate_bar.py` regenerates it with the Gmsh Python API and declares the
coordinates' millimeter unit (Gmsh's STEP writer omits unit metadata). Both
files are MIT-licensed original fixture sources.

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
