import { expect, it } from 'vitest';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  service,
  fixture,
  barSelections,
  barEnds,
  controls,
  waitForRun,
  waitForJob,
  temporary,
} from './helpers.js';
import { Simulation } from '../src/service.js';
import { meshSchema, preparedStudySchema } from '../src/schemas.js';
import { runProcess, type ProcessResult } from '../src/process.js';

/** Element `index` or a clear failure — keeps assertions free of `!`. */
function at<T>(items: readonly T[], index: number): T {
  const found = items[index];
  if (found === undefined) throw new Error(`missing item ${index}`);
  return found;
}

/** Capture group `group` (default 1) of the first `pattern` match in `text`. */
function capture(text: string, pattern: RegExp, group = 1): string {
  const match = text.match(pattern);
  if (!match) throw new Error(`pattern not found: ${String(pattern)}`);
  return at(match, group);
}

it('completes STEP → explicit groups → native mesh → SIF → Elmer → analytic thermal results', async () => {
  let solverBehavior: 'real' | 'missing' | 'no-output' | 'failed' | 'timeout' | 'cancelled' =
    'real';
  const solverRunner = async (
    executable: string,
    args: string[],
    cwd: string,
    prefix: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProcessResult> => {
    if (solverBehavior === 'real')
      return runProcess(executable, args, cwd, prefix, timeoutMs, signal);
    await writeFile(join(cwd, `${prefix}.stdout`), '');
    await writeFile(join(cwd, `${prefix}.stderr`), '');
    const startedAt = new Date().toISOString();
    const result = (status: ProcessResult['status'], exitCode: number | null): ProcessResult => ({
      status,
      exitCode,
      signal: null,
      startedAt,
      endedAt: new Date().toISOString(),
      stdout: '',
      stderr: '',
    });
    if (solverBehavior === 'missing') return result('spawn_error', null);
    if (solverBehavior === 'no-output') return result('exited', 0);
    if (solverBehavior === 'failed')
      return { ...result('exited', 9), stderr: 'ERROR: forced failure' };
    if (solverBehavior === 'timeout') return result('timeout', null);
    if (solverBehavior === 'cancelled') {
      if (signal?.aborted) return result('cancelled', null);
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      return result('cancelled', null);
    }
    throw new Error('Unexpected solver behavior');
  };
  const simulation = await service({}, { solverRunner });
  try {
    const inspected = await simulation.inspect({
      uri: pathToFileURL(fixture).href,
    });
    expect(inspected.inventory.sourceUnits).toBe('mm');
    expect(inspected.inventory.scaleToMeters).toBe(0.001);
    const volume = inspected.inventory.entities.find((e) => e.dimension === 3)!;
    expect(volume.measure).toBeCloseTo(0.00001, 10);
    expect(volume.bounds[3] - volume.bounds[0]).toBeCloseTo(0.1, 5);
    const selected = barSelections(inspected.inventory);
    const groupName = new Map(selected.groups.map((group) => [group.id, group.name]));
    const study = {
      schemaVersion: '1',
      name: 'Analytic bar conduction',
      objective: 'Verify steady heat conduction against the analytic bar benchmark.',
      model: { source: inspected.source, inspection: inspected.inspection },
      selections: selected.groups.map((group) => ({
        name: group.name,
        entities: group.entities.map((tag) => `${group.dimension}:${tag}`),
      })),
      mesh: {
        minSize: controls.minSize,
        maxSize: controls.maxSize,
        elementOrder: 1,
      },
      physics: {
        kind: 'steady-thermal',
        defaultBoundary: 'insulated',
        materials: selected.config.materials.map((material) => ({
          selection: groupName.get(material.group)!,
          conductivity: material.conductivity,
        })),
        sources: [],
        boundaries: selected.config.boundaries
          .filter(
            (boundary): boundary is Exclude<typeof boundary, { kind: 'insulated' }> =>
              boundary.kind !== 'insulated',
          )
          .map((boundary) =>
            boundary.kind === 'temperature'
              ? {
                  selection: groupName.get(boundary.group)!,
                  kind: boundary.kind,
                  temperature: boundary.temperature,
                }
              : {
                  selection: groupName.get(boundary.group)!,
                  kind: 'inward-heat-flux' as const,
                  flux: boundary.inwardFlux,
                },
          ),
      },
      observations: [{ id: 'max_temperature', quantity: 'temperature_max' }],
      acceptanceCriteria: [
        {
          observationId: 'max_temperature',
          operator: '<',
          threshold: { value: 401, units: 'K' },
        },
      ],
      assumptions: [],
    };
    const validation = await simulation.validateStudy(study);
    expect(validation.valid, JSON.stringify(validation.issues)).toBe(true);
    const preparing = await simulation.prepareStudy(study);
    expect(preparing.kind).toBe('prepare');
    expect(preparing.status).toBe('preparing');
    const preparation = await waitForJob(simulation, preparing.jobId);
    expect(preparation.status).toBe('succeeded');
    await expect(simulation.queryResults(preparing.jobId)).rejects.toMatchObject({
      code: 'invalid_job_kind',
    });
    if (!preparation.prepared) throw new Error('Preparation did not return a prepared study.');
    const prepared = await simulation.artifacts.json(preparation.prepared, preparedStudySchema);
    const mesh = await simulation.artifacts.json(prepared.mesh, meshSchema);
    expect(mesh.groups.every((group) => group.elements > 0)).toBe(true);
    expect(mesh.elementCount).toBeGreaterThan(0);
    expect(mesh.minimumQuality).toBeGreaterThan(0);
    expect(
      Object.values(mesh.files).every(
        (file) => file.format === 'elmer-mesh' && !file.uri?.endsWith('/mesh'),
      ),
    ).toBe(true);
    const started = await simulation.runStudy(preparation.prepared);
    const run = await waitForRun(simulation, started.runId);
    const evidence =
      run.status === 'succeeded'
        ? []
        : await Promise.all(
            [...run.logs, ...run.outputs.filter((output) => output.format === 'text')].map(
              async (ref) =>
                `${ref.uri?.split('/').at(-1)}:\n${(await simulation.artifacts.verify(ref)).toString('utf8')}`,
            ),
          );
    expect(run.status, `${JSON.stringify(run)}\n${evidence.join('\n')}`).toBe('succeeded');
    expect((await simulation.queryResults(run.runId)).acceptance).toMatchObject([
      { observationId: 'max_temperature', status: 'pass', units: 'K' },
    ]);
    expect((await simulation.listJobs()).jobs.map((job) => job.kind)).toContain('prepare');
    expect(run.solver.version).toMatch(/Elmer|version/i);
    const scalar = (name: string) => run.summaries.find((s) => s.name === name)!.value;
    expect(Math.abs(scalar('temperature_min') - 300)).toBeLessThan(0.1);
    expect(Math.abs(scalar('temperature_max') - 400)).toBeLessThan(0.1);
    expect(Math.abs(scalar('heat_flux_magnitude_mean') - 10000) / 10000).toBeLessThan(0.01);
    // Independent benchmark geometry gives A=1e-4 m²; this derivation is
    // benchmark-only, never advertised as a generic integrated heat flow.
    expect(Math.abs(scalar('heat_flux_magnitude_mean') * 0.0001 - 1)).toBeLessThan(0.01);
    const vtu = (await simulation.artifacts.verify(at(run.results, 0).artifact)).toString();
    const positions = capture(vtu, /<Points>\s*<DataArray[^>]*>([\s\S]*?)<\/DataArray>/)
      .trim()
      .split(/\s+/)
      .map(Number);
    const temperatures = capture(
      vtu,
      /<DataArray[^>]*Name="temperature"[^>]*>([\s\S]*?)<\/DataArray>/i,
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    expect(positions.length).toBe(3 * temperatures.length);
    temperatures.forEach((t, i) =>
      expect(Math.abs(t - (400 - 1000 * at(positions, 3 * i)))).toBeLessThan(0.1),
    );
    const restarted = await Simulation.create(simulation.settings);
    expect((await restarted.status(run.runId)).status).toBe('succeeded');
    await writeFile(
      join(simulation.artifacts.workspace, preparing.jobId, 'prep-status.json'),
      JSON.stringify(preparing),
    );
    expect((await restarted.inspectJob(preparing.jobId)).status).toBe('interrupted');

    const cancelPreparation = await simulation.prepareStudy(study);
    const cancelledPreparation = await simulation.cancelJob(cancelPreparation.jobId);
    expect(cancelledPreparation.kind).toBe('prepare');
    expect(cancelledPreparation.status).toBe('cancelled');

    solverBehavior = 'missing';
    const missing = await waitForRun(simulation, (await simulation.start(prepared.case)).runId);
    expect(missing.status).toBe('failed');
    expect(missing.error?.code).toBe('spawn_error');
    expect(missing.logs).toHaveLength(2);
    expect((await simulation.status(run.runId)).status).toBe('succeeded');

    solverBehavior = 'no-output';
    const noOutput = await waitForRun(simulation, (await simulation.start(prepared.case)).runId);
    expect(noOutput.status).toBe('failed');
    expect(noOutput.error?.code).toBe('malformed_results');
    solverBehavior = 'failed';
    const solverError = await waitForRun(simulation, (await simulation.start(prepared.case)).runId);
    expect(solverError.execution?.exitCode).toBe(9);
    expect(solverError.status).toBe('failed');
    solverBehavior = 'timeout';
    simulation.settings.timeoutMs = 50;
    const timedOut = await waitForRun(simulation, (await simulation.start(prepared.case)).runId);
    expect(timedOut.status).toBe('timeout');
    simulation.settings.timeoutMs = 120000;
    solverBehavior = 'cancelled';
    const cancelled = await simulation.start(prepared.case);
    expect((await simulation.cancel(cancelled.runId)).status).toBe('cancelled');

    // Exact-byte result revision verification applies after server restarts.
    const resultPath = fileURLToPath(at(run.results, 0).artifact.uri!);
    await chmod(resultPath, 0o600);
    await writeFile(resultPath, (await readFile(resultPath, 'utf8')) + '\n');
    await expect(restarted.status(run.runId)).rejects.toMatchObject({
      code: 'stale_artifact',
    });
  } finally {
    await simulation.close();
  }
}, 240000);

it('imports an inch STEP and normalizes it to SI metres', async () => {
  const simulation = await service();
  try {
    const inch = fileURLToPath(new URL('./fixtures/bar-inch.step', import.meta.url));
    const inspected = await simulation.inspect({ uri: pathToFileURL(inch).href });
    expect(inspected.inventory.sourceUnits).toBe('in');
    expect(inspected.inventory.scaleToMeters).toBe(0.0254);
    const volume = inspected.inventory.entities.find((e) => e.dimension === 3)!;
    // 4 x 0.5 x 0.5 in = 1 in^3 = 1.6387064e-5 m^3
    expect(volume.measure).toBeCloseTo(1.6387064e-5, 12);
    expect(volume.bounds[3] - volume.bounds[0]).toBeCloseTo(0.1016, 6);
  } finally {
    await simulation.close();
  }
}, 120000);

it('runs the pinned HeatSolve transient benchmark with volumetric heating', async () => {
  const simulation = await service();
  try {
    const inspected = await simulation.inspect({
      uri: pathToFileURL(fixture).href,
    });
    const selected = barSelections(inspected.inventory);
    const meshed = await simulation.mesh(
      inspected.source,
      inspected.inspection,
      controls,
      selected.groups,
    );
    const work = await simulation.artifacts.directory();
    const meshDir = join(work, 'mesh');
    await mkdir(meshDir, { recursive: true });
    await Promise.all(
      Object.entries(meshed.metadata.files).map(async ([name, ref]) => {
        await writeFile(join(meshDir, name), await simulation.artifacts.verify(ref));
      }),
    );
    await writeFile(
      join(work, 'case.sif'),
      `Header
  CHECK KEYWORDS Warn
  Mesh DB "." "mesh"
  Results Directory ""
End

Simulation
  Coordinate System = Cartesian 3D
  Simulation Type = Transient
  Timestep Intervals = 10
  Timestep Sizes = 1.0
  Output Intervals = 1
End

Equation 1
  Active Solvers(1) = 1
End

Solver 1
  Equation = Heat Equation
  Procedure = "HeatSolve" "HeatSolver"
  Variable = Temperature
  Variable Dofs = 1
  Linear System Solver = Iterative
  Linear System Iterative Method = CG
  Linear System Preconditioning = ILU0
  Linear System Max Iterations = 2000
  Linear System Convergence Tolerance = 1.0e-10
  Linear System Abort Not Converged = True
  Nonlinear System Max Iterations = 3
  Nonlinear System Convergence Tolerance = 1.0e-9
End

Body 1
  Target Bodies(1) = 1
  Equation = 1
  Material = 1
  Body Force = 1
  Initial Condition = 1
End

Material 1
  Heat Conductivity = 10
  Density = 1000
  Heat Capacity = 1000
End

Body Force 1
  Volumetric Heat Source = 100000
End

Initial Condition 1
  Temperature = 300
End

Solver 2
  Exec Solver = After Timestep
  Equation = SaveScalars
  Procedure = "SaveData" "SaveScalars"
  Filename = "scalars.dat"
  Variable 1 = String Temperature
  Operator 1 = String mean
End

Boundary Condition 1
  Target Boundaries(1) = 2
  Heat Flux = 0
End

Boundary Condition 2
  Target Boundaries(1) = 3
  Heat Flux = 0
End

Boundary Condition 3
  Target Boundaries(1) = 4
  Heat Flux = 0
End

Boundary Condition 4
  Target Boundaries(1) = 5
  Heat Flux = 0
End

Boundary Condition 5
  Target Boundaries(1) = 6
  Heat Flux = 0
End

Boundary Condition 6
  Target Boundaries(1) = 7
  Heat Flux = 0
End
`,
    );
    const result = await runProcess(
      simulation.settings.elmerSolver,
      ['case.sif'],
      work,
      'transient',
      simulation.settings.timeoutMs,
    );
    const logs = await Promise.all(
      ['transient.stdout', 'transient.stderr'].map(async (name) =>
        (await readFile(join(work, name), 'utf8')).slice(-12000),
      ),
    );
    expect(result.status, logs.join('\n')).toBe('exited');
    expect(result.exitCode, logs.join('\n')).toBe(0);
    const scalarText = await readFile(join(work, 'scalars.dat'), 'utf8');
    const rows = scalarText
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.trim().startsWith('#'));
    expect(rows.length, scalarText).toBe(10);
    const final = rows.at(-1)!.trim().split(/\s+/).map(Number);
    expect(final.every(Number.isFinite)).toBe(true);
    expect(final.at(-1)).toBeCloseTo(301, 3);
  } finally {
    await simulation.close();
  }
}, 240000);

it('prepares, runs, and queries a time-indexed transient thermal study', async () => {
  const simulation = await service();
  try {
    const inspected = await simulation.inspect({
      uri: pathToFileURL(fixture).href,
    });
    const selected = barSelections(inspected.inventory);
    const groupNames = new Map(selected.groups.map((group) => [group.id, group.name]));
    const study = {
      schemaVersion: '1',
      name: 'Transient uniform heating benchmark',
      objective: 'Verify transient heat capacity and time-indexed observations.',
      model: { source: inspected.source, inspection: inspected.inspection },
      selections: selected.groups.map((group) => ({
        name: group.name,
        entities: group.entities.map((tag) => `${group.dimension}:${tag}`),
      })),
      mesh: {
        minSize: controls.minSize,
        maxSize: controls.maxSize,
        elementOrder: 1,
      },
      physics: {
        kind: 'transient-thermal',
        defaultBoundary: 'insulated',
        materials: [
          {
            selection: groupNames.get(1)!,
            conductivity: { value: 10, units: 'W/(m.K)' },
            density: { value: 1000, units: 'kg/m3' },
            heatCapacity: { value: 1000, units: 'J/(kg.K)' },
          },
        ],
        sources: [],
        boundaries: selected.config.boundaries.map((boundary) => {
          const selection = groupNames.get(boundary.group)!;
          if (boundary.kind === 'temperature')
            return {
              selection,
              kind: boundary.kind,
              temperature: boundary.temperature,
            };
          if (boundary.kind === 'flux')
            return {
              selection,
              kind: 'inward-heat-flux' as const,
              flux: boundary.inwardFlux,
            };
          return { selection, kind: 'insulated' as const };
        }),
        initialTemperature: { value: 300, units: 'K' },
        time: { timestep: { value: 10, units: 's' }, steps: 10 },
      },
      observations: [
        {
          id: 'mean_at_50s',
          quantity: 'temperature_mean',
          time: { value: 50, units: 's' },
        },
        { id: 'mean_at_end', quantity: 'temperature_mean' },
      ],
      acceptanceCriteria: [
        {
          observationId: 'mean_at_50s',
          operator: '<',
          threshold: { value: 401, units: 'K' },
        },
        {
          observationId: 'mean_at_end',
          operator: '<',
          threshold: { value: 401, units: 'K' },
        },
      ],
      assumptions: [],
    };
    const validation = await simulation.validateStudy(study);
    expect(validation.valid, JSON.stringify(validation.issues)).toBe(true);
    const offGrid = await simulation.validateStudy({
      ...study,
      observations: [
        {
          id: 'off_grid',
          quantity: 'temperature_mean',
          time: { value: 55, units: 's' },
        },
      ],
    });
    expect(offGrid.valid).toBe(false);
    const queued = await simulation.prepareStudy(study);
    const preparation = await waitForJob(simulation, queued.jobId);
    expect(preparation.status).toBe('succeeded');
    if (!preparation.prepared) throw new Error('Transient preparation did not return an artifact.');
    const started = await simulation.runStudy(preparation.prepared);
    const run = await waitForRun(simulation, started.runId);
    const errors = await Promise.all(
      run.logs.map(async (ref) => (await simulation.artifacts.verify(ref)).toString()),
    );
    expect(run.status, errors.join('\n')).toBe('succeeded');
    expect(run.summaries).toHaveLength(40);
    expect(run.results).toHaveLength(10);
    expect(run.results.map((result) => result.time)).toEqual(
      Array.from({ length: 10 }, (_, i) => ({
        value: (i + 1) * 10,
        units: 's',
      })),
    );
    const finalVtu = (await simulation.artifacts.verify(run.results.at(-1)!.artifact)).toString();
    const pointData = finalVtu.match(/<PointData\b[^>]*>([\s\S]*?)<\/PointData>/)?.[1];
    const temperatures = capture(
      pointData ?? '',
      /<DataArray\b[^>]*Name="temperature"[^>]*>([\s\S]*?)<\/DataArray>/i,
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    const pointBlock = finalVtu.match(/<Points\b[^>]*>([\s\S]*?)<\/Points>/)?.[1];
    const coordinates = capture(pointBlock ?? '', /<DataArray\b[^>]*>([\s\S]*?)<\/DataArray>/)
      .trim()
      .split(/\s+/)
      .map(Number);
    if (temperatures.length === 0 || coordinates.length === 0)
      throw new Error('Transient VTU lacks point temperatures or coordinates.');
    const target = [0.05, 0.005, 0.005];
    const distance = (index: number) =>
      Math.hypot(
        coordinates![3 * index]! - target[0]!,
        coordinates![3 * index + 1]! - target[1]!,
        coordinates![3 * index + 2]! - target[2]!,
      );
    let nearest = 0;
    for (let i = 1; i < temperatures.length; i++) if (distance(i) < distance(nearest)) nearest = i;
    const x = coordinates[3 * nearest]!;
    const alpha = 10 / (1000 * 1000);
    let normalized = 1 - x / 0.1;
    for (let mode = 1; mode <= 30; mode++)
      normalized -=
        (2 / Math.PI) *
        (Math.sin((mode * Math.PI * x) / 0.1) / mode) *
        Math.exp(-alpha * ((mode * Math.PI) / 0.1) ** 2 * 100);
    const analyticTemperature = 300 + 100 * normalized;
    expect(Math.abs(temperatures[nearest]! - analyticTemperature)).toBeLessThan(2);
    const queried = await simulation.queryResults(run.runId);
    expect(queried.observations).toMatchObject([
      {
        id: 'mean_at_50s',
        status: 'available',
        units: 'K',
        time: { value: 50, units: 's' },
      },
      {
        id: 'mean_at_end',
        status: 'available',
        units: 'K',
        time: { value: 100, units: 's' },
      },
    ]);
    expect(at(queried.observations, 0).value).toBeGreaterThan(300);
    expect(at(queried.observations, 1).value).toBeGreaterThan(at(queried.observations, 0).value!);
    expect(queried.acceptance.map((item) => item.status)).toEqual(['pass', 'pass']);
  } finally {
    await simulation.close();
  }
}, 240000);

it('prepares, runs, and queries static structural axial deformation', async () => {
  const simulation = await service();
  try {
    const inspected = await simulation.inspect({
      uri: pathToFileURL(fixture).href,
    });
    const selected = barSelections(inspected.inventory);
    const groupNames = new Map(selected.groups.map((group) => [group.id, group.name]));
    const ends = barEnds(inspected.inventory);
    const study = {
      schemaVersion: '1',
      name: 'Static axial bar deformation',
      objective: 'Check linear elastic displacement and axial stress against the bar solution.',
      model: { source: inspected.source, inspection: inspected.inspection },
      selections: selected.groups.map((group) => ({
        name: group.name,
        entities: group.entities.map((tag) => `${group.dimension}:${tag}`),
      })),
      mesh: {
        minSize: controls.minSize,
        maxSize: controls.maxSize,
        elementOrder: 1,
      },
      physics: {
        kind: 'static-structural',
        materials: [
          {
            selection: groupNames.get(1)!,
            youngsModulus: { value: 210e9, units: 'Pa' },
            poissonRatio: 0.3,
          },
        ],
        boundaries: selected.config.boundaries.map((boundary) => {
          const name = groupNames.get(boundary.group)!;
          return name === ends.start
            ? { selection: name, kind: 'fixed-displacement' as const }
            : name === ends.end
              ? {
                  selection: name,
                  kind: 'prescribed-displacement' as const,
                  displacement: [
                    { value: 1e-4, units: 'm' as const },
                    { value: 0, units: 'm' as const },
                    { value: 0, units: 'm' as const },
                  ],
                }
              : { selection: name, kind: 'free' as const };
        }),
      },
      observations: [
        { id: 'max_displacement', quantity: 'displacement_magnitude_max' },
        { id: 'mean_axial_stress', quantity: 'stress_xx_mean' },
        { id: 'max_von_mises', quantity: 'von_mises_stress_max' },
      ],
      acceptanceCriteria: [
        {
          observationId: 'max_displacement',
          operator: '<=',
          threshold: { value: 1e-4, units: 'm' },
        },
        {
          observationId: 'mean_axial_stress',
          operator: '>=',
          threshold: { value: 189e6, units: 'Pa' },
        },
      ],
      assumptions: [],
    };
    const validation = await simulation.validateStudy(study);
    expect(validation.valid, JSON.stringify(validation.issues)).toBe(true);
    const queued = await simulation.prepareStudy(study);
    const preparation = await waitForJob(simulation, queued.jobId);
    expect(preparation.status).toBe('succeeded');
    if (!preparation.prepared)
      throw new Error('Structural preparation returned no prepared artifact.');
    const started = await simulation.runStudy(preparation.prepared);
    const run = await waitForRun(simulation, started.runId);
    const logs = await Promise.all(
      run.logs.map(async (ref) => (await simulation.artifacts.verify(ref)).toString()),
    );
    expect(run.status, logs.join('\n')).toBe('succeeded');
    expect(run.results).toHaveLength(1);
    expect(run.summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'displacement_magnitude_max',
          units: 'm',
        }),
        expect.objectContaining({ name: 'stress_xx_mean', units: 'Pa' }),
      ]),
    );
    const queried = await simulation.queryResults(run.runId);
    expect(queried.observations).toMatchObject([
      { id: 'max_displacement', status: 'available', units: 'm' },
      { id: 'mean_axial_stress', status: 'available', units: 'Pa' },
      { id: 'max_von_mises', status: 'available', units: 'Pa' },
    ]);
    expect(at(queried.observations, 0).value).toBeCloseTo(1e-4, 6);
    expect(at(queried.observations, 1).value).toBeGreaterThan(189e6);
    expect(at(queried.observations, 1).value).toBeLessThan(231e6);
    expect(at(queried.observations, 2).status).toBe('available');
    expect(at(queried.observations, 2).value).toBeGreaterThan(0);
    expect(queried.acceptance.map((item) => item.status)).toEqual(['pass', 'pass']);
  } finally {
    await simulation.close();
  }
}, 240000);

