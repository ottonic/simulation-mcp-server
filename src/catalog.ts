import { OBSERVATION_QUANTITIES } from './schemas.js';
import { ERROR_CODES } from './errors.js';

// Discovery is generated from this catalog so capability tokens, help, and
// examples cannot drift apart. Tests assert alignment with the study schema.
export type FieldHelp = {
  field: string;
  units: string;
  required: boolean;
  notes?: string;
};
export type BoundaryHelp = { kind: string; fields: FieldHelp[] };
export type ObservationHelp = {
  quantity: string;
  units: string;
  time: 'unsupported' | 'optional' | 'timestep-aligned' | 'transient-only';
  mode: boolean;
};
export type PhysicsHelp = {
  kind: string;
  available: boolean;
  reason?: string;
  materialModels: string[];
  boundaryKinds: string[];
  quantities: string[];
  controls?: string[];
  materials: FieldHelp[];
  boundaries: BoundaryHelp[];
  regime?: { modes: string[]; notes: string[] };
  notes?: string[];
  observations: ObservationHelp[];
  examples: Record<string, unknown>[];
};

const WORKFLOW = [
  'inspect_model',
  'query_model',
  'validate_study',
  'prepare_study',
  'run_study',
  'inspect_job',
  'list_jobs',
  'query_results',
  'cancel_job',
];

const thermalBoundaries: BoundaryHelp[] = [
  {
    kind: 'temperature',
    fields: [{ field: 'temperature', units: 'K', required: true }],
  },
  {
    kind: 'inward-heat-flux',
    fields: [{ field: 'flux', units: 'W/m2', required: true }],
  },
  { kind: 'insulated', fields: [] },
];
const thermalObservations: ObservationHelp[] = [
  { quantity: 'temperature_min', units: 'K', time: 'optional', mode: false },
  { quantity: 'temperature_max', units: 'K', time: 'optional', mode: false },
  { quantity: 'temperature_mean', units: 'K', time: 'optional', mode: false },
  {
    quantity: 'heat_flux_magnitude_mean',
    units: 'W/m2',
    time: 'optional',
    mode: false,
  },
];

