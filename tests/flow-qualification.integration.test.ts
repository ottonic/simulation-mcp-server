import { expect, it } from 'vitest';
import {
  analyticFlux,
  analyticSteadyVelocity,
  analyticTransientVelocity,
  boundaryTriangles,
  DUCT,
  ductFixtureUri,
  ductSelection,
  ductService,
  ductStudy,
  executeDuctStudy,
  parseDuctVtu,
  planeFluxX,
  relativeL2,
  type DuctVtu,
} from './flow-helpers.js';

// Samples the interior of the duct away from the inlet/outlet so the fully
// developed analytic solution applies.
function interiorSamples(vtu: DuctVtu) {
  const indexes: number[] = [];
  for (let i = 0; i < vtu.pressure.length; i++) {
    const x = vtu.points[3 * i]!;
    if (x > 0.025 && x < 0.075) indexes.push(i);
  }
  return indexes;
}

function steadyMetrics(vtu: DuctVtu) {
  const triangles = boundaryTriangles(vtu);
  const fluxInlet = planeFluxX(vtu, triangles, 0);
  const fluxOutlet = planeFluxX(vtu, triangles, DUCT.length);
  const fluxAnalytic = analyticFlux();
  const indexes = interiorSamples(vtu);
  const velocity = indexes.map((i) => vtu.velocity[3 * i]!);
  const reference = indexes.map((i) =>
    analyticSteadyVelocity(vtu.points[3 * i + 1]!, vtu.points[3 * i + 2]!),
  );
  const maxPressureError = Math.max(
    ...indexes.map((i) =>
      Math.abs(vtu.pressure[i]! - DUCT.deltaP * (1 - vtu.points[3 * i]! / DUCT.length)),
    ),
  );
  return {
    samples: indexes.length,
    velocityRelativeL2: relativeL2(velocity, reference),
    maxPressureError,
    fluxInlet,
    fluxOutlet,
    fluxAnalytic,
    conservation: Math.abs(fluxInlet - fluxOutlet) / Math.abs((fluxInlet + fluxOutlet) / 2),
    fluxRelativeError:
      Math.abs((fluxInlet + fluxOutlet) / 2 - fluxAnalytic) / Math.abs(fluxAnalytic),
  };
}

it('qualifies steady duct flow: analytic accuracy, flux conservation, and mesh refinement', async () => {
  const sim = await ductService();
  try {
    const inspected = await sim.inspect({ uri: ductFixtureUri() });
    const selection = ductSelection(inspected.inventory);
    const meshes = [
      { label: 'coarse', minSize: 0.002, maxSize: 0.004 },
      { label: 'fine', minSize: 0.001, maxSize: 0.002 },
    ];
    const results: (ReturnType<typeof steadyMetrics> & { label: string })[] = [];
    for (const mesh of meshes) {
      const study = ductStudy({
        inspected,
        selection,
        mesh,
        regime: { mode: 'steady' },
      });
      const run = await executeDuctStudy(sim, study);
      expect(run.results, JSON.stringify(run.error)).toHaveLength(1);
      const vtu = parseDuctVtu((await sim.artifacts.verify(run.results[0]!.artifact)).toString());
      results.push({ label: mesh.label, ...steadyMetrics(vtu) });
    }
    console.info(`Steady flow qualification: ${JSON.stringify(results)}`);
    for (const result of results) {
      expect(result.samples).toBeGreaterThan(20);
      expect(result.velocityRelativeL2).toBeLessThan(0.08);
      expect(result.maxPressureError).toBeLessThan(0.02);
      expect(result.conservation).toBeLessThan(0.05);
      expect(result.fluxRelativeError).toBeLessThan(0.35);
    }
    const [coarse, fine] = results;
    // Refinement must improve every metric.
    expect(fine!.velocityRelativeL2).toBeLessThan(coarse!.velocityRelativeL2);
    expect(fine!.conservation).toBeLessThan(coarse!.conservation);
    expect(fine!.fluxRelativeError).toBeLessThan(coarse!.fluxRelativeError);
    // Fine-mesh absolute bounds.
    expect(fine!.velocityRelativeL2).toBeLessThan(0.07);
    expect(fine!.conservation).toBeLessThan(0.02);
    expect(fine!.fluxRelativeError).toBeLessThan(0.22);
  } finally {
    await sim.close();
  }
}, 180_000);

it('qualifies transient duct flow startup: analytic profile and timestep refinement', async () => {
  const sim = await ductService();
  try {
    const inspected = await sim.inspect({ uri: ductFixtureUri() });
    const selection = ductSelection(inspected.inventory);
    const mesh = { minSize: 0.0015, maxSize: 0.003 };
    const schedules = [
      { label: 'dt=0.05', timestep: 0.05, steps: 8 },
      { label: 'dt=0.025', timestep: 0.025, steps: 16 },
    ];
    const results: {
      label: string;
      time: number;
      samples: number;
      analyticError: number;
      velocity: number[];
    }[] = [];
    for (const schedule of schedules) {
      const study = ductStudy({
        inspected,
        selection,
        mesh,
        regime: {
          mode: 'transient',
          timestep: schedule.timestep,
          steps: schedule.steps,
        },
      });
      const run = await executeDuctStudy(sim, study);
      expect(run.results, JSON.stringify(run.error)).toHaveLength(schedule.steps);
      const final = run.results.at(-1)!;
      expect(final.time).toEqual({
        value: schedule.timestep * schedule.steps,
        units: 's',
      });
      const vtu = parseDuctVtu((await sim.artifacts.verify(final.artifact)).toString());
      const indexes = interiorSamples(vtu);
      const velocity = indexes.map((i) => vtu.velocity[3 * i]!);
      const reference = indexes.map((i) =>
        analyticTransientVelocity(
          schedule.timestep * schedule.steps,
          vtu.points[3 * i + 1]!,
          vtu.points[3 * i + 2]!,
        ),
      );
      results.push({
        label: schedule.label,
        time: schedule.timestep * schedule.steps,
        samples: indexes.length,
        analyticError: relativeL2(velocity, reference),
        velocity,
      });
    }
    // Both schedules reach the same physical time on the same mesh, so the only
    // difference is the timestep. A small field difference demonstrates temporal
    // insensitivity; both must still track the analytic solution.
    expect(results[0]!.samples).toBe(results[1]!.samples);
    const timestepSensitivity = relativeL2(results[1]!.velocity, results[0]!.velocity);
    console.info(
      `Transient flow qualification: ${JSON.stringify({
        analyticError: results.map((result) => ({
          label: result.label,
          time: result.time,
          error: result.analyticError,
        })),
        timestepSensitivity,
      })}`,
    );
    for (const result of results) {
      expect(result.samples).toBeGreaterThan(20);
      expect(result.analyticError).toBeLessThan(0.15);
    }
    expect(timestepSensitivity).toBeLessThan(0.03);
  } finally {
    await sim.close();
  }
}, 180_000);
