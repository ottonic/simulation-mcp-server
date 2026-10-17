import { requireThat } from './errors.js';
import type { ArtifactRef } from './schemas.js';

/**
 * Parse Elmer's `index: name` scalar header lines into a lowercase-name to
 * zero-based-column map. Header lines that do not match are ignored.
 */
function scalarColumns(names: string): Map<string, number> {
  const columns = new Map<string, number>();
  for (const line of names.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    const [, index, name] = match;
    if (index !== undefined && name !== undefined) {
      columns.set(name.toLowerCase(), Number(index) - 1);
    }
  }
  return columns;
}

export function parseScalars(data: string, names: string, source: ArtifactRef) {
  const lines = data
    .trim()
    .split(/\r?\n/)
    .filter((s) => s.trim() && !s.trim().startsWith('#'));
  requireThat(lines.length > 0, 'malformed_results', 'Missing scalar data.');
  const values = lines
    .at(-1)!
    .trim()
    .split(/\s+/)
    .map((s) => Number(s.replace(/[dD]/, 'e')));
  requireThat(values.every(Number.isFinite), 'malformed_results', 'Nonfinite scalar output.');
  const columns = scalarColumns(names);
  const value = (name: string) => {
    const index = columns.get(name);
    requireThat(index !== undefined, 'malformed_results', `Missing scalar column: ${name}.`);
    const raw = values[index];
    requireThat(
      raw !== undefined && Number.isFinite(raw),
      'malformed_results',
      `Missing scalar column: ${name}.`,
    );
    return raw;
  };
  requireThat(
    value('nonlin converged: temperature') > 0,
    'solver_failed',
    'Heat solver did not report nonlinear convergence.',
  );
  return [
    {
      name: 'temperature_min',
      value: value('min: temperature'),
      units: 'K',
      method: 'Elmer SaveScalars nodal minimum',
    },
    {
      name: 'temperature_max',
      value: value('max: temperature'),
      units: 'K',
      method: 'Elmer SaveScalars nodal maximum',
    },
    {
      name: 'temperature_mean',
      value: value('mean: temperature'),
      units: 'K',
      method: 'Elmer SaveScalars unweighted nodal mean (not volume mean)',
    },
    {
      name: 'heat_flux_magnitude_mean',
      value: value('mean: temperature flux_mag'),
      units: 'W/m2',
      method:
        'Elmer FluxSolver projected magnitude; SaveScalars unweighted nodal mean (not integrated heat flow)',
    },
  ].map((s) => ({ ...s, source }));
}

export function parseTransientScalars(
  data: string,
  names: string,
  source: ArtifactRef,
  steps: number,
  timestep: number,
) {
  const lines = data
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('#'));
  requireThat(
    lines.length === steps,
    'malformed_results',
    `Expected ${steps} transient scalar samples, received ${lines.length}.`,
  );
  const columns = scalarColumns(names);
  const positions = [...columns.values()].sort((a, b) => a - b);
  requireThat(
    positions.every((position, expected) => position === expected),
    'malformed_results',
    'Transient scalar columns must be unique and contiguous.',
  );
  const index = (name: string) => {
    const value = columns.get(name);
    requireThat(
      value !== undefined,
      'malformed_results',
      `Missing transient scalar column: ${name}.`,
    );
    return value;
  };
  const indexes = {
    min: index('min: temperature'),
    max: index('max: temperature'),
    mean: index('mean: temperature'),
    flux: index('mean: temperature flux_mag'),
    converged: index('nonlin converged: temperature'),
  };
  return lines.flatMap((line, sample) => {
    const values = line
      .trim()
      .split(/\s+/)
      .map((value) => Number(value.replace(/[dD]/, 'e')));
    requireThat(
      values.length === columns.size && values.every(Number.isFinite),
      'malformed_results',
      `Malformed transient scalar sample ${sample + 1}.`,
    );
    requireThat(
      values[indexes.converged]! > 0,
      'solver_failed',
      `Heat solver did not converge at transient sample ${sample + 1}.`,
    );
    const time = (sample + 1) * timestep;
    return [
      {
        name: 'temperature_min',
        value: values[indexes.min]!,
        units: 'K',
        method: 'Elmer SaveScalars nodal minimum',
        source,
        time: { value: time, units: 's' },
      },
      {
        name: 'temperature_max',
        value: values[indexes.max]!,
        units: 'K',
        method: 'Elmer SaveScalars nodal maximum',
        source,
        time: { value: time, units: 's' },
      },
      {
        name: 'temperature_mean',
        value: values[indexes.mean]!,
        units: 'K',
        method: 'Elmer SaveScalars unweighted nodal mean (not volume mean)',
        source,
        time: { value: time, units: 's' },
      },
      {
        name: 'heat_flux_magnitude_mean',
        value: values[indexes.flux]!,
        units: 'W/m2',
        method:
          'Elmer FluxSolver projected magnitude; SaveScalars unweighted nodal mean (not integrated heat flow)',
        source,
        time: { value: time, units: 's' },
      },
    ];
  });
}