export const PHYSICS_CATALOG: PhysicsHelp[] = [
  {
    kind: 'steady-thermal',
    available: true,
    materialModels: ['isotropic-constant'],
    boundaryKinds: ['temperature', 'inward-heat-flux', 'insulated'],
    quantities: [
      'temperature_min',
      'temperature_max',
      'temperature_mean',
      'heat_flux_magnitude_mean',
    ],
    materials: [{ field: 'conductivity', units: 'W/(m.K)', required: true }],
    boundaries: thermalBoundaries,
    observations: thermalObservations.map((observation) => ({
      ...observation,
      time: 'unsupported' as const,
    })),
    examples: [
      {
        kind: 'steady-thermal',
        defaultBoundary: 'insulated',
        materials: [{ selection: 'solid', conductivity: { value: 10, units: 'W/(m.K)' } }],
        sources: [],
        boundaries: [
          {
            selection: 'hot',
            kind: 'temperature',
            temperature: { value: 400, units: 'K' },
          },
          {
            selection: 'cold',
            kind: 'temperature',
            temperature: { value: 300, units: 'K' },
          },
          { selection: 'sides', kind: 'insulated' },
        ],
      },
    ],
  },
  {
    kind: 'transient-thermal',
    available: true,
    materialModels: ['isotropic-constant'],
    boundaryKinds: ['temperature', 'inward-heat-flux', 'insulated'],
    quantities: [
      'temperature_min',
      'temperature_max',
      'temperature_mean',
      'heat_flux_magnitude_mean',
    ],
    controls: ['uniform-initial-temperature', 'constant-timestep', 'up-to-10000-steps'],
    materials: [
      { field: 'conductivity', units: 'W/(m.K)', required: true },
      { field: 'density', units: 'kg/m3', required: true },
      { field: 'heatCapacity', units: 'J/(kg.K)', required: true },
    ],
    boundaries: thermalBoundaries,
    regime: {
      modes: ['transient'],
      notes: [
        'Fixed timestep and step count; observations may select a timestep-aligned time in seconds.',
      ],
    },
    observations: thermalObservations,
    examples: [
      {
        kind: 'transient-thermal',
        defaultBoundary: 'insulated',
        materials: [
          {
            selection: 'solid',
            conductivity: { value: 10, units: 'W/(m.K)' },
            density: { value: 7800, units: 'kg/m3' },
            heatCapacity: { value: 500, units: 'J/(kg.K)' },
          },
        ],
        sources: [],
        boundaries: [
          {
            selection: 'hot',
            kind: 'temperature',
            temperature: { value: 400, units: 'K' },
          },
          { selection: 'sides', kind: 'insulated' },
        ],
        initialTemperature: { value: 300, units: 'K' },
        time: { timestep: { value: 1, units: 's' }, steps: 10 },
      },
    ],
  },
  {
    kind: 'static-structural',
    available: true,
    materialModels: ['isotropic-linear-elastic'],
    boundaryKinds: ['fixed-displacement', 'prescribed-displacement', 'uniform-traction', 'free'],
    quantities: [
      'displacement_magnitude_min',
      'displacement_magnitude_max',
      'displacement_magnitude_mean',
      'stress_xx_min',
      'stress_xx_max',
      'stress_xx_mean',
      'von_mises_stress_max',
    ],
    controls: ['small-strain', 'linear-elastic', 'static'],
    materials: [
      { field: 'youngsModulus', units: 'Pa', required: true },
      {
        field: 'poissonRatio',
        units: '1',
        required: true,
        notes: '(-1, 0.45)',
      },
    ],
    boundaries: [
      { kind: 'fixed-displacement', fields: [] },
      {
        kind: 'prescribed-displacement',
        fields: [
          {
            field: 'displacement',
            units: 'm',
            required: true,
            notes: '[x, y, z]',
          },
        ],
      },
      {
        kind: 'uniform-traction',
        fields: [
          {
            field: 'traction',
            units: 'N/m2',
            required: true,
            notes: '[x, y, z]',
          },
        ],
      },
      { kind: 'free', fields: [] },
    ],
    observations: [
      {
        quantity: 'displacement_magnitude_min',
        units: 'm',
        time: 'unsupported',
        mode: false,
      },
      {
        quantity: 'displacement_magnitude_max',
        units: 'm',
        time: 'unsupported',
        mode: false,
      },
      {
        quantity: 'displacement_magnitude_mean',
        units: 'm',
        time: 'unsupported',
        mode: false,
      },
      {
        quantity: 'stress_xx_min',
        units: 'Pa',
        time: 'unsupported',
        mode: false,
      },
      {
        quantity: 'stress_xx_max',
        units: 'Pa',
        time: 'unsupported',
        mode: false,
      },
      {
        quantity: 'stress_xx_mean',
        units: 'Pa',
        time: 'unsupported',
        mode: false,
      },
      {
        quantity: 'von_mises_stress_max',
        units: 'Pa',
        time: 'unsupported',
        mode: false,
      },
    ],
    examples: [
      {
        kind: 'static-structural',
        materials: [
          {
            selection: 'solid',
            youngsModulus: { value: 210000000000, units: 'Pa' },
            poissonRatio: 0.3,
          },
        ],
        boundaries: [
          { selection: 'fixed', kind: 'fixed-displacement' },
          {
            selection: 'pulled',
            kind: 'uniform-traction',
            traction: [
              { value: 0, units: 'N/m2' },
              { value: 0, units: 'N/m2' },
              { value: 1000000, units: 'N/m2' },
            ],
          },
          { selection: 'free_sides', kind: 'free' },
        ],
      },
    ],
  },
  {
    kind: 'modal',
    available: true,
    materialModels: ['isotropic-linear-elastic-with-density'],
    boundaryKinds: ['fixed-displacement', 'free'],
    quantities: ['eigenfrequency'],
    controls: ['undamped', 'unloaded', 'up-to-20-modes'],
    materials: [
      { field: 'youngsModulus', units: 'Pa', required: true },
      {
        field: 'poissonRatio',
        units: '1',
        required: true,
        notes: '(-1, 0.45)',
      },
      { field: 'density', units: 'kg/m3', required: true },
    ],
    boundaries: [
      { kind: 'fixed-displacement', fields: [] },
      { kind: 'free', fields: [] },
    ],
    regime: {
      modes: ['modes: 1..20'],
      notes: ['Undamped, unloaded eigenfrequencies only.'],
    },
    observations: [
      {
        quantity: 'eigenfrequency',
        units: 'Hz',
        time: 'unsupported',
        mode: true,
      },
    ],
    examples: [
      {
        kind: 'modal',
        materials: [
          {
            selection: 'solid',
            youngsModulus: { value: 210000000000, units: 'Pa' },
            poissonRatio: 0.3,
            density: { value: 7800, units: 'kg/m3' },
          },
        ],
        boundaries: [
          { selection: 'fixed', kind: 'fixed-displacement' },
          { selection: 'free_sides', kind: 'free' },
        ],
        modes: 6,
      },
    ],
  },
  {
    kind: 'dc-conduction',
    available: true,
    materialModels: ['isotropic-constant-electrical-conductivity'],
    boundaryKinds: ['potential', 'insulated'],
    quantities: ['potential_min', 'potential_max', 'potential_mean'],
    controls: ['steady-state', 'uncoupled'],
    materials: [{ field: 'electricalConductivity', units: 'S/m', required: true }],
    boundaries: [
      {
        kind: 'potential',
        fields: [{ field: 'potential', units: 'V', required: true }],
      },
      { kind: 'insulated', fields: [] },
    ],
    observations: [
      {
        quantity: 'potential_min',
        units: 'V',
        time: 'unsupported',
        mode: false,
      },
      {
        quantity: 'potential_max',
        units: 'V',
        time: 'unsupported',
        mode: false,
      },
      {
        quantity: 'potential_mean',
        units: 'V',
        time: 'unsupported',
        mode: false,
      },
    ],
    examples: [
      {
        kind: 'dc-conduction',
        materials: [
          {
            selection: 'solid',
            electricalConductivity: { value: 1000000, units: 'S/m' },
          },
        ],
        boundaries: [
          {
            selection: 'positive',
            kind: 'potential',
            potential: { value: 10, units: 'V' },
          },
          {
            selection: 'ground',
            kind: 'potential',
            potential: { value: 0, units: 'V' },
          },
          { selection: 'sides', kind: 'insulated' },
        ],
      },
    ],
  },
  {
    kind: 'laminar-flow',
    available: true,
    materialModels: ['incompressible-Newtonian-constant-density-viscosity'],
    boundaryKinds: ['pressure', 'no-slip'],
    quantities: ['velocity_magnitude_max', 'velocity_x_max', 'pressure_min', 'pressure_max'],
    controls: [
      'steady-or-transient',
      'first-order-BDF',
      'quiescent-transient-initial-condition',
      'laminar-only',
    ],
    materials: [
      { field: 'density', units: 'kg/m3', required: true },
      { field: 'dynamicViscosity', units: 'Pa.s', required: true },
    ],
    boundaries: [
      {
        kind: 'pressure',
        fields: [{ field: 'pressure', units: 'Pa', required: true }],
      },
      { kind: 'no-slip', fields: [] },
    ],
    regime: {
      modes: ['steady', 'transient'],
      notes: [
        'Transient requires first-order BDF, a constant timestep, and explicit quiescent initial velocity as three quantities, e.g. [{ value: 0, units: "m/s" }] x3.',
      ],
    },
    notes: [
      'Steady flow rejects observation `time`; transient observations may set a timestep-aligned `time` in seconds.',
      'A `no-slip` boundary takes no fields; a `pressure` boundary requires `pressure` in Pa.',
    ],
    observations: [
      {
        quantity: 'velocity_magnitude_max',
        units: 'm/s',
        time: 'transient-only',
        mode: false,
      },
      {
        quantity: 'velocity_x_max',
        units: 'm/s',
        time: 'transient-only',
        mode: false,
      },
      {
        quantity: 'pressure_min',
        units: 'Pa',
        time: 'transient-only',
        mode: false,
      },
      {
        quantity: 'pressure_max',
        units: 'Pa',
        time: 'transient-only',
        mode: false,
      },
    ],
    examples: [
      {
        kind: 'laminar-flow',
        materials: [
          {
            selection: 'fluid',
            density: { value: 1000, units: 'kg/m3' },
            dynamicViscosity: { value: 0.001, units: 'Pa.s' },
          },
        ],
        boundaries: [
          {
            selection: 'inlet',
            kind: 'pressure',
            pressure: { value: 100, units: 'Pa' },
          },
          {
            selection: 'outlet',
            kind: 'pressure',
            pressure: { value: 0, units: 'Pa' },
          },
          { selection: 'walls', kind: 'no-slip' },
        ],
        regime: { mode: 'steady' },
      },
      {
        kind: 'laminar-flow',
        materials: [
          {
            selection: 'fluid',
            density: { value: 1000, units: 'kg/m3' },
            dynamicViscosity: { value: 0.001, units: 'Pa.s' },
          },
        ],
        boundaries: [
          {
            selection: 'inlet',
            kind: 'pressure',
            pressure: { value: 100, units: 'Pa' },
          },
          {
            selection: 'outlet',
            kind: 'pressure',
            pressure: { value: 0, units: 'Pa' },
          },
          { selection: 'walls', kind: 'no-slip' },
        ],
        regime: {
          mode: 'transient',
          initialVelocity: [
            { value: 0, units: 'm/s' },
            { value: 0, units: 'm/s' },
            { value: 0, units: 'm/s' },
          ],
          time: { timestep: { value: 0.01, units: 's' }, steps: 20 },
        },
      },
    ],
  },
];

