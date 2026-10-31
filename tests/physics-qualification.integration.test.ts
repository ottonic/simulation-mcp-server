import { expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { barSelections, fixture, service, waitForJob, waitForRun } from './helpers.js';
import { parseVtu, pointField } from '../src/results.js';

const L = 0.1;
const E = 210e9;
const NU = 0.3;
const RHO = 7800;
const CONDUCTIVITY = 10;
const FLUX = 1000; // W/m2 inward at x = 0
const TRACTION = 1e6; // Pa along +x at x = L
const VOLTAGE = 10; // V at x = 0
const CANTILEVER_HZ = 838; // Euler-Bernoulli first bending mode

const MESHES = [
  { label: 'coarse', minSize: 0.002, maxSize: 0.004 },
  { label: 'fine', minSize: 0.001, maxSize: 0.002 },
];

type Inspected = Awaited<ReturnType<Awaited<ReturnType<typeof service>>['inspect']>>;

function barFaces(inspected: Inspected) {
  const selected = barSelections(inspected.inventory);
  const faceAt = (x: number) =>
    inspected.inventory.entities.find(
      (entity) => entity.dimension === 2 && Math.abs(entity.center[0] - x) < 1e-8,
    );
  const groupAt = (x: number) =>
    selected.groups.find(
      (group) => group.dimension === 2 && group.entities.includes(faceAt(x)?.tag ?? -1),
    );
  const volume = selected.groups.find((group) => group.dimension === 3);
  const start = groupAt(0);
  const end = groupAt(L);
  const walls = selected.groups.filter(
    (group) => group.dimension === 2 && group !== start && group !== end,
  );
  if (!volume || !start || !end || walls.length !== 4)
    throw new Error('Expected the six-sided benchmark bar');
  return { selected, volume, start, end, walls };
}

function buildStudy(
  inspected: Inspected,
  selected: ReturnType<typeof barSelections>,
  mesh: { minSize: number; maxSize: number },
  physics: Record<string, unknown>,
) {
  return {
    schemaVersion: '1',
    name: 'physics qualification',
    objective: 'Qualify a production study against an analytic bar solution.',
    model: { source: inspected.source, inspection: inspected.inspection },
    selections: selected.groups.map((group) => ({
      name: group.name,
      entities: group.entities.map((tag) => `${group.dimension}:${tag}`),
    })),
    mesh: { minSize: mesh.minSize, maxSize: mesh.maxSize, elementOrder: 1 },
    physics,
    observations: [],
    acceptanceCriteria: [],
    assumptions: [],
  };
}

async function solve(
  sim: Awaited<ReturnType<typeof service>>,
  study: ReturnType<typeof buildStudy>,
) {
  const queued = await sim.prepareStudy(study);
  const prepared = await waitForJob(sim, queued.jobId);
  if (prepared.status !== 'succeeded')
    throw new Error(`Preparation failed: ${JSON.stringify(prepared.error)}`);
  const started = await sim.runStudy(prepared.prepared!);
  const run = await waitForRun(sim, started.runId);
  if (run.status !== 'succeeded') throw new Error(`Solve failed: ${JSON.stringify(run.error)}`);
  return run;
}

async function vtuOf(
  sim: Awaited<ReturnType<typeof service>>,
  run: Awaited<ReturnType<typeof solve>>,
) {
  return parseVtu((await sim.artifacts.verify(run.results[0]!.artifact)).toString());
}

// Interior axial samples, away from the ends.
function interiorIndexes(vtu: ReturnType<typeof parseVtu>) {
  const indexes: number[] = [];
  for (let i = 0; i < vtu.pointCount; i++) {
    const x = vtu.points[3 * i]!;
    if (x > 0.02 && x < 0.08) indexes.push(i);
  }
  return indexes;
}

// Least-squares fit of y(x) over the interior samples: returns slope, intercept,
// and the maximum absolute residual (a linearity measure).
function linearFit(vtu: ReturnType<typeof parseVtu>, values: number[]) {
  const indexes = interiorIndexes(vtu);
  const n = indexes.length;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (const i of indexes) {
    const x = vtu.points[3 * i]!;
    const y = values[i]!;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  let maxResidual = 0;
  for (const i of indexes) {
    const residual = Math.abs(values[i]! - (intercept + slope * vtu.points[3 * i]!));
    if (residual > maxResidual) maxResidual = residual;
  }
  return { slope, maxResidual, samples: n };
}

it('qualifies steady thermal flux against the bar solution with mesh refinement', async () => {
  const sim = await service();
  try {
    const inspected = await sim.inspect({ uri: pathToFileURL(fixture).href });
    const { selected, volume, start, end, walls } = barFaces(inspected);
    const results: { label: string; slope: number; residual: number }[] = [];
    for (const mesh of MESHES) {
      const run = await solve(
        sim,
        buildStudy(inspected, selected, mesh, {
          kind: 'steady-thermal',
          defaultBoundary: 'insulated',
          materials: [
            {
              selection: volume.name,
              conductivity: { value: CONDUCTIVITY, units: 'W/(m.K)' },
            },
          ],
          sources: [],
          boundaries: [
            {
              selection: start.name,
              kind: 'inward-heat-flux',
              flux: { value: FLUX, units: 'W/m2' },
            },
            {
              selection: end.name,
              kind: 'temperature',
              temperature: { value: 0, units: 'K' },
            },
            ...walls.map((wall) => ({
              selection: wall.name,
              kind: 'insulated',
            })),
          ],
        }),
      );
      const vtu = await vtuOf(sim, run);
      const temperature = pointField(vtu, 'temperature').values;
      const { slope, maxResidual } = linearFit(vtu, temperature);
      results.push({ label: mesh.label, slope, residual: maxResidual });
    }
    console.info(`Thermal flux qualification: ${JSON.stringify(results)}`);
    for (const result of results) {
      // The axial temperature gradient equals the applied flux over conductivity.
      expect(Math.abs(Math.abs(result.slope) - FLUX / CONDUCTIVITY)).toBeLessThan(
        (FLUX / CONDUCTIVITY) * 0.03,
      );
      expect(result.residual).toBeLessThan(0.05);
    }
    expect(results[1]!.residual).toBeLessThanOrEqual(results[0]!.residual + 1e-6);
  } finally {
    await sim.close();
  }
}, 180_000);

it('qualifies uniform traction against the bar solution with mesh refinement', async () => {
  const sim = await service();
  try {
    const inspected = await sim.inspect({ uri: pathToFileURL(fixture).href });
    const { selected, volume, start, end, walls } = barFaces(inspected);
    const results: {
      label: string;
      stressMean: number;
      displacement: number;
    }[] = [];
    for (const mesh of MESHES) {
      const run = await solve(
        sim,
        buildStudy(inspected, selected, mesh, {
          kind: 'static-structural',
          materials: [
            {
              selection: volume.name,
              youngsModulus: { value: E, units: 'Pa' },
              poissonRatio: NU,
            },
          ],
          boundaries: [
            { selection: start.name, kind: 'fixed-displacement' },
            {
              selection: end.name,
              kind: 'uniform-traction',
              traction: [
                { value: TRACTION, units: 'N/m2' },
                { value: 0, units: 'N/m2' },
                { value: 0, units: 'N/m2' },
              ],
            },
            ...walls.map((wall) => ({ selection: wall.name, kind: 'free' })),
          ],
        }),
      );
      const vtu = await vtuOf(sim, run);
      const stress = pointField(vtu, 'stress_xx').values;
      const indexes = interiorIndexes(vtu);
      const stressMean = indexes.reduce((sum, i) => sum + stress[i]!, 0) / indexes.length;
      const displacement = pointField(vtu, 'displacement').values;
      let maxDisplacement = 0;
      for (let i = 0; i < vtu.pointCount; i++) {
        maxDisplacement = Math.max(
          maxDisplacement,
          Math.hypot(displacement[3 * i]!, displacement[3 * i + 1]!, displacement[3 * i + 2]!),
        );
      }
      results.push({
        label: mesh.label,
        stressMean,
        displacement: maxDisplacement,
      });
    }
    console.info(`Traction qualification: ${JSON.stringify(results)}`);
    const expectedDisplacement = (TRACTION * L) / E;
    for (const result of results) {
      expect(Math.abs(result.stressMean - TRACTION)).toBeLessThan(TRACTION * 0.02);
      expect(Math.abs(result.displacement - expectedDisplacement)).toBeLessThan(
        expectedDisplacement * 0.05,
      );
    }
    expect(Math.abs(results[1]!.stressMean - TRACTION)).toBeLessThanOrEqual(
      Math.abs(results[0]!.stressMean - TRACTION) + 1e-6,
    );
  } finally {
    await sim.close();
  }
}, 180_000);

it('qualifies DC conduction against the bar solution with mesh refinement', async () => {
  const sim = await service();
  try {
    const inspected = await sim.inspect({ uri: pathToFileURL(fixture).href });
    const { selected, volume, start, end, walls } = barFaces(inspected);
    const results: { label: string; slope: number; residual: number }[] = [];
    for (const mesh of MESHES) {
      const run = await solve(
        sim,
        buildStudy(inspected, selected, mesh, {
          kind: 'dc-conduction',
          materials: [
            {
              selection: volume.name,
              electricalConductivity: { value: 1e6, units: 'S/m' },
            },
          ],
          boundaries: [
            {
              selection: start.name,
              kind: 'potential',
              potential: { value: VOLTAGE, units: 'V' },
            },
            {
              selection: end.name,
              kind: 'potential',
              potential: { value: 0, units: 'V' },
            },
            ...walls.map((wall) => ({
              selection: wall.name,
              kind: 'insulated',
            })),
          ],
        }),
      );
      const vtu = await vtuOf(sim, run);
      const potential = pointField(vtu, 'potential').values;
      const { slope, maxResidual } = linearFit(vtu, potential);
      results.push({ label: mesh.label, slope, residual: maxResidual });
    }
    console.info(`DC qualification: ${JSON.stringify(results)}`);
    for (const result of results) {
      expect(Math.abs(Math.abs(result.slope) - VOLTAGE / L)).toBeLessThan((VOLTAGE / L) * 0.01);
      expect(result.residual).toBeLessThan(0.02);
    }
    // Refinement must leave the linear fit at solver round-off. A strict
    // `fine <= coarse` comparison cannot express that here: the residual is ~1e-7 V
    // against a 10 V drop, so which mesh looks more linear is decided by
    // platform-specific round-off rather than by the discretization — one runner
    // resolves the coarse mesh exactly (~1e-18) while another leaves it at ~1e-7,
    // and an absolute epsilon of 1e-9 separates neither case from noise. Assert the
    // scale that is physically meaningful instead of the ordering.
    expect(results[1]!.residual).toBeLessThan(1e-6);
  } finally {
    await sim.close();
  }
}, 180_000);

it('qualifies the modal cantilever against Euler-Bernoulli with mesh refinement', async () => {
  const sim = await service();
  try {
    const inspected = await sim.inspect({ uri: pathToFileURL(fixture).href });
    const { selected, volume, start, end, walls } = barFaces(inspected);
    const results: { label: string; frequency: number; error: number }[] = [];
    // Modal solves are the most expensive; use a smaller pair of meshes and
    // fewer modes while still demonstrating convergence.
    const modalMeshes = [
      { label: 'coarse', minSize: 0.003, maxSize: 0.005 },
      { label: 'fine', minSize: 0.0018, maxSize: 0.003 },
    ];
    for (const mesh of modalMeshes) {
      const run = await solve(
        sim,
        buildStudy(inspected, selected, mesh, {
          kind: 'modal',
          materials: [
            {
              selection: volume.name,
              youngsModulus: { value: E, units: 'Pa' },
              poissonRatio: NU,
              density: { value: RHO, units: 'kg/m3' },
            },
          ],
          boundaries: [
            { selection: start.name, kind: 'fixed-displacement' },
            { selection: end.name, kind: 'free' },
            ...walls.map((wall) => ({ selection: wall.name, kind: 'free' })),
          ],
          modes: 3,
        }),
      );
      const frequency = run.summaries.find(
        (summary) => summary.name === 'eigenfrequency_mode_1',
      )!.value;
      results.push({
        label: mesh.label,
        frequency,
        error: Math.abs(frequency - CANTILEVER_HZ) / CANTILEVER_HZ,
      });
    }
    console.info(`Modal qualification: ${JSON.stringify(results)}`);
    expect(results[0]!.error).toBeLessThan(0.35);
    expect(results[1]!.error).toBeLessThan(0.12);
    expect(results[1]!.error).toBeLessThanOrEqual(results[0]!.error + 1e-9);
  } finally {
    await sim.close();
  }
}, 180_000);
