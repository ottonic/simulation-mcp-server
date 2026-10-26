import { z } from 'zod';
import {
  artifactSchema,
  id,
  inventorySchema,
  jobSchema,
  operationJobSchema,
  preparationJobSchema,
  studySchema,
} from './schemas.js';
import { capabilities } from './catalog.js';
import type { Simulation } from './service.js';

export type ToolContext = { signal: AbortSignal };
export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};
export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
  handler: (
    simulation: Simulation,
    args: unknown,
    ctx: ToolContext,
  ) => Promise<Record<string, unknown>>;
};

// Erases the per-tool argument type so the registry stays a homogeneous array
// while each handler keeps its exact input type. MCP validates inputs before
// the handler runs.
function defineTool<I>(tool: {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
  handler: (simulation: Simulation, args: I, ctx: ToolContext) => Promise<Record<string, unknown>>;
}): ToolDefinition {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    handler: (simulation, args, ctx) => tool.handler(simulation, args as I, ctx),
  };
}

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const capabilitiesOutputSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  physics: z.array(
    z.strictObject({
      kind: z.string(),
      available: z.boolean(),
      reason: z.string().optional(),
      materialModels: z.array(z.string()),
      boundaryKinds: z.array(z.string()),
      quantities: z.array(z.string()),
      controls: z.array(z.string()).optional(),
    }),
  ),
  workflow: z.array(z.string()),
  study: z.strictObject({
    required: z.array(z.string()),
    optional: z.array(z.string()),
    notes: z.array(z.string()),
    example: z.record(z.string(), z.unknown()),
  }),
});

const validationOutputSchema = z.strictObject({
  valid: z.boolean(),
  issues: z.array(
    z.strictObject({
      severity: z.enum(['error', 'warning', 'info']),
      code: z.string(),
      path: z.string().optional(),
      message: z.string(),
    }),
  ),
  deferredChecks: z.array(z.string()),
});

const modelQueryOutputSchema = z.strictObject({
  entities: z.array(
    z.strictObject({
      id: z.string(),
      dimension: z.union([z.literal(2), z.literal(3)]),
      label: z.string(),
      bounds: z.array(z.number()),
      center: z.array(z.number()),
      measure: z.strictObject({ value: z.number(), units: z.string() }),
      adjacentVolumes: z.array(z.number()),
    }),
  ),
  nextCursor: z.string().optional(),
});

const jobListOutputSchema = z.strictObject({
  jobs: z.array(
    z.strictObject({
      jobId: id,
      kind: z.enum(['prepare', 'solve']),
      status: jobSchema.shape.status,
      createdAt: z.string(),
      endedAt: z.string().optional(),
      error: z.strictObject({ code: z.string(), message: z.string() }).optional(),
    }),
  ),
});

const queryResultsOutputSchema = z.strictObject({
  jobId: jobSchema.shape.jobId,
  source: artifactSchema,
  preparedStudy: artifactSchema.optional(),
  status: jobSchema.shape.status,
  convergence: z.string(),
  summaries: jobSchema.shape.summaries,
  fields: jobSchema.shape.results.element.shape.fields.element.array(),
  observations: z.array(
    z.strictObject({
      id: z.string(),
      quantity: z.string(),
      status: z.enum(['available', 'inconclusive']),
      value: z.number().optional(),
      units: z.string().optional(),
      method: z.string().optional(),
      evidence: z.array(artifactSchema).optional(),
      reason: z.string().optional(),
      time: z
        .strictObject({
          value: z.number().nonnegative(),
          units: z.literal('s'),
        })
        .optional(),
      mode: z.number().int().positive().max(20).optional(),
    }),
  ),
  acceptance: z.array(
    z.strictObject({
      observationId: z.string(),
      status: z.enum(['pass', 'fail', 'inconclusive']),
      reason: z.string().optional(),
      value: z.number().optional(),
      threshold: z.number().optional(),
      units: z.string().optional(),
    }),
  ),
  artifacts: z.array(artifactSchema),
  artifactCount: z.number().int().nonnegative(),
  nextCursor: z.string().optional(),
  diagnostics: z.array(z.string()),
  error: jobSchema.shape.error.optional(),
});