export const capabilities = {
  schemaVersion: '1' as const,
  physics: PHYSICS_CATALOG.map((entry) => ({
    kind: entry.kind,
    available: entry.available,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
    materialModels: entry.materialModels,
    boundaryKinds: entry.boundaryKinds,
    quantities: entry.quantities,
    ...(entry.controls === undefined ? {} : { controls: entry.controls }),
  })),
  workflow: WORKFLOW,
};

const HELP_RULES = [
  'Call get_capabilities first; only physics marked available are accepted by prepare_study.',
  'Call inspect_model with a file: URI to obtain source and inspection artifact references; pass both into the study model block.',
  'Define selections with dimension-qualified entity IDs (3:tag for solids, 2:tag for surfaces). Every inspected entity must be assigned exactly once and each solid selection must contain one solid.',
  'Assign exactly one material per solid selection and one explicit condition per surface selection; thermal surfaces default to insulated unless overridden.',
  'Every observation needs a unique id and a quantity from the physics entry. Transient quantities may set time in seconds (timestep-aligned); modal eigenfrequency requires mode.',
  'Thermal studies require defaultBoundary: "insulated"; optional sources use volumetricHeat in W/m3.',
  'Run prepare_study then run_study, poll inspect_job, and read evidence with query_results. Jobs survive client disconnects, not server shutdown.',
  'Treat results as computed facts. Apply materials, loads, tolerances, and requirements separately before engineering judgment.',
];

