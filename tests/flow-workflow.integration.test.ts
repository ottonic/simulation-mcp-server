import { expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { barSelections, fixture, service, waitForJob, waitForRun } from './helpers.js';

it.each(['steady', 'transient'] as const)(
  'runs %s pressure-driven Newtonian flow through the shared job workflow',
  async (mode) => {
    const sim = await service();
    try {
      const inspected = await sim.inspect({ uri: pathToFileURL(fixture).href });
      const selected = barSelections(inspected.inventory);
      const names = new Map(selected.groups.map((group) => [group.id, group.name]));
      const faceAt = (x: number) =>
        inspected.inventory.entities.find(
          (entity) => entity.dimension === 2 && Math.abs(entity.center[0] - x) < 1e-8,
        );
      const groupAt = (x: number) =>
        selected.groups.find(
          (group) => group.dimension === 2 && group.entities.includes(faceAt(x)?.tag ?? -1),
        );
      const inlet = groupAt(0),
        outlet = groupAt(0.1);
      if (!inlet || !outlet) throw new Error('Duct end groups were not identified');
      const study = {
        schemaVersion: '1',
        name: 'Pressure-driven duct flow',
        objective: 'Verify laminar incompressible Newtonian flow in a straight square duct.',
        model: { source: inspected.source, inspection: inspected.inspection },
        selections: selected.groups.map((group) => ({
          name: group.name,
          entities: group.entities.map((tag) => `${group.dimension}:${tag}`),
        })),
        mesh: { minSize: 0.001, maxSize: 0.002, elementOrder: 1 },
        physics: {
          kind: 'laminar-flow',
          materials: [
            {
              selection: names.get(selected.config.materials[0]!.group)!,
              density: { value: mode === 'steady' ? 1 : 1000, units: 'kg/m3' },
              dynamicViscosity: { value: 0.01, units: 'Pa.s' },
            },
          ],
          boundaries: selected.groups
            .filter((group) => group.dimension === 2)
            .map((group) =>
              group.id === inlet.id
                ? {
                    selection: group.name,
                    kind: 'pressure',
                    pressure: { value: 1, units: 'Pa' },
                  }
                : group.id === outlet.id
                  ? {
                      selection: group.name,
                      kind: 'pressure',
                      pressure: { value: 0, units: 'Pa' },
                    }
                  : { selection: group.name, kind: 'no-slip' },
            ),
          regime:
            mode === 'steady'
              ? { mode }
              : {
                  mode,
                  initialVelocity: [
                    { value: 0, units: 'm/s' },
                    { value: 0, units: 'm/s' },
                    { value: 0, units: 'm/s' },
                  ],
                  time: { timestep: { value: 0.05, units: 's' }, steps: 20 },
                },
        },
        observations: [
          {
            id: 'peak_speed',
            quantity: 'velocity_magnitude_max',
            ...(mode === 'transient' ? { time: { value: 0.25, units: 's' } } : {}),
          },
          { id: 'pressure_maximum', quantity: 'pressure_max' },
        ],
        acceptanceCriteria:
          mode === 'transient'
            ? [
                {
                  observationId: 'peak_speed',
                  operator: '>',
                  threshold: { value: 0, units: 'm/s' },
                },
              ]
            : [],
        assumptions: [],
      };
      const missingModel = await sim.validateStudy({
        ...study,
        model: {
          ...study.model,
          source: {
            ...inspected.source,
            uri: 'file:///missing-flow-model.step',
          },
        },
      });
      expect(missingModel.valid).toBe(false);
      expect(missingModel.issues).toContainEqual(
        expect.objectContaining({ path: '/model', code: 'file_not_found' }),
      );
      const staleSelection = await sim.validateStudy({
        ...study,
        selections: study.selections.map((selection, index) =>
          index === 0 ? { ...selection, entities: ['3:999'] } : selection,
        ),
      });
      expect(staleSelection.valid).toBe(false);
      expect(staleSelection.issues).toContainEqual(
        expect.objectContaining({ path: '/selections', code: 'invalid_study' }),
      );
      const rejectedPreparation = await sim.prepareStudy({
        ...study,
        selections: study.selections.map((selection, index) =>
          index === 0 ? { ...selection, entities: ['3:999'] } : selection,
        ),
      });
      const rejected = await waitForJob(sim, rejectedPreparation.jobId);
      expect(rejected.status).toBe('failed');
      expect(rejected.error?.message).toContain('/selections:');
      expect((await sim.validateStudy(study)).valid).toBe(true);
      const preparation = await sim.prepareStudy(study);
      const prepared = await waitForJob(sim, preparation.jobId);
      expect(prepared.status).toBe('succeeded');
      const started = await sim.runStudy(prepared.prepared!);
      const completed = await waitForRun(sim, started.runId);
      expect(completed.status).toBe('succeeded');
      expect(completed.results).toHaveLength(mode === 'steady' ? 1 : 20);
      expect(completed.results[0]!.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'velocity',
            components: 3,
            units: 'm/s',
          }),
          expect.objectContaining({
            name: 'pressure',
            components: 1,
            units: 'Pa',
          }),
        ]),
      );
      expect(completed.summaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'velocity_magnitude_max',
            units: 'm/s',
          }),
          expect.objectContaining({ name: 'pressure_min', units: 'Pa' }),
        ]),
      );
      expect(completed.convergence).toContain('converged output sample');
      const queried = await sim.queryResults(completed.runId);
      expect(queried.observations[0]?.status).toBe('available');
      expect(queried.observations[0]?.time).toEqual(
        mode === 'transient' ? { value: 0.25, units: 's' } : undefined,
      );
      if (mode === 'transient') {
        expect(queried.observations[1]?.time).toEqual({ value: 1, units: 's' });
        expect(queried.acceptance).toEqual([
          expect.objectContaining({
            observationId: 'peak_speed',
            status: 'pass',
          }),
        ]);
      }
      // Bounded default response: observation-backed summaries and an artifact page.
      expect(queried.artifactCount).toBe(completed.results.length);
      expect(queried.artifacts.length).toBeLessThanOrEqual(50);
      expect(queried.summaries.length).toBeLessThanOrEqual(queried.observations.length);
      const page = await sim.queryResults(completed.runId, { limit: 5 });
      expect(page.artifacts).toHaveLength(Math.min(5, completed.results.length));
      if (completed.results.length > 5) expect(page.nextCursor).toBe('5');
      const filtered = await sim.queryResults(completed.runId, {
        observations: ['peak_speed'],
      });
      expect(filtered.observations.map((item) => item.id)).toEqual(['peak_speed']);
      if (mode === 'transient') {
        const frame = await sim.queryResults(completed.runId, {
          include: ['summaries'],
          time: 0.25,
        });
        expect(frame.summaries.length).toBeGreaterThan(0);
        expect(frame.summaries.every((summary) => summary.time?.value === 0.25)).toBe(true);
        // A query-level time selects the frame for observations without an
        // explicit time (pressure_maximum) and keeps their backing evidence.
        const selected = await sim.queryResults(completed.runId, {
          time: 0.25,
        });
        expect(selected.observations[1]?.status).toBe('available');
        expect(selected.observations[1]?.time).toEqual({
          value: 0.25,
          units: 's',
        });
        expect(selected.summaries.length).toBeGreaterThan(0);
      }
    } finally {
      await sim.close();
    }
  },
  180000,
);
