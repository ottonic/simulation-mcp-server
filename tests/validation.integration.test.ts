import { expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { barSelections, fixture, service } from './helpers.js';

it('rejects studies that violate necessary physics conditions', async () => {
  const sim = await service();
  try {
    const inspected = await sim.inspect({ uri: pathToFileURL(fixture).href });
    const selected = barSelections(inspected.inventory);
    const volume = selected.groups.find((group) => group.dimension === 3)!;
    const surfaces = selected.groups.filter((group) => group.dimension === 2);
    const base = {
      schemaVersion: '1',
      name: 'necessary conditions',
      objective: 'Check early validation of necessary physics conditions.',
      model: { source: inspected.source, inspection: inspected.inspection },
      selections: selected.groups.map((group) => ({
        name: group.name,
        entities: group.entities.map((tag) => `${group.dimension}:${tag}`),
      })),
      mesh: { minSize: 0.003, maxSize: 0.006, elementOrder: 1 },
      observations: [],
      acceptanceCriteria: [],
      assumptions: [],
    };

    // Laminar flow with a single distinct pressure cannot drive flow.
    const flow = {
      ...base,
      physics: {
        kind: 'laminar-flow',
        materials: [
          {
            selection: volume.name,
            density: { value: 1000, units: 'kg/m3' },
            dynamicViscosity: { value: 0.001, units: 'Pa.s' },
          },
        ],
        boundaries: surfaces.map((group) => ({
          selection: group.name,
          kind: 'pressure',
          pressure: { value: 0, units: 'Pa' },
        })),
        regime: { mode: 'steady' },
      },
    };
    const flowResult = await sim.validateStudy(flow);
    expect(flowResult.valid).toBe(false);
    expect(flowResult.issues).toContainEqual(expect.objectContaining({ path: '/physics' }));

    // A steady thermal study with no fixed temperature has no datum.
    const thermal = {
      ...base,
      physics: {
        kind: 'steady-thermal',
        defaultBoundary: 'insulated',
        materials: [
          {
            selection: volume.name,
            conductivity: { value: 10, units: 'W/(m.K)' },
          },
        ],
        sources: [],
        boundaries: surfaces.map((group) => ({
          selection: group.name,
          kind: 'insulated',
        })),
      },
    };
    const thermalResult = await sim.validateStudy(thermal);
    expect(thermalResult.valid).toBe(false);
    expect(thermalResult.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('fixed-temperature'),
      }),
    );

    // Duplicate source selections on one volume are rejected early.
    const duplicateSources = {
      ...base,
      physics: {
        kind: 'steady-thermal',
        defaultBoundary: 'insulated',
        materials: [
          {
            selection: volume.name,
            conductivity: { value: 10, units: 'W/(m.K)' },
          },
        ],
        sources: [
          {
            selection: volume.name,
            volumetricHeat: { value: 1, units: 'W/m3' },
          },
          {
            selection: volume.name,
            volumetricHeat: { value: 2, units: 'W/m3' },
          },
        ],
        boundaries: surfaces.map((group, index) =>
          index === 0
            ? {
                selection: group.name,
                kind: 'temperature' as const,
                temperature: { value: 300, units: 'K' as const },
              }
            : { selection: group.name, kind: 'insulated' as const },
        ),
      },
    };
    const duplicateResult = await sim.validateStudy(duplicateSources);
    expect(duplicateResult.valid).toBe(false);
    expect(duplicateResult.issues).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('more than once'),
      }),
    );

    // A meter-vs-millimeter mesh mistake (1-3 m on a 10 mm bar) is a warning,
    // not an error: the study still validates and the physics checks still run.
    const coarseMesh = {
      ...base,
      mesh: { minSize: 1, maxSize: 3, elementOrder: 1 },
      physics: {
        kind: 'steady-thermal',
        defaultBoundary: 'insulated',
        materials: [
          {
            selection: volume.name,
            conductivity: { value: 10, units: 'W/(m.K)' },
          },
        ],
        sources: [],
        boundaries: surfaces.map((group, index) =>
          index === 0
            ? {
                selection: group.name,
                kind: 'temperature' as const,
                temperature: { value: 300, units: 'K' as const },
              }
            : { selection: group.name, kind: 'insulated' as const },
        ),
      },
    };
    const coarseResult = await sim.validateStudy(coarseMesh);
    expect(coarseResult.valid).toBe(true);
    expect(coarseResult.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'mesh_size_large',
        path: '/mesh/maxSize',
      }),
    );
  } finally {
    await sim.close();
  }
}, 60_000);