export function parseModalEigenvalues(
  data: string,
  names: string,
  source: ArtifactRef,
  modes: number,
) {
  const rows = data
    .trim()
    .split(/\r?\n/)
    .filter((row) => row.trim());
  requireThat(rows.length === 1, 'malformed_results', 'Expected one modal eigenvalue row.');
  const values = rows[0]!
    .trim()
    .split(/\s+/)
    .map((value) => Number(value.replace(/[dD]/, 'e')));
  requireThat(
    values.length === modes && values.every(Number.isFinite),
    'malformed_results',
    `Expected ${modes} finite modal eigenvalues.`,
  );
  const columns = scalarColumns(names);
  requireThat(
    columns.size === modes &&
      [...columns.values()].sort((a, b) => a - b).every((column, index) => column === index),
    'malformed_results',
    `Expected exactly ${modes} ordered modal eigenvalue columns.`,
  );
  return Array.from({ length: modes }, (_, index) => {
    const column = columns.get(`eigen: re value ${index + 1}`);
    requireThat(
      column !== undefined && column === index,
      'malformed_results',
      `Missing or misordered modal eigenvalue ${index + 1}.`,
    );
    const eigenvalue = values[column]!;
    requireThat(
      eigenvalue > 0,
      'malformed_results',
      `Modal eigenvalue ${index + 1} must be positive.`,
    );
    return {
      name: `eigenfrequency_mode_${index + 1}`,
      value: Math.sqrt(eigenvalue) / (2 * Math.PI),
      units: 'Hz',
      method: `Elmer ElasticSolve eigenvalue ${index + 1}; sqrt(lambda)/(2*pi)`,
      source,
    };
  });
}

export function parseDcPotentialMetrics(vtu: ParsedVtu, source: ArtifactRef) {
  const potential = pointField(vtu, 'potential');
  requireThat(
    potential.components === 1 && potential.values.length === vtu.pointCount,
    'malformed_results',
    'Potential array must contain one finite value per mesh point.',
  );
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const value of potential.values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }
  const mean = sum / potential.values.length;
  requireThat(Number.isFinite(mean), 'malformed_results', 'Invalid potential mean.');
  return [
    {
      name: 'potential_min',
      value: min,
      units: 'V',
      method: 'VTU nodal potential minimum',
      source,
    },
    {
      name: 'potential_max',
      value: max,
      units: 'V',
      method: 'VTU nodal potential maximum',
      source,
    },
    {
      name: 'potential_mean',
      value: mean,
      units: 'V',
      method: 'VTU unweighted nodal potential mean (not volume mean)',
      source,
    },
  ];
}

export function parseLaminarFlowVtuMetrics(vtu: ParsedVtu, source: ArtifactRef, time?: number) {
  const velocity = pointField(vtu, 'velocity');
  requireThat(
    velocity.components === 3 && velocity.values.length === 3 * vtu.pointCount,
    'malformed_results',
    'Velocity array must contain three finite values per mesh point.',
  );
  const pressure = pointField(vtu, 'pressure');
  requireThat(
    pressure.components === 1 && pressure.values.length === vtu.pointCount,
    'malformed_results',
    'Pressure array must contain one finite value per mesh point.',
  );
  let speedMax = 0;
  let xVelocityMax = -Infinity;
  let pressureMin = Infinity;
  let pressureMax = -Infinity;
  for (let point = 0; point < vtu.pointCount; point++) {
    const x = velocity.values[3 * point]!;
    const y = velocity.values[3 * point + 1]!;
    const z = velocity.values[3 * point + 2]!;
    speedMax = Math.max(speedMax, Math.hypot(x, y, z));
    xVelocityMax = Math.max(xVelocityMax, x);
    pressureMin = Math.min(pressureMin, pressure.values[point]!);
    pressureMax = Math.max(pressureMax, pressure.values[point]!);
  }
  const stamp = time === undefined ? {} : { time: { value: time, units: 's' as const } };
  return [
    {
      name: 'velocity_magnitude_max',
      value: speedMax,
      units: 'm/s',
      method: 'VTU maximum nodal velocity magnitude; not a section mean',
      source,
      ...stamp,
    },
    {
      name: 'velocity_x_max',
      value: xVelocityMax,
      units: 'm/s',
      method: 'VTU maximum nodal x velocity in step-world-si frame',
      source,
      ...stamp,
    },
    {
      name: 'pressure_min',
      value: pressureMin,
      units: 'Pa',
      method: 'VTU minimum nodal pressure; not a section mean',
      source,
      ...stamp,
    },
    {
      name: 'pressure_max',
      value: pressureMax,
      units: 'Pa',
      method: 'VTU maximum nodal pressure; not a section mean',
      source,
      ...stamp,
    },
  ];
}