export const TOOL_REGISTRY: ToolDefinition[] = [
  defineTool({
    name: 'get_capabilities',
    title: 'Get Capabilities',
    description:
      'Discover implemented and benchmarked physics workflows actually available in this installation. Unavailable physics are never accepted for preparation.',
    inputSchema: z.strictObject({}),
    outputSchema: capabilitiesOutputSchema,
    annotations: READ_ONLY,
    handler: async () => capabilities,
  }),
  defineTool({
    name: 'inspect_model',
    title: 'Inspect Model',
    description:
      'Snapshot a local STEP file and inspect SI-normalized geometry. Supply exactly one URI or revisioned STEP artifact. Returned entity tags are scoped to the model inspection; labels are hints, never engineering assignments.',
    inputSchema: z
      .strictObject({
        uri: z
          .string()
          .optional()
          .describe(
            'STEP file to inspect, as a file: URI or absolute path. Supply this or source, not both.',
          ),
        source: artifactSchema
          .optional()
          .describe(
            'Revision-bound source artifact instead of a raw URI. Supply this or uri, not both.',
          ),
      })
      .refine(
        (value) => (value.uri === undefined) !== (value.source === undefined),
        'Supply exactly one of uri or source.',
      ),
    outputSchema: z.strictObject({
      source: artifactSchema,
      inspection: artifactSchema,
      inventory: inventorySchema,
      logs: z.array(artifactSchema),
    }),
    annotations: WRITE,
    handler: (simulation, args, ctx) => simulation.inspect(args, ctx.signal),
  }),
  defineTool({
    name: 'query_model',
    title: 'Query Model Entities',
    description:
      'List inspected model entities, optionally filtered by dimension. Entity IDs and labels belong to this exact inspection revision. Use returned IDs to define study selections.',
    inputSchema: z.strictObject({
      model: artifactSchema.describe('The inspection artifact returned by inspect_model.'),
      dimension: z
        .union([z.literal(2), z.literal(3)])
        .optional()
        .describe('Keep only entities of this dimension: 2 = surfaces, 3 = solids.'),
      cursor: z.string().optional().describe('Pagination cursor from the previous page.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe('Entities per page, at most 200 (default 100).'),
    }),
    outputSchema: modelQueryOutputSchema,
    annotations: READ_ONLY,
    handler: async (simulation, args) => simulation.queryModel(args),
  }),
  defineTool({
    name: 'validate_study',
    title: 'Validate Study',
    description:
      'Validate a complete study draft and explain missing or unsupported inputs without launching Gmsh or Elmer. The study shape, per-physics fields and a worked example are in get_capabilities.study.',
    inputSchema: z.strictObject({
      study: z
        .record(z.string(), z.unknown())
        .describe(
          'The study draft. Required and optional fields, per-physics material and boundary fields, observation quantities, and a worked example are in get_capabilities.study; simulation://help carries the full JSON Schema.',
        ),
    }),
    outputSchema: validationOutputSchema,
    annotations: READ_ONLY,
    handler: async (simulation, args) => simulation.validateStudy(args.study),
  }),
  defineTool({
    name: 'prepare_study',
    title: 'Prepare Study',
    description:
      'Queue validation, meshing and solver-input generation for an available study type in the background. Transient thermal requires density, heat capacity, a uniform initial temperature, timestep and step count. Transient flow uses first-order BDF with explicit quiescent initial velocity. Returns a jobId immediately; inspect_job polls until the prepared-study artifact is available.',
    inputSchema: z.strictObject({
      study: studySchema.describe(
        'The study to prepare. get_capabilities.study lists every field; validate_study explains missing or unsupported inputs before anything is meshed.',
      ),
    }),
    outputSchema: preparationJobSchema,
    annotations: WRITE,
    handler: async (simulation, args, ctx) => simulation.prepareStudy(args.study, ctx.signal),
  }),
  defineTool({
    name: 'run_study',
    title: 'Run Study',
    description:
      'Execute an immutable prepared study asynchronously. Returns a jobId; use inspect_job, list_jobs, query_results or cancel_job.',
    inputSchema: z.strictObject({
      prepared: artifactSchema.describe(
        'The prepared-study artifact returned by prepare_study (inspect_job.prepared once the prepare job succeeds). It pins the mesh and solver inputs, so the solve cannot pick up a changed study.',
      ),
    }),
    outputSchema: jobSchema,
    annotations: WRITE,
    handler: async (simulation, args, ctx) => {
      const run = await simulation.runStudy(args.prepared, ctx.signal);
      const { runId, ...rest } = run;
      return { ...rest, jobId: runId };
    },
  }),
  defineTool({
    name: 'inspect_job',
    title: 'Inspect Job',
    description:
      'Inspect preparation or solver job status, diagnostics and available artifacts. Pass waitMs to wait for a terminal state instead of polling; interrupted jobs are not resumed automatically.',
    inputSchema: z.strictObject({
      jobId: id.describe('Job id from prepare_study or run_study.'),
      waitMs: z
        .number()
        .int()
        .positive()
        .max(60_000)
        .optional()
        .describe(
          'Wait up to this many milliseconds for the job to finish, then return its state (max 60000). Prefer one call with waitMs 60000 over repeated polling; the status may still be preparing/running when the window expires.',
        ),
    }),
    outputSchema: operationJobSchema,
    annotations: READ_ONLY,
    handler: async (simulation, args) =>
      args.waitMs
        ? simulation.waitForJob(args.jobId, args.waitMs)
        : simulation.inspectJob(args.jobId),
  }),
  defineTool({
    name: 'list_jobs',
    title: 'List Jobs',
    description:
      'Recover recent solver jobs after losing conversation context. Returns up to 100 jobs, newest first.',
    inputSchema: z.strictObject({}),
    outputSchema: jobListOutputSchema,
    annotations: READ_ONLY,
    handler: async (simulation) => simulation.listJobs(),
  }),
  defineTool({
    name: 'query_results',
    title: 'Query Results',
    description:
      "Retrieve bounded evidence for a solver job, including its job ID, source model and prepared-study reference, status, convergence, observations and acceptance, distinct output fields, and a paginated artifact page. Summaries are returned when explicitly requested with include:['summaries'], or as a fallback when no observations were declared. Pass observations to filter, time to select the frame for observations without an explicit time, and limit/cursor to page artifacts.",
    inputSchema: z.strictObject({
      jobId: id.describe('Solver job id returned by run_study.'),
      include: z
        .array(z.enum(['summaries']))
        .optional()
        .describe(
          "Pass ['summaries'] to include the full summary history rather than only the latest observations.",
        ),
      observations: z
        .array(z.string())
        .optional()
        .describe('Keep only these observation ids (as defined in the study).'),
      time: z
        .number()
        .nonnegative()
        .optional()
        .describe(
          'For time-dependent studies: the timestep-aligned time in seconds to read. Defaults to the final step.',
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe('Artifacts per page, at most 500 (default 100).'),
      cursor: z.string().optional().describe('Pagination cursor from the previous page.'),
    }),
    outputSchema: queryResultsOutputSchema,
    annotations: READ_ONLY,
    handler: async (simulation, args) =>
      simulation.queryResults(args.jobId, {
        include: args.include,
        observations: args.observations,
        time: args.time,
        limit: args.limit,
        cursor: args.cursor,
      }),
  }),
  defineTool({
    name: 'cancel_job',
    title: 'Cancel Job',
    description:
      'Cancel an active preparation or solver job owned by this server. Child processes are stopped before cancellation is reported; partial artifacts are retained.',
    inputSchema: z.strictObject({
      jobId: id.describe('Job id of the active preparation or solver job to stop.'),
    }),
    outputSchema: operationJobSchema,
    annotations: DESTRUCTIVE,
    handler: async (simulation, args) => simulation.cancelJob(args.jobId),
  }),
];
