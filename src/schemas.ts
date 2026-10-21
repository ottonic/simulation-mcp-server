import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const artifactContract = JSON.parse(
  readFileSync(new URL('../contracts/artifact-ref.schema.json', import.meta.url), 'utf8'),
);
// The local schema omits $id so nested ArtifactRefs do not collide in SDK output schemas.
export type ArtifactRef = {
  revision: string;
  uri?: string;
  format: string;
  units?: string;
};
export const artifactSchema = z.fromJSONSchema(artifactContract) as z.ZodType<ArtifactRef>;
export const id = z.string().uuid().describe('Job id returned by prepare_study or run_study.');
export const controlsSchema = z
  .strictObject({
    minSize: z.number().positive().max(1000),
    maxSize: z.number().positive().max(1000),
    units: z.literal('m'),
  })
  .refine((x) => x.minSize <= x.maxSize, 'minSize must not exceed maxSize');
export const groupSchema = z.strictObject({
  id: z.number().int().min(1).max(999),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/),
  dimension: z.union([z.literal(2), z.literal(3)]),
  entities: z.array(z.number().int().positive()).min(1),
});
export type Group = z.infer<typeof groupSchema>;
export const quantity = <T extends string>(units: T, positive = false) =>
  z.strictObject({
    value: positive ? z.number().positive() : z.number(),
    units: z.literal(units),
  });
const thermalFields = {
  materials: z
    .array(
      z.strictObject({
        group: z.number().int().positive(),
        conductivity: quantity('W/(m.K)', true),
      }),
    )
    .min(1),
  sources: z
    .array(
      z.strictObject({
        group: z.number().int().positive(),
        heat: quantity('W/m3'),
      }),
    )
    .default([]),
  boundaries: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({
          group: z.number().int().positive(),
          kind: z.literal('temperature'),
          temperature: z.strictObject({
            value: z.number().nonnegative(),
            units: z.literal('K'),
          }),
        }),
        z.strictObject({
          group: z.number().int().positive(),
          kind: z.literal('flux'),
          inwardFlux: quantity('W/m2'),
        }),
        z.strictObject({
          group: z.number().int().positive(),
          kind: z.literal('insulated'),
        }),
      ]),
    )
    .min(1),
};
const steadyThermalSchema = z.strictObject({
  physics: z.literal('steady-heat-conduction'),
  ...thermalFields,
});
const transientThermalSchema = z.strictObject({
  physics: z.literal('transient-heat-conduction'),
  ...thermalFields,
  materials: z
    .array(
      z.strictObject({
        group: z.number().int().positive(),
        conductivity: quantity('W/(m.K)', true),
        density: quantity('kg/m3', true),
        heatCapacity: quantity('J/(kg.K)', true),
      }),
    )
    .min(1),
  boundaries: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({
          group: z.number().int().positive(),
          kind: z.literal('temperature'),
          temperature: z.strictObject({
            value: z.number().nonnegative(),
            units: z.literal('K'),
          }),
        }),
        z.strictObject({
          group: z.number().int().positive(),
          kind: z.literal('flux'),
          inwardFlux: quantity('W/m2'),
        }),
        z.strictObject({
          group: z.number().int().positive(),
          kind: z.literal('insulated'),
        }),
      ]),
    )
    .min(1),
  initialTemperature: z.strictObject({
    value: z.number().nonnegative(),
    units: z.literal('K'),
  }),
  time: z.strictObject({
    timestep: quantity('s', true),
    steps: z.number().int().positive().max(10000),
  }),
});
export const thermalSchema = z.discriminatedUnion('physics', [
  steadyThermalSchema,
  transientThermalSchema,
]);
export type Thermal = z.infer<typeof thermalSchema>;

