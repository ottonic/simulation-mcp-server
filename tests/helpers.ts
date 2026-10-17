import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Simulation, type ServiceOptions, type Settings } from '../src/service.js';
import type { Inventory, Group, Thermal } from '../src/schemas.js';

export const fixture = fileURLToPath(new URL('./fixtures/bar.step', import.meta.url));
export async function temporary() {
  const root = process.env.SIMULATION_TEST_TMP ?? tmpdir();
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, 'simulation-test-'));
}
export async function service(overrides: Partial<Settings> = {}, options: ServiceOptions = {}) {
  return Simulation.create(
    {
      workspace: await temporary(),
      roots: [fileURLToPath(new URL('./fixtures/', import.meta.url))],
      python:
        process.env.SIMULATION_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
      elmerGrid: process.env.SIMULATION_ELMERGRID ?? 'ElmerGrid',
      elmerSolver: process.env.SIMULATION_ELMERSOLVER ?? 'ElmerSolver',
      timeoutMs: 120000,
      ...overrides,
    },
    options,
  );
}
// Benchmark-specific engineering selections: the production service never
// guesses these. The test explicitly checks geometry before using the policy.
export function barSelections(inventory: Inventory) {
  const volumes = inventory.entities.filter((e) => e.dimension === 3);
  const surfaces = inventory.entities.filter((e) => e.dimension === 2);
  const volume = volumes[0];
  if (volume === undefined || volumes.length !== 1 || surfaces.length !== 6)
    throw new Error('Expected six-sided benchmark bar');
  const groups: Group[] = [{ id: 1, name: 'bar', dimension: 3, entities: [volume.tag] }];
  const boundaries: Extract<Thermal, { physics: 'steady-heat-conduction' }>['boundaries'] = [];
  surfaces.forEach((surface, i) => {
    const group = i + 2;
    groups.push({
      id: group,
      name: `surface_${i}`,
      dimension: 2,
      entities: [surface.tag],
    });
    if (Math.abs(surface.center[0]) < 1e-8)
      boundaries.push({
        group,
        kind: 'temperature',
        temperature: { value: 400, units: 'K' },
      });
    else if (Math.abs(surface.center[0] - 0.1) < 1e-8)
      boundaries.push({
        group,
        kind: 'temperature',
        temperature: { value: 300, units: 'K' },
      });
    else boundaries.push({ group, kind: 'insulated' });
  });
  if (boundaries.filter((b) => b.kind === 'temperature').length !== 2)
    throw new Error('Bar end locations do not match SI benchmark');
  return {
    groups,
    config: {
      physics: 'steady-heat-conduction',
      materials: [{ group: 1, conductivity: { value: 10, units: 'W/(m.K)' } }],
      sources: [],
      boundaries,
    } satisfies Thermal,
  };
}
export const controls = { minSize: 0.003, maxSize: 0.006, units: 'm' as const };
// The two axial end faces of the benchmark bar, identified by position rather
// than by sentinel boundary values, so tests do not depend on the thermal
// benchmark's 400/300 K choices.
export function barEnds(inventory: Inventory) {
  const selected = barSelections(inventory);
  const faceAt = (x: number) =>
    inventory.entities.find(
      (entity) => entity.dimension === 2 && Math.abs(entity.center[0] - x) < 1e-8,
    );
  const groupAt = (x: number) =>
    selected.groups.find(
      (group) => group.dimension === 2 && group.entities.includes(faceAt(x)?.tag ?? -1),
    );
  const start = groupAt(0);
  const end = groupAt(0.1);
  if (!start || !end) throw new Error('Expected bar end faces at x=0 and x=0.1 m');
  return { start: start.name, end: end.name };
}
export async function waitForRun(simulation: Simulation, runId: string) {
  for (let i = 0; i < 600; i++) {
    const run = await simulation.status(runId);
    if (!['preparing', 'running'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Run did not terminate');
}
export async function waitForJob(simulation: Simulation, jobId: string) {
  for (let i = 0; i < 600; i++) {
    const job = await simulation.inspectJob(jobId);
    if (!['preparing', 'running'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Job did not terminate');
}