export function parseLaminarFlowConvergence(
  stdout: string,
  mode: 'steady' | 'transient',
  steps: number,
  tolerance = 1e-7,
) {
  const changes = (text: string) =>
    [
      ...text.matchAll(
        /ComputeChange:\s*NS\s*\(ITER=\s*(\d+)\)\s*\(NRM,RELC\):\s*\(\s*([+\-\d.EeDd]+)\s+([+\-\d.EeDd]+)\s*\)\s*::\s*navier-stokes/gi,
      ),
    ].map((match) => ({
      iteration: Number(match[1]),
      norm: Number(match[2]!.replace(/[dD]/g, 'e')),
      relativeChange: Number(match[3]!.replace(/[dD]/g, 'e')),
    }));
  const requireConverged = (block: string, label: string) => {
    const history = changes(block);
    const final = history.at(-1);
    requireThat(
      final &&
        Number.isFinite(final.norm) &&
        Number.isFinite(final.relativeChange) &&
        final.norm >= 0 &&
        final.relativeChange >= 0 &&
        final.relativeChange <= tolerance,
      'solver_failed',
      `Flow nonlinear convergence was not established for ${label}.`,
    );
    return final;
  };
  if (mode === 'steady') {
    const final = requireConverged(stdout, 'steady solution');
    return {
      samples: 1,
      finalIteration: final.iteration,
      maximumRelativeChange: final.relativeChange,
    };
  }
  const markers = [...stdout.matchAll(/MAIN:\s*Time:\s*(\d+)\/(\d+)/g)];
  requireThat(
    markers.length === steps,
    'malformed_results',
    `Expected ${steps} transient flow timesteps, received ${markers.length}.`,
  );
  let maxRelativeChange = 0;
  let finalIteration = 0;
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index]!;
    requireThat(
      Number(marker[1]) === index + 1 && Number(marker[2]) === steps,
      'malformed_results',
      'Transient flow timestep markers are incomplete or out of order.',
    );
    const start = marker.index! + marker[0].length;
    const end = markers[index + 1]?.index ?? stdout.length;
    const final = requireConverged(stdout.slice(start, end), `timestep ${index + 1}`);
    maxRelativeChange = Math.max(maxRelativeChange, final.relativeChange);
    finalIteration = Math.max(finalIteration, final.iteration);
  }
  return {
    samples: markers.length,
    finalIteration,
    maximumRelativeChange: maxRelativeChange,
  };
}

export type VtuField = {
  name: string;
  components: number;
  association: 'point' | 'cell';
  units?: string;
  values: number[];
};
export type ParsedVtu = {
  pointCount: number;
  cellCount: number;
  points: number[];
  connectivity: number[];
  offsets: number[];
  types: number[];
  pointFields: VtuField[];
  cellFields: VtuField[];
  fields: {
    name: string;
    components: number;
    association: string;
    units?: string;
  }[];
  frame: string;
  coordinateUnits: 'm';
};

function fieldUnits(name: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower === 'temperature') return 'K';
  if (lower.startsWith('temperature flux')) return 'W/m2';
  if (lower === 'displacement') return 'm';
  if (lower === 'stress' || lower === 'vonmises' || lower.startsWith('stress_')) return 'Pa';
  if (lower === 'strain') return '1';
  if (lower === 'potential') return 'V';
  if (lower === 'velocity') return 'm/s';
  if (lower === 'pressure') return 'Pa';
  return undefined;
}