// Isotropic, linear small-strain elasticity. Keep material and boundary
// semantics independent of solver so a future structural analysis can reuse them.
// Poisson ratio is capped at 0.45: the displacement-based solvers on linear
// tetrahedra lock as nu approaches 0.5, so a near-incompressible request is
// rejected rather than silently over-stiffened.
const structuralMaterialSchema = z.strictObject({
  group: z.number().int().positive(),
  youngsModulus: quantity('Pa', true),
  poissonRatio: z.number().gt(-1).lt(0.45),
});
const structuralBoundarySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    group: z.number().int().positive(),
    kind: z.literal('fixed-displacement'),
  }),
  z.strictObject({
    group: z.number().int().positive(),
    kind: z.literal('prescribed-displacement'),
    displacement: z.tuple([quantity('m'), quantity('m'), quantity('m')]),
  }),
  z.strictObject({
    group: z.number().int().positive(),
    kind: z.literal('uniform-traction'),
    traction: z.tuple([quantity('N/m2'), quantity('N/m2'), quantity('N/m2')]),
  }),
  z.strictObject({
    group: z.number().int().positive(),
    kind: z.literal('free'),
  }),
]);
export const staticStructuralSchema = z.strictObject({
  physics: z.literal('static-structural'),
  materials: z.array(structuralMaterialSchema).min(1),
  boundaries: z.array(structuralBoundarySchema).min(1),
});
export type StaticStructural = z.infer<typeof staticStructuralSchema>;
export const modalSchema = z.strictObject({
  physics: z.literal('modal'),
  materials: z
    .array(
      z.strictObject({
        group: z.number().int().positive(),
        youngsModulus: quantity('Pa', true),
        poissonRatio: z.number().gt(-1).lt(0.45),
        density: quantity('kg/m3', true),
      }),
    )
    .min(1),
  boundaries: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({
          group: z.number().int().positive(),
          kind: z.literal('fixed-displacement'),
        }),
        z.strictObject({
          group: z.number().int().positive(),
          kind: z.literal('free'),
        }),
      ]),
    )
    .min(1),
  modes: z.number().int().positive().max(20),
});
export type Modal = z.infer<typeof modalSchema>;
const dcBoundarySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    group: z.number().int().positive(),
    kind: z.literal('potential'),
    potential: quantity('V'),
  }),
  z.strictObject({
    group: z.number().int().positive(),
    kind: z.literal('insulated'),
  }),
]);
export const dcConductionSchema = z.strictObject({
  physics: z.literal('dc-conduction'),
  materials: z
    .array(
      z.strictObject({
        group: z.number().int().positive(),
        electricalConductivity: quantity('S/m', true),
      }),
    )
    .min(1),
  boundaries: z.array(dcBoundarySchema).min(1),
});
export type DcConduction = z.infer<typeof dcConductionSchema>;
const flowMaterial = z.strictObject({
  group: z.number().int().positive(),
  density: quantity('kg/m3', true),
  dynamicViscosity: quantity('Pa.s', true),
});
const flowBoundary = z.discriminatedUnion('kind', [
  z.strictObject({
    group: z.number().int().positive(),
    kind: z.literal('pressure'),
    pressure: quantity('Pa'),
  }),
  z.strictObject({
    group: z.number().int().positive(),
    kind: z.literal('no-slip'),
  }),
]);
const flowRegime = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('steady') }),
  z.strictObject({
    mode: z.literal('transient'),
    initialVelocity: z.tuple([quantity('m/s'), quantity('m/s'), quantity('m/s')]),
    time: z.strictObject({
      timestep: quantity('s', true),
      steps: z.number().int().positive().max(1000),
    }),
  }),
]);
export const laminarFlowConfigSchema = z.strictObject({
  physics: z.literal('laminar-flow'),
  materials: z.array(flowMaterial).min(1),
  boundaries: z.array(flowBoundary).min(1),
  regime: flowRegime,
});
export type LaminarFlowConfig = z.infer<typeof laminarFlowConfigSchema>;
const triple = z.tuple([z.number(), z.number(), z.number()]);
export const inventorySchema = z.strictObject({
  protocol: z.literal(1),
  gmshVersion: z.string(),
  sourceUnits: z.enum(['m', 'mm', 'cm', 'um']),
  scaleToMeters: z.number().positive(),
  idScheme: z.literal('gmsh-occ-import-v1'),
  frame: z.strictObject({
    id: z.literal('step-world-si'),
    units: z.literal('m'),
    origin: triple,
    axes: z.tuple([triple, triple, triple]),
    handedness: z.literal('right'),
  }),
  entities: z.array(
    z.strictObject({
      dimension: z.union([z.literal(2), z.literal(3)]),
      tag: z.number().int().positive(),
      label: z.string(),
      bounds: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]),
      center: triple,
      measure: z.number().positive(),
      measureUnits: z.enum(['m2', 'm3']),
      adjacentVolumes: z.array(z.number().int()),
    }),
  ),
  diagnostics: z.array(z.string()),
});
export type Inventory = z.infer<typeof inventorySchema>;
export const workerMeshSchema = z.strictObject({
  protocol: z.literal(1),
  inventory: inventorySchema,
  groups: z.array(groupSchema.extend({ elements: z.number().int().positive() })),
  nodeCount: z.number().int().positive(),
  elementCount: z.number().int().positive(),
  minimumQuality: z.number().positive(),
});
export const meshSchema = z.strictObject({
  kind: z.literal('simulation-mesh-v1'),
  source: artifactSchema,
  inventory: artifactSchema,
  controls: controlsSchema,
  groups: z.array(groupSchema.extend({ elements: z.number().int().positive() })),
  gmsh: artifactSchema,
  files: z.strictObject({
    'mesh.header': artifactSchema,
    'mesh.nodes': artifactSchema,
    'mesh.elements': artifactSchema,
    'mesh.boundary': artifactSchema,
  }),
  gmshVersion: z.string(),
  elmerGridVersion: z.string(),
  minimumQuality: z.number().positive(),
  nodeCount: z.number().int().positive(),
  elementCount: z.number().int().positive(),
  connectedBodies: z.array(z.array(z.number().int().positive())),
  boundaryBodies: z.record(z.string(), z.array(z.number().int().positive())),
  diagnostics: z.array(z.string()),
  logs: z.array(artifactSchema),
});
export type Mesh = z.infer<typeof meshSchema>;
export const caseSchema = z.strictObject({
  kind: z.literal('simulation-case-v1'),
  mesh: artifactSchema,
  config: z.union([
    thermalSchema,
    staticStructuralSchema,
    modalSchema,
    dcConductionSchema,
    laminarFlowConfigSchema,
  ]),
  sif: artifactSchema,
});
export type Case = z.infer<typeof caseSchema>;