it('prepares, runs, and queries DC conduction through the shared workflow', async () => {
  const simulation = await service();
  try {
    const inspected = await simulation.inspect({
      uri: pathToFileURL(fixture).href,
    });
    const selected = barSelections(inspected.inventory);
    const groupNames = new Map(selected.groups.map((group) => [group.id, group.name]));
    const ends = barEnds(inspected.inventory);
    const study = {
      schemaVersion: '1',
      name: 'Uniform bar DC potential',
      objective: 'Validate the linear potential field under prescribed end voltages.',
      model: { source: inspected.source, inspection: inspected.inspection },
      selections: selected.groups.map((group) => ({
        name: group.name,
        entities: group.entities.map((tag) => `${group.dimension}:${tag}`),
      })),
      mesh: {
        minSize: controls.minSize,
        maxSize: controls.maxSize,
        elementOrder: 1,
      },
      physics: {
        kind: 'dc-conduction',
        materials: [
          {
            selection: groupNames.get(1)!,
            electricalConductivity: { value: 1, units: 'S/m' },
          },
        ],
        boundaries: selected.config.boundaries.map((boundary) => {
          const name = groupNames.get(boundary.group)!;
          return name === ends.start
            ? {
                selection: name,
                kind: 'potential' as const,
                potential: { value: 10, units: 'V' as const },
              }
            : name === ends.end
              ? {
                  selection: name,
                  kind: 'potential' as const,
                  potential: { value: 0, units: 'V' as const },
                }
              : { selection: name, kind: 'insulated' as const };
        }),
      },
      observations: [
        { id: 'minimum_potential', quantity: 'potential_min' },
        { id: 'maximum_potential', quantity: 'potential_max' },
        { id: 'mean_potential', quantity: 'potential_mean' },
      ],
      acceptanceCriteria: [
        {
          observationId: 'minimum_potential',
          operator: '<=',
          threshold: { value: 1e-6, units: 'V' },
        },
        {
          observationId: 'maximum_potential',
          operator: '>=',
          threshold: { value: 10 - 1e-6, units: 'V' },
        },
      ],
      assumptions: [],
    };
    const validation = await simulation.validateStudy(study);
    expect(validation.valid, JSON.stringify(validation.issues)).toBe(true);
    const queued = await simulation.prepareStudy(study);
    const preparation = await waitForJob(simulation, queued.jobId);
    expect(preparation.status).toBe('succeeded');
    if (!preparation.prepared) throw new Error('DC preparation returned no prepared artifact.');
    const started = await simulation.runStudy(preparation.prepared);
    const run = await waitForRun(simulation, started.runId);
    const logs = await Promise.all(
      run.logs.map(async (ref) => (await simulation.artifacts.verify(ref)).toString()),
    );
    expect(run.status, logs.join('\n')).toBe('succeeded');
    expect(run.results).toHaveLength(1);
    expect(run.summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'potential_min',
          value: expect.closeTo(0, 6),
          units: 'V',
        }),
        expect.objectContaining({
          name: 'potential_max',
          value: expect.closeTo(10, 6),
          units: 'V',
        }),
        expect.objectContaining({ name: 'potential_mean', units: 'V' }),
      ]),
    );
    const queried = await simulation.queryResults(run.runId);
    expect(queried.observations).toMatchObject([
      { id: 'minimum_potential', status: 'available', units: 'V' },
      { id: 'maximum_potential', status: 'available', units: 'V' },
      { id: 'mean_potential', status: 'available', units: 'V' },
    ]);
    expect(at(queried.observations, 2).value).toBeGreaterThan(0);
    expect(at(queried.observations, 2).value).toBeLessThan(10);
    expect(queried.acceptance.map((item) => item.status)).toEqual(['pass', 'pass']);
  } finally {
    await simulation.close();
  }
}, 240000);