// Narrow validator for the ASCII VTU emitted by the generated SIF, not a
// general XML/VTK reader. Reject external entities, appended/binary payloads.
// Geometry and field arrays are parsed once; callers derive descriptors and
// metrics from the returned structure instead of re-scanning the text.
export function parseVtu(
  text: string,
  requiredPointField?: { name: string; components: number },
): ParsedVtu {
  requireThat(
    !/<!DOCTYPE|<!ENTITY|<AppendedData/i.test(text) &&
      /<VTKFile\b[^>]*type="UnstructuredGrid"/.test(text) &&
      /<\/VTKFile>\s*$/.test(text),
    'malformed_results',
    'Expected complete ASCII unstructured-grid VTU.',
  );
  // Match the attributes independently: VTU does not guarantee attribute order.
  const pieceTag = text.match(/<Piece\b[^>]*>/)?.[0];
  const points = Number(pieceTag?.match(/\bNumberOfPoints="(\d+)"/)?.[1]);
  const cellCount = Number(pieceTag?.match(/\bNumberOfCells="(\d+)"/)?.[1]);
  requireThat(
    Number.isInteger(points) && points > 0 && Number.isInteger(cellCount) && cellCount > 0,
    'malformed_results',
    'Empty/malformed VTU piece.',
  );
  const arrayValues = (array: RegExpMatchArray | undefined | null) => {
    const [, format, body] = array ?? [];
    requireThat(
      format !== undefined && body !== undefined && /\bformat="ascii"/i.test(format),
      'malformed_results',
      'Missing ASCII VTU geometry array.',
    );
    const values = body.trim().split(/\s+/).map(Number);
    requireThat(
      values.length > 0 && values.every(Number.isFinite),
      'malformed_results',
      'Nonfinite VTU geometry.',
    );
    return values;
  };
  const pointBlock = text.match(/<Points\b[^>]*>([\s\S]*?)<\/Points>/)?.[1];
  const xyz = arrayValues(pointBlock?.match(/<DataArray\b([^>]*)>([\s\S]*?)<\/DataArray>/));
  requireThat(xyz.length === 3 * points, 'malformed_results', 'VTU point count mismatch.');
  const cellBlock = text.match(/<Cells\b[^>]*>([\s\S]*?)<\/Cells>/)?.[1];
  const cells = (name: string) =>
    arrayValues(
      cellBlock?.match(
        new RegExp(`<DataArray\\b([^>]*Name="${name}"[^>]*)>([\\s\\S]*?)<\\/DataArray>`),
      ),
    );
  const connectivity = cells('connectivity'),
    offsets = cells('offsets'),
    types = cells('types');
  requireThat(
    connectivity.every((n) => Number.isInteger(n) && n >= 0 && n < points),
    'malformed_results',
    'VTU connectivity references unknown points.',
  );
  requireThat(
    offsets.length === cellCount &&
      types.length === offsets.length &&
      offsets.at(-1) === connectivity.length,
    'malformed_results',
    'VTU cell counts mismatch.',
  );
  let previous = 0;
  offsets.forEach((offset, i) => {
    const size = types[i] === 10 ? 4 : types[i] === 5 ? 3 : undefined;
    requireThat(
      size && offset - previous === size,
      'malformed_results',
      'Expected linear tetrahedra/triangles in VTU.',
    );
    previous = offset;
  });
  const pointFields: VtuField[] = [];
  const cellFields: VtuField[] = [];
  const fields: ParsedVtu['fields'] = [];
  for (const [association, block, sink] of [
    ['point', text.match(/<PointData\b[^>]*>([\s\S]*?)<\/PointData>/)?.[1], pointFields],
    ['cell', text.match(/<CellData\b[^>]*>([\s\S]*?)<\/CellData>/)?.[1], cellFields],
  ] as const) {
    for (const array of (block ?? '').matchAll(/<DataArray\b([^>]*)>([\s\S]*?)<\/DataArray>/g)) {
      const [, attributes, body] = array;
      requireThat(
        attributes !== undefined && body !== undefined,
        'malformed_results',
        'Expected named ASCII VTU field.',
      );
      const name = attributes.match(/\bName="([^"]+)"/)?.[1];
      requireThat(
        name !== undefined && /\bformat="ascii"/i.test(attributes),
        'malformed_results',
        'Expected named ASCII VTU field.',
      );
      const components = Number(attributes.match(/NumberOfComponents="(\d+)"/)?.[1] ?? 1);
      const values = body.trim().split(/\s+/).map(Number);
      requireThat(
        values.every(Number.isFinite) &&
          values.length === components * (association === 'point' ? points : cellCount),
        'malformed_results',
        'Invalid VTU field length/values.',
      );
      const units = fieldUnits(name);
      sink.push({
        name,
        components,
        association,
        ...(units ? { units } : {}),
        values,
      });
      fields.push({
        name,
        components,
        association,
        ...(units ? { units } : {}),
      });
    }
  }
  if (requiredPointField)
    requireThat(
      pointFields.some(
        (f) =>
          f.name.toLowerCase() === requiredPointField.name.toLowerCase() &&
          f.components === requiredPointField.components,
      ),
      'malformed_results',
      `Required point field '${requiredPointField.name}' is missing or has the wrong component count.`,
    );
  return {
    pointCount: points,
    cellCount,
    points: xyz,
    connectivity,
    offsets,
    types,
    pointFields,
    cellFields,
    fields,
    frame: 'step-world-si',
    coordinateUnits: 'm',
  };
}