const selectionName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/);
export const entityId = z.string().regex(/^[23]:[1-9][0-9]*$/);
// Single source of truth for observation quantities, reused by the study
// schema and by the capability/help catalog so discovery cannot drift.
export const OBSERVATION_QUANTITIES = [
  'temperature_min',
  'temperature_max',
  'temperature_mean',
  'heat_flux_magnitude_mean',
  'displacement_magnitude_min',
  'displacement_magnitude_max',
  'displacement_magnitude_mean',
  'stress_xx_min',
  'stress_xx_max',
  'stress_xx_mean',
  'von_mises_stress_max',
  'eigenfrequency',
  'potential_min',
  'potential_max',
  'potential_mean',
  'velocity_magnitude_max',
  'velocity_x_max',
  'pressure_min',
  'pressure_max',
] as const;
export type ObservationQuantity = (typeof OBSERVATION_QUANTITIES)[number];
const thermalSelection = z.strictObject({
  name: selectionName,
  entities: z.array(entityId).min(1),
});
export const studySchema = z.strictObject({
  schemaVersion: z.literal('1'),
  name: z.string().min(1).max(120),
  objective: z.string().min(1).max(1000),
  model: z.strictObject({ source: artifactSchema, inspection: artifactSchema }),
  selections: z.array(thermalSelection).min(1),
  mesh: z
    .strictObject({
      minSize: z.number().positive().max(1000),
      maxSize: z.number().positive().max(1000),
      elementOrder: z.literal(1).meta({
        description:
          'Mesh element order. Only 1 (linear elements) is implemented; quadratic elements are not available.',
      }),
    })
    .refine((mesh) => mesh.minSize <= mesh.maxSize, 'minSize must not exceed maxSize'),
  physics: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('steady-thermal'),
      defaultBoundary: z.literal('insulated'),
      materials: z
        .array(
          z.strictObject({
            selection: selectionName,
            conductivity: quantity('W/(m.K)', true),
          }),
        )
        .min(1),
      sources: z
        .array(
          z.strictObject({
            selection: selectionName,
            volumetricHeat: quantity('W/m3'),
          }),
        )
        .default([]),
      boundaries: z.array(
        z.discriminatedUnion('kind', [
          z.strictObject({
            selection: selectionName,
            kind: z.literal('temperature'),
            temperature: z.strictObject({
              value: z.number().nonnegative(),
              units: z.literal('K'),
            }),
          }),
          z.strictObject({
            selection: selectionName,
            kind: z.literal('inward-heat-flux'),
            flux: quantity('W/m2'),
          }),
          z.strictObject({
            selection: selectionName,
            kind: z.literal('insulated'),
          }),
        ]),
      ),
    }),
    z.strictObject({
      kind: z.literal('transient-thermal'),
      defaultBoundary: z.literal('insulated'),
      materials: z
        .array(
          z.strictObject({
            selection: selectionName,
            conductivity: quantity('W/(m.K)', true),
            density: quantity('kg/m3', true),
            heatCapacity: quantity('J/(kg.K)', true),
          }),
        )
        .min(1),
      sources: z
        .array(
          z.strictObject({
            selection: selectionName,
            volumetricHeat: quantity('W/m3'),
          }),
        )
        .default([]),
      boundaries: z.array(
        z.discriminatedUnion('kind', [
          z.strictObject({
            selection: selectionName,
            kind: z.literal('temperature'),
            temperature: z.strictObject({
              value: z.number().nonnegative(),
              units: z.literal('K'),
            }),
          }),
          z.strictObject({
            selection: selectionName,
            kind: z.literal('inward-heat-flux'),
            flux: quantity('W/m2'),
          }),
          z.strictObject({
            selection: selectionName,
            kind: z.literal('insulated'),
          }),
        ]),
      ),
      initialTemperature: z.strictObject({
        value: z.number().nonnegative(),
        units: z.literal('K'),
      }),
      time: z.strictObject({
        timestep: quantity('s', true),
        steps: z.number().int().positive().max(10000),
      }),
    }),
    z.strictObject({
      kind: z.literal('static-structural'),
      materials: z
        .array(
          z.strictObject({
            selection: selectionName,
            youngsModulus: quantity('Pa', true),
            poissonRatio: z.number().gt(-1).lt(0.45),
          }),
        )
        .min(1),
      boundaries: z
        .array(
          z.discriminatedUnion('kind', [
            z.strictObject({
              selection: selectionName,
              kind: z.literal('fixed-displacement'),
            }),
            z.strictObject({
              selection: selectionName,
              kind: z.literal('prescribed-displacement'),
              displacement: z.tuple([quantity('m'), quantity('m'), quantity('m')]),
            }),
            z.strictObject({
              selection: selectionName,
              kind: z.literal('uniform-traction'),
              traction: z.tuple([quantity('N/m2'), quantity('N/m2'), quantity('N/m2')]),
            }),
            z.strictObject({
              selection: selectionName,
              kind: z.literal('free'),
            }),
          ]),
        )
        .min(1),
    }),
    z.strictObject({
      kind: z.literal('modal'),
      materials: z
        .array(
          z.strictObject({
            selection: selectionName,
            youngsModulus: quantity('Pa', true),
            poissonRatio: z.number().gt(-1).lt(0.45),
            density: quantity('kg/m3', true),
          }),
        )
        .min(1),
      boundaries: z
        .array(
          z.discriminatedUnion('kind', [
            z.strictObject({
              selection: selectionName,
              kind: z.literal('fixed-displacement'),
            }),
            z.strictObject({
              selection: selectionName,
              kind: z.literal('free'),
            }),
          ]),
        )
        .min(1),
      modes: z.number().int().positive().max(20),
    }),
    z.strictObject({
      kind: z.literal('dc-conduction'),
      materials: z
        .array(
          z.strictObject({
            selection: selectionName,
            electricalConductivity: quantity('S/m', true),
          }),
        )
        .min(1),
      boundaries: z
        .array(
          z.discriminatedUnion('kind', [
            z.strictObject({
              selection: selectionName,
              kind: z.literal('potential'),
              potential: quantity('V'),
            }),
            z.strictObject({
              selection: selectionName,
              kind: z.literal('insulated'),
            }),
          ]),
        )
        .min(1),
    }),
    z.strictObject({
      kind: z.literal('laminar-flow'),
      materials: z
        .array(
          z.strictObject({
            selection: selectionName,
            density: quantity('kg/m3', true),
            dynamicViscosity: quantity('Pa.s', true),
          }),
        )
        .min(1),
      boundaries: z
        .array(
          z.discriminatedUnion('kind', [
            z.strictObject({
              selection: selectionName,
              kind: z.literal('pressure'),
              pressure: quantity('Pa'),
            }),
            z.strictObject({
              selection: selectionName,
              kind: z.literal('no-slip'),
            }),
          ]),
        )
        .min(1),
      regime: flowRegime,
    }),
  ]),
  observations: z
    .array(
      z.strictObject({
        id: selectionName,
        quantity: z.enum(OBSERVATION_QUANTITIES),
        time: quantity('s', true).optional(),
        mode: z.number().int().positive().max(20).optional(),
      }),
    )
    .default([]),
  acceptanceCriteria: z
    .array(
      z.strictObject({
        observationId: selectionName,
        operator: z.enum(['<', '<=', '>', '>=']),
        threshold: z.strictObject({
          value: z.number(),
          units: z.string().min(1),
        }),
      }),
    )
    .default([]),
  assumptions: z
    .array(
      z.strictObject({
        statement: z.string().min(1),
        provenance: z.string().min(1),
      }),
    )
    .default([]),
});
export type Study = z.infer<typeof studySchema>;
// The physics block of a study, exported so discovery examples can be validated
// against the exact schema the service accepts.
export const physicsSchema = studySchema.shape.physics;
export const preparedStudySchema = z.strictObject({
  kind: z.literal('simulation-prepared-study-v1'),
  study: studySchema,
  mesh: artifactSchema,
  case: artifactSchema,
  diagnostics: z.array(z.string()),
});
export type PreparedStudy = z.infer<typeof preparedStudySchema>;
export const jobId = id;
export const summarySchema = z.strictObject({
  name: z.string(),
  value: z.number(),
  units: z.string(),
  method: z.string(),
  source: artifactSchema,
  time: z.strictObject({ value: z.number().nonnegative(), units: z.literal('s') }).optional(),
});
export const resultSchema = z.strictObject({
  artifact: artifactSchema,
  pointCount: z.number().int().positive(),
  cellCount: z.number().int().positive(),
  fields: z.array(
    z.strictObject({
      name: z.string(),
      components: z.number().int().positive(),
      association: z.string(),
      units: z.string().optional(),
    }),
  ),
  frame: z.string(),
  coordinateUnits: z.literal('m'),
  time: z.strictObject({ value: z.number().nonnegative(), units: z.literal('s') }).optional(),
});
/** Statuses a job never leaves. `preparing`/`running` are the only live ones. */
export const TERMINAL_JOB_STATUSES = [
  'succeeded',
  'failed',
  'timeout',
  'cancelled',
  'interrupted',
] as const;

