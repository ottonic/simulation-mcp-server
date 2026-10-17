import { describe, expect, it } from 'vitest';
import { symlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Artifacts, digest } from '../src/artifacts.js';
import { artifactSchema, thermalSchema, type Thermal } from '../src/schemas.js';
import { staticStructuralSchema } from '../src/schemas.js';
import { generateSif, normalizeThermal } from '../src/thermal.js';
import { validateConversion } from '../src/mesh.js';
import {
  parseScalars,
  parseTransientScalars,
  inspectVtu,
  parseVtu,
  parseStaticStructuralVtuMetrics,
  parseModalEigenvalues,
  parseDcPotentialMetrics,
} from '../src/results.js';
import { temporary } from './helpers.js';
import { generateStaticStructuralSif } from '../src/structural.js';
import { validatePrescribedBoundaryNodes } from '../src/boundaries.js';

describe('artifact inputs and exact bytes', () => {
  it('accepts supported artifact formats and rejects invalid references', () => {
    const revision = `sha256:${'a'.repeat(64)}`;
    const refs = ['step', 'gmsh-msh', 'elmer-mesh', 'vtu', 'elmer-sif', 'text', 'json'].map(
      (format) => ({
        revision,
        uri: `file:///tmp/artifact.${format}`,
        format,
      }),
    );
    for (const ref of refs) expect(artifactSchema.safeParse(ref).success).toBe(true);
    expect(artifactSchema.safeParse({ ...refs[0], revision: 'current' }).success).toBe(false);
    expect(artifactSchema.safeParse({ ...refs[0], format: 'directory' }).success).toBe(false);
    expect(artifactSchema.safeParse({ ...refs[0], arbitrary: true }).success).toBe(false);
    expect(digest('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(digest('abc\n')).not.toBe(digest('abc'));
  });
  it('rejects stale data, paths outside configured roots, traversal and directories', async () => {
    const workspace = await temporary(),
      input = await temporary(),
      outside = await temporary();
    const artifacts = await Artifacts.create(workspace, [input]);
    const source = join(input, 'input.step');
    await writeFile(source, 'abc');
    const ref = {
      revision: digest('abc'),
      uri: pathToFileURL(source).href,
      format: 'step',
    };
    const snapshot = await artifacts.put(
      await artifacts.directory(),
      'source.step',
      await artifacts.verify(ref),
      'step',
    );
    await writeFile(source, 'changed');
    await expect(artifacts.verify(ref)).rejects.toMatchObject({
      code: 'stale_artifact',
    });
    expect((await artifacts.verify(snapshot)).toString()).toBe('abc');
    await writeFile(join(outside, 'secret'), 'secret');
    await symlink(outside, join(input, 'escape'), 'junction');
    await expect(
      artifacts.bytes(pathToFileURL(join(input, 'escape', 'secret')).href),
    ).rejects.toMatchObject({ code: 'path_policy' });
    await expect(
      artifacts.bytes(`${pathToFileURL(`${input}${sep}`).href}nested/../input.step`),
    ).rejects.toMatchObject({ code: 'path_policy' });
    await expect(artifacts.bytes('https://example.com/model.step')).rejects.toMatchObject({
      code: 'path_policy',
    });
    await expect(artifacts.bytes(pathToFileURL(input).href)).rejects.toMatchObject({
      code: 'path_policy',
    });
  });
});

describe('prescribed boundary node consistency', () => {
  const boundaryFile = ['1 1 100 0 303 9 10 11', '2 2 101 0 303 9 12 13'].join('\n');

  it('rejects conflicting values on the same degree of freedom', () => {
    expect(() =>
      validatePrescribedBoundaryNodes(boundaryFile, [
        { group: 1, dofs: { potential: 1 } },
        { group: 2, dofs: { potential: 0 } },
      ]),
    ).toThrow(/Conflicting prescribed values for potential/);
  });

  it('accepts matching values and independent degrees of freedom', () => {
    expect(() =>
      validatePrescribedBoundaryNodes(boundaryFile, [
        { group: 1, dofs: { velocity_x: 0, pressure: 1 } },
        { group: 2, dofs: { velocity_x: 0 } },
      ]),
    ).not.toThrow();
  });
});

const ref = { format: 'text', revision: digest('fixture') };
const mesh = {
  groups: [
    {
      id: 1,
      name: 'volume',
      dimension: 3 as const,
      entities: [1],
      elements: 1,
    },
    { id: 2, name: 'hot', dimension: 2 as const, entities: [2], elements: 2 },
    {
      id: 3,
      name: 'insulated',
      dimension: 2 as const,
      entities: [3],
      elements: 3,
    },
  ],
  connectedBodies: [[1]],
  boundaryBodies: { '2': [1], '3': [1] },
};
const config: Thermal = {
  physics: 'steady-heat-conduction',
  materials: [{ group: 1, conductivity: { value: 10, units: 'W/(m.K)' } }],
  sources: [],
  boundaries: [
    { group: 2, kind: 'temperature', temperature: { value: 400, units: 'K' } },
    { group: 3, kind: 'insulated' },
  ],
};
describe('thermal engineering inputs', () => {
  it('requires complete material and boundary coverage, known units and constrained components', () => {
    expect(() => normalizeThermal({ ...config, materials: [] }, mesh)).toThrow();
    expect(() =>
      normalizeThermal({ ...config, boundaries: [config.boundaries[0]] }, mesh),
    ).toThrow();
    expect(() =>
      normalizeThermal(
        {
          ...config,
          boundaries: [{ group: 2, kind: 'insulated' }, config.boundaries[1]],
        },
        mesh,
      ),
    ).toThrow();
    expect(() =>
      normalizeThermal(
        {
          ...config,
          sources: [{ group: 999, heat: { value: 1, units: 'W/m3' } }],
        },
        mesh,
      ),
    ).toThrow();
    expect(thermalSchema.safeParse({ ...config, physics: 'transient' }).success).toBe(false);
    expect(
      thermalSchema.safeParse({
        ...config,
        materials: [{ group: 1, conductivity: { value: -1, units: 'W/(m.K)' } }],
      }).success,
    ).toBe(false);
    expect(
      thermalSchema.safeParse({
        ...config,
        materials: [{ group: 1, conductivity: { value: 1, units: 'W' } }],
      }).success,
    ).toBe(false);
    expect(() =>
      normalizeThermal({ ...config, materials: [config.materials[0], config.materials[0]] }, mesh),
    ).toThrow();
    expect(() => normalizeThermal(config, { ...mesh, connectedBodies: [[1], [8]] })).toThrow();
  });
  it('generates deterministic numeric-only SIF and rejects conflicting nodal temperatures', () => {
    const normalized = normalizeThermal(config, mesh);
    expect(generateSif(normalized)).toBe(
      generateSif(
        normalizeThermal({ ...config, boundaries: [...config.boundaries].reverse() }, mesh),
      ),
    );
    const sif = generateSif(normalized);
    expect(sif).toContain('Heat Conductivity = 10');
    expect(sif).toContain('Temperature = 400');
    const sourced = normalizeThermal(
      {
        ...config,
        sources: [{ group: 1, heat: { value: 20, units: 'W/m3' } }],
      },
      mesh,
    );
    expect(generateSif(sourced)).toContain('Volumetric Heat Source = 20');
    expect(thermalSchema.safeParse({ ...config, procedure: 'evil' }).success).toBe(false);
    const conflict: Thermal = {
      ...config,
      boundaries: [
        config.boundaries[0]!,
        {
          group: 3,
          kind: 'temperature',
          temperature: { value: 300, units: 'K' },
        },
      ],
    };
    expect(() =>
      validatePrescribedBoundaryNodes(
        '1 2 1 0 303 1 2 3\n2 3 1 0 303 2 3 4',
        conflict.boundaries
          .filter(
            (
              boundary,
            ): boundary is Extract<Thermal['boundaries'][number], { kind: 'temperature' }> =>
              boundary.kind === 'temperature',
          )
          .map((boundary) => ({
            group: boundary.group,
            dofs: { temperature: boundary.temperature.value },
          })),
      ),
    ).toThrow(/Conflicting prescribed values/);
  });
  it('requires explicit transient properties and generates timestep output', () => {
    const transient: Thermal = {
      physics: 'transient-heat-conduction',
      materials: [
        {
          group: 1,
          conductivity: { value: 10, units: 'W/(m.K)' },
          density: { value: 1000, units: 'kg/m3' },
          heatCapacity: { value: 1000, units: 'J/(kg.K)' },
        },
      ],
      sources: [{ group: 1, heat: { value: 100000, units: 'W/m3' } }],
      boundaries: [
        { group: 2, kind: 'insulated' },
        { group: 3, kind: 'insulated' },
      ],
      initialTemperature: { value: 300, units: 'K' },
      time: { timestep: { value: 1, units: 's' }, steps: 10 },
    };
    const normalized = normalizeThermal(transient, mesh);
    const sif = generateSif(normalized);
    expect(sif).toContain('Simulation Type = Transient');
    expect(sif).toContain('Timestep Sizes = 1');
    expect(sif).toContain('Timestep Intervals = 10');
    expect(sif).toContain('Heat Capacity = 1000');
    expect(sif).toContain('Initial Condition = 1');
    expect(sif).toContain('Exec Solver = After Timestep');
    expect(
      thermalSchema.safeParse({
        ...transient,
        materials: [{ ...transient.materials[0], density: undefined }],
      }).success,
    ).toBe(false);
    expect(
      thermalSchema.safeParse({
        ...transient,
        time: { ...transient.time, steps: 10001 },
      }).success,
    ).toBe(false);
  });
});

describe('static structural input contract', () => {
  it('requires explicit elastic properties and generates body assignments', () => {
    const config = staticStructuralSchema.parse({
      physics: 'static-structural',
      materials: [
        {
          group: 1,
          youngsModulus: { value: 210e9, units: 'Pa' },
          poissonRatio: 0.3,
        },
      ],
      boundaries: [
        { group: 2, kind: 'fixed-displacement' },
        {
          group: 3,
          kind: 'uniform-traction',
          traction: [
            { value: 1e6, units: 'N/m2' },
            { value: 0, units: 'N/m2' },
            { value: 0, units: 'N/m2' },
          ],
        },
      ],
    });
    const sif = generateStaticStructuralSif(config);
    expect(sif).toContain('Target Bodies(1) = Integer 1');
    expect(sif).toContain('Youngs Modulus = Real 210000000000');
    expect(sif).toContain('Force 1 = Real 1000000');
    expect(sif).toContain('Procedure = "StressSolve" "StressSolver"');
    expect(
      staticStructuralSchema.safeParse({
        ...config,
        materials: [{ ...config.materials[0], poissonRatio: 0.5 }],
      }).success,
    ).toBe(false);
  });
});

describe('conversion membership', () => {
  const msh =
    '$MeshFormat\n2.2 0 8\n$EndMeshFormat\n$Nodes\n4\n1 0 0 0\n2 1 0 0\n3 0 1 0\n4 0 0 1\n$EndNodes\n$Elements\n5\n1 4 2 1 1 1 2 3 4\n2 2 2 2 1 1 2 3\n3 2 2 2 2 1 2 4\n4 2 2 2 3 1 3 4\n5 2 2 2 4 2 3 4\n$EndElements\n';
  const files = {
    'mesh.header': '4 1 4\n2\n504 1\n303 4',
    'mesh.nodes': '11 -1 0 0 0\n12 -1 1 0 0\n13 -1 0 1 0\n14 -1 0 0 1',
    'mesh.elements': '9 1 504 11 12 13 14',
    'mesh.boundary':
      '1 2 9 0 303 11 12 13\n2 2 9 0 303 11 12 14\n3 2 9 0 303 11 13 14\n4 2 9 0 303 12 13 14',
  };
  const groups = [
    {
      id: 1,
      name: 'volume',
      dimension: 3 as const,
      entities: [1],
      elements: 1,
    },
    {
      id: 2,
      name: 'surface',
      dimension: 2 as const,
      entities: [1, 2, 3, 4],
      elements: 4,
    },
  ];
  it('accepts renumbered nodes but checks IDs, connectivity, counts and boundary parents', () => {
    expect(validateConversion(msh, files, groups)).toMatchObject({
      nodeCount: 4,
      elementCount: 1,
      connectedBodies: [[1]],
      boundaryBodies: { '2': [1] },
    });
    expect(() =>
      validateConversion(msh, { ...files, 'mesh.elements': '9 2 504 11 12 13 14' }, groups),
    ).toThrow();
    expect(() =>
      validateConversion(msh, { ...files, 'mesh.elements': '9 1 504 11 12 13 13' }, groups),
    ).toThrow();
    expect(() =>
      validateConversion(
        msh,
        {
          ...files,
          'mesh.boundary': files['mesh.boundary'].replace('9 0', '0 0'),
        },
        groups,
      ),
    ).toThrow();
    expect(() =>
      validateConversion(msh, files, [{ ...groups[0]!, elements: 2 }, groups[1]!]),
    ).toThrow();
  });
});

describe('result semantics', () => {
  const names =
    'Metadata\n1: min: temperature\n2: max: temperature\n3: mean: temperature\n4: mean: temperature flux_mag\n5: nonlin converged: temperature';
  it('uses named scalar columns, SI units and convergence evidence rather than successful exit alone', () => {
    const result = parseScalars('300 400 350 1.0D+4 1\n', names, ref);
    expect(result.find((s) => s.name === 'heat_flux_magnitude_mean')).toMatchObject({
      value: 10000,
      units: 'W/m2',
      source: ref,
    });
    expect(() => parseScalars('300 400 350 10000 0', names, ref)).toThrow(/convergence/);
    expect(() => parseScalars('300 NaN 350 10000 1', names, ref)).toThrow();
    expect(() => parseScalars('300 400 350 10000 1', '', ref)).toThrow();
    expect(() => inspectVtu('<VTKFile/>')).toThrow();
    expect(() => inspectVtu('<!DOCTYPE VTKFile SYSTEM "file:///secret"><VTKFile/>')).toThrow();
  });
  it('maps every transient scalar row to an explicit timestep and rejects incomplete output', () => {
    const result = parseTransientScalars(
      '300 300 300 0 1\n300.5 300.5 300.5 0 1\n',
      names,
      ref,
      2,
      0.5,
    );
    expect(
      result
        .filter((item) => item.name === 'temperature_mean')
        .map((item) => [item.value, item.time]),
    ).toEqual([
      [300, { value: 0.5, units: 's' }],
      [300.5, { value: 1, units: 's' }],
    ]);
    expect(() => parseTransientScalars('300 300 300 0 1\n', names, ref, 2, 0.5)).toThrow(/samples/);
    expect(() =>
      parseTransientScalars('300 300 300 0 0\n300 300 300 0 1', names, ref, 2, 0.5),
    ).toThrow(/converge/);
  });
  it('converts ordered positive modal eigenvalues into frequencies', () => {
    const result = parseModalEigenvalues(
      '5.235323228288E+007 6.097847189197E+007',
      'Variables in columns of matrix:\n  1: eigen: re value 1\n  2: eigen: re value 2',
      ref,
      2,
    );
    expect(result[0]).toMatchObject({
      name: 'eigenfrequency_mode_1',
      value: Math.sqrt(5.235323228288e7) / (2 * Math.PI),
      units: 'Hz',
      source: ref,
    });
    expect(() => parseModalEigenvalues('-1', '1: eigen: re value 1', ref, 1)).toThrow(/positive/);
    expect(() => parseModalEigenvalues('1', '1: eigen: re value 1', ref, 2)).toThrow(/Expected 2/);
  });
  it('summarizes finite DC nodal potentials without argument spreading', () => {
    const vtu = `<VTKFile type="UnstructuredGrid"><UnstructuredGrid><Piece NumberOfPoints="4" NumberOfCells="1"><PointData><DataArray Name="potential" format="ascii">-2 1 3 4</DataArray></PointData><Points><DataArray format="ascii">0 0 0 1 0 0 0 1 0 0 0 1</DataArray></Points><Cells><DataArray Name="connectivity" format="ascii">0 1 2 3</DataArray><DataArray Name="offsets" format="ascii">4</DataArray><DataArray Name="types" format="ascii">10</DataArray></Cells></Piece></UnstructuredGrid></VTKFile>`;
    expect(parseDcPotentialMetrics(parseVtu(vtu), ref).map((item) => item.value)).toEqual([
      -2, 4, 1.5,
    ]);
    expect(() => parseDcPotentialMetrics(parseVtu(vtu.replace('-2 1', 'NaN 1')), ref)).toThrow();
  });
  it('summarizes only explicit structural VTU arrays and rejects malformed values', () => {
    const vtu = (pointData: string, cellData = '') =>
      `<VTKFile type="UnstructuredGrid"><UnstructuredGrid><Piece NumberOfPoints="4" NumberOfCells="1"><PointData>${pointData}</PointData><CellData>${cellData}</CellData><Points><DataArray format="ascii">0 0 0 1 0 0 0 1 0 0 0 1</DataArray></Points><Cells><DataArray Name="connectivity" format="ascii">0 1 2 3</DataArray><DataArray Name="offsets" format="ascii">4</DataArray><DataArray Name="types" format="ascii">10</DataArray></Cells></Piece></UnstructuredGrid></VTKFile>`;
    const result = parseStaticStructuralVtuMetrics(
      parseVtu(
        vtu(
          '<DataArray Name="displacement" NumberOfComponents="3" format="ascii">0 0 0 3 0 0 0 4 0 0 0 0</DataArray><DataArray Name="stress_xx" NumberOfComponents="1" format="ascii">-2 2 4 8</DataArray><DataArray Name="vonmises" NumberOfComponents="1" format="ascii">1 2 3 4</DataArray>',
        ),
      ),
      ref,
    );
    expect(result.map((x) => x.name)).toEqual([
      'displacement_magnitude_min',
      'displacement_magnitude_max',
      'displacement_magnitude_mean',
      'stress_xx_min',
      'stress_xx_max',
      'stress_xx_mean',
      'von_mises_stress_max',
    ]);
    expect(result[1]).toMatchObject({ value: 4, units: 'm', source: ref });
    expect(result[4]).toMatchObject({ value: 8, units: 'Pa' });
    expect(() =>
      parseStaticStructuralVtuMetrics(
        parseVtu(
          vtu(
            '<DataArray Name="displacement" NumberOfComponents="3" format="ascii">0 0 0</DataArray>',
          ),
        ),
        ref,
      ),
    ).toThrow();
    expect(() =>
      parseStaticStructuralVtuMetrics(
        parseVtu(
          vtu(
            '<DataArray Name="displacement" NumberOfComponents="3" format="ascii">0 0 0 1 0 0 0 1 0 0 0 1</DataArray>',
          ),
        ),
        ref,
      ),
    ).toThrow();
    expect(() =>
      parseStaticStructuralVtuMetrics(
        parseVtu(
          vtu(
            '<DataArray Name="displacement" NumberOfComponents="3" format="ascii">0 0 0 1 0 0 0 1 0 NaN 0 1</DataArray><DataArray Name="stress_xx" NumberOfComponents="1" format="ascii">1 2 3 4</DataArray>',
          ),
        ),
        ref,
      ),
    ).toThrow();
  });
});