export function describeVtu(vtu: ParsedVtu) {
  return {
    pointCount: vtu.pointCount,
    cellCount: vtu.cellCount,
    fields: vtu.fields,
    frame: vtu.frame,
    coordinateUnits: vtu.coordinateUnits,
  };
}

export function inspectVtu(
  text: string,
  requiredPointField = { name: 'temperature', components: 1 },
) {
  return describeVtu(parseVtu(text, requiredPointField));
}

// Returns the validated nodal field, failing when it is absent.
export function pointField(vtu: ParsedVtu, name: string): VtuField {
  const lower = name.toLowerCase();
  const field = vtu.pointFields.find((f) => f.name.toLowerCase() === lower);
  requireThat(field, 'malformed_results', `Missing nodal ${name} field.`);
  return field;
}

// Structural summaries are isolated from solver scalars: only explicitly
// emitted nodal displacement and stress arrays are summarized here.
export function parseStaticStructuralVtuMetrics(vtu: ParsedVtu, source: ArtifactRef) {
  const displacement = pointField(vtu, 'displacement');
  requireThat(
    displacement.components === 3 && displacement.values.length === 3 * vtu.pointCount,
    'malformed_results',
    'Displacement array must contain three finite values per mesh point.',
  );
  const magnitude: number[] = [];
  for (let i = 0; i < displacement.values.length; i += 3)
    magnitude.push(
      Math.hypot(displacement.values[i]!, displacement.values[i + 1]!, displacement.values[i + 2]!),
    );
  const summaries = (
    name: string,
    values: number[],
    units: string,
    method: string,
    modes: string[],
  ) => {
    requireThat(
      values.length > 0 && values.every(Number.isFinite),
      'malformed_results',
      `Invalid ${name} summary values.`,
    );
    let min = Infinity,
      max = -Infinity,
      sum = 0;
    for (const value of values) {
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
    }
    const mean = sum / values.length;
    requireThat(Number.isFinite(mean), 'malformed_results', `Invalid ${name} mean.`);
    return modes.map((mode) => ({
      name: `${name}_${mode}`,
      value: mode === 'min' ? min : mode === 'max' ? max : mean,
      units,
      method: `${method} ${mode}`,
      source,
    }));
  };
  const stress = [...vtu.pointFields, ...vtu.cellFields].find(
    (field) => field.name.toLowerCase() === 'stress_xx',
  );
  requireThat(stress, 'malformed_results', 'Missing stress_xx array.');
  const stressCount = stress.association === 'point' ? vtu.pointCount : vtu.cellCount;
  requireThat(
    stress.components === 1 &&
      stress.values.length === stressCount &&
      stress.values.length > 0 &&
      stress.values.every(Number.isFinite),
    'malformed_results',
    'Invalid stress_xx array.',
  );
  const result = [
    ...summaries(
      'displacement_magnitude',
      magnitude,
      'm',
      'VTU point displacement Euclidean magnitude; unweighted nodal',
      ['min', 'max', 'mean'],
    ),
    ...summaries(
      'stress_xx',
      stress.values,
      'Pa',
      `VTU ${stress.association} stress_xx; unweighted sample`,
      ['min', 'max', 'mean'],
    ),
  ];
  const vm = [...vtu.pointFields, ...vtu.cellFields].find(
    (field) => field.name.toLowerCase() === 'vonmises',
  );
  if (vm) {
    const vmCount = vm.association === 'point' ? vtu.pointCount : vtu.cellCount;
    requireThat(
      vm.components === 1 &&
        vm.values.length === vmCount &&
        vm.values.length > 0 &&
        vm.values.every(Number.isFinite),
      'malformed_results',
      'Invalid von Mises array.',
    );
    result.push(
      ...summaries(
        'von_mises_stress',
        vm.values,
        'Pa',
        `VTU ${vm.association} von Mises stress; unweighted sample`,
        ['max'],
      ),
    );
  }
  return result;
}