it('prepares, runs, and queries modal frequencies through the shared workflow', async () => {
  const simulation = await service();
  try {
    const inspected = await simulation.inspect({
      uri: pathToFileURL(fixture).href,
    });
    const selected = barSelections(inspected.inventory);
    const groupNames = new Map(selected.groups.map((group) => [group.id, group.name]));
    const ends = barEnds(inspected.inventory);
    const study = {
      schemaVersion: '1',
      name: 'Fixed-free bar modal frequencies',
      objective: 'Verify linear-elastic modal frequencies against a cantilever-beam reference.',
      model: { source: inspected.source, inspection: inspected.inspection },
      selections: selected.groups.map((group) => ({
        name: group.name,
        entities: group.entities.map((tag) => `${group.dimension}:${tag}`),
      })),
      mesh: {
        minSize: controls.minSize,
        maxSize: controls.maxSize,
        elementOrder: 1,
      },
      physics: {
        kind: 'modal',
        materials: [
          {
            selection: groupNames.get(1)!,
            youngsModulus: { value: 210e9, units: 'Pa' },
            poissonRatio: 0.3,
            density: { value: 7800, units: 'kg/m3' },
          },
        ],
        boundaries: selected.config.boundaries.map((boundary) => {
          const name = groupNames.get(boundary.group)!;
          return {
            selection: name,
            kind: name === ends.start ? ('fixed-displacement' as const) : ('free' as const),
          };
        }),
        modes: 6,
      },
      observations: [{ id: 'first_frequency', quantity: 'eigenfrequency', mode: 1 }],
      acceptanceCriteria: [
        {
          observationId: 'first_frequency',
          operator: '>',
          threshold: { value: 418, units: 'Hz' },
        },
        {
          observationId: 'first_frequency',
          operator: '<',
          threshold: { value: 1254, units: 'Hz' },
        },
      ],
      assumptions: [],
    };
    const validation = await simulation.validateStudy(study);
    expect(validation.valid, JSON.stringify(validation.issues)).toBe(true);
    const queued = await simulation.prepareStudy(study);
    const preparation = await waitForJob(simulation, queued.jobId);
    expect(preparation.status).toBe('succeeded');
    if (!preparation.prepared) throw new Error('Modal preparation returned no prepared artifact.');
    const started = await simulation.runStudy(preparation.prepared);
    const run = await waitForRun(simulation, started.runId);
    const logs = await Promise.all(
      run.logs.map(async (ref) => (await simulation.artifacts.verify(ref)).toString()),
    );
    expect(run.status, logs.join('\n')).toBe('succeeded');
    expect(run.summaries).toHaveLength(6);
    expect(run.results).toHaveLength(0);
    expect(run.summaries[0]).toMatchObject({
      name: 'eigenfrequency_mode_1',
      units: 'Hz',
    });
    const queried = await simulation.queryResults(run.runId);
    expect(queried.observations).toMatchObject([
      {
        id: 'first_frequency',
        quantity: 'eigenfrequency',
        mode: 1,
        status: 'available',
        units: 'Hz',
      },
    ]);
    expect(at(queried.observations, 0).value).toBeGreaterThan(418);
    expect(at(queried.observations, 0).value).toBeLessThan(1254);
    expect(queried.acceptance.map((item) => item.status)).toEqual(['pass', 'pass']);
  } finally {
    await simulation.close();
  }
}, 240000);

it('rejects malformed STEP without invoking another service', async () => {
  const root = await temporary();
  await writeFile(join(root, 'bad.step'), 'not STEP');
  const simulation = await service({ roots: [root] });
  try {
    await expect(
      simulation.inspect({ uri: pathToFileURL(join(root, 'bad.step')).href }),
    ).rejects.toMatchObject({ code: 'unsupported_format' });
    await writeFile(join(root, 'bad.step'), 'ISO-10303-21;\nmalformed\n');
    await expect(
      simulation.inspect({ uri: pathToFileURL(join(root, 'bad.step')).href }),
    ).rejects.toMatchObject({ code: 'process_failed' });
  } finally {
    await simulation.close();
  }
}, 30000);