export function isTerminalJobStatus(status: string): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}

// Shared by the persisted solve record (`runSchema`) and the MCP job output
// (`jobSchema`) so the two cannot drift.
export const solveJobFields = {
  kind: z.literal('solve'),
  status: z.enum([
    'preparing',
    'running',
    'succeeded',
    'failed',
    'timeout',
    'cancelled',
    'interrupted',
  ]),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  source: artifactSchema,
  mesh: artifactSchema,
  case: artifactSchema,
  sif: artifactSchema,
  prepared: artifactSchema.optional(),
  solver: z.strictObject({
    executable: z.literal('ElmerSolver'),
    version: z.string(),
  }),
  execution: z
    .strictObject({
      exitCode: z.number().nullable(),
      signal: z.string().nullable(),
      termination: z.string(),
      timeoutMs: z.number().int().positive(),
    })
    .optional(),
  logs: z.array(artifactSchema),
  outputs: z.array(artifactSchema),
  results: z.array(resultSchema),
  summaries: z.array(summarySchema),
  convergence: z.string(),
  diagnostics: z.array(z.string()),
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
};
export const jobSchema = z.strictObject({ jobId, ...solveJobFields });
export type SolveJob = z.infer<typeof jobSchema>;
export type Summary = z.infer<typeof summarySchema>;
export const preparationJobSchema = z.strictObject({
  jobId,
  kind: z.literal('prepare'),
  status: z.enum(['preparing', 'succeeded', 'failed', 'timeout', 'cancelled', 'interrupted']),
  createdAt: z.string(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  study: artifactSchema,
  prepared: artifactSchema.optional(),
  artifacts: z.array(artifactSchema),
  diagnostics: z.array(z.string()),
  error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
});
export const operationJobSchema = z.discriminatedUnion('kind', [jobSchema, preparationJobSchema]);