const STUDY_SHAPE = {
  required: ['schemaVersion', 'name', 'objective', 'model', 'selections', 'mesh', 'physics'],
  optional: ['observations', 'acceptanceCriteria', 'assumptions'],
  notes: [
    'schemaVersion is "1".',
    'model needs { source, inspection } artifact references returned by inspect_model.',
    'selections use dimension-qualified entity IDs (3:tag, 2:tag) and must cover every inspected entity exactly once.',
    'mesh is { minSize, maxSize, elementOrder: 1 } with SI meter sizes.',
    'Each observation is { id, quantity, time?, mode? }; id must be unique, quantity comes from the physics entry.',
    'acceptanceCriteria compare an observation id against a threshold whose units match the observed quantity.',
  ],
  example: {
    schemaVersion: '1',
    name: 'Bar conduction',
    objective: 'Estimate the steady temperature field.',
    model: {
      source: {
        revision: 'sha256:<64 hex>',
        uri: 'file:///path/bar.step',
        format: 'step',
        units: 'mm',
      },
      inspection: {
        revision: 'sha256:<64 hex>',
        uri: 'file:///path/inspection.json',
        format: 'json',
      },
    },
    selections: [
      { name: 'bar', entities: ['3:1'] },
      { name: 'hot_end', entities: ['2:2'] },
      { name: 'cold_end', entities: ['2:3'] },
      { name: 'sides', entities: ['2:4', '2:5', '2:6', '2:7'] },
    ],
    mesh: { minSize: 0.003, maxSize: 0.006, elementOrder: 1 },
    observations: [{ id: 'max_temperature', quantity: 'temperature_max' }],
    acceptanceCriteria: [],
    assumptions: [],
  },
};

export function helpDocument() {
  return {
    schemaVersion: '1',
    surface:
      '10 workflow tools: get_capabilities → inspect_model → query_model → validate_study → prepare_study → run_study → inspect_job → list_jobs → query_results → cancel_job',
    rules: HELP_RULES,
    workflow: WORKFLOW,
    study: STUDY_SHAPE,
    physics: PHYSICS_CATALOG.map((entry) => ({
      kind: entry.kind,
      available: entry.available,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      materialModels: entry.materialModels,
      materials: entry.materials,
      boundaries: entry.boundaries,
      ...(entry.regime === undefined ? {} : { regime: entry.regime }),
      notes: entry.notes ?? [],
      controls: entry.controls ?? [],
      observations: entry.observations,
      examples: entry.examples,
    })),
    enums: {
      boundary_kinds: [...new Set(PHYSICS_CATALOG.flatMap((entry) => entry.boundaryKinds))],
      observation_quantities: OBSERVATION_QUANTITIES,
      error_codes: ERROR_CODES,
    },
  };
}

export const HELP_URI = 'simulation://help';
export const WORKFLOW_URI = 'simulation://workflow';
export const WORKFLOW_TEXT =
  'get_capabilities → inspect_model → query_model → validate_study → prepare_study → run_study → inspect_job → query_results. Cancel with cancel_job; recover jobs with list_jobs. Steady/transient thermal, static linear-elastic structural, bounded modal frequency, steady DC conduction, and steady/transient laminar-flow analyses are implemented; other physics are unavailable. Supply all engineering conditions explicitly; no material lookup, load inference, CAD repair or certification. Fetch simulation://help for the machine-readable study schema. Local shared filesystem; jobs survive client disconnects, not server shutdown.';
