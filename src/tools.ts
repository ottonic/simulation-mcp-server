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
        uri: z.string().optional(),
        source: artifactSchema.optional(),
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
      model: artifactSchema,
      dimension: z.union([z.literal(2), z.literal(3)]).optional(),
      cursor: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    }),
    outputSchema: modelQueryOutputSchema,
    annotations: READ_ONLY,
    handler: async (simulation, args) => simulation.queryModel(args),
  }),
  defineTool({
    name: 'validate_study',
    title: 'Validate Study',
    description:
      'Validate a complete study draft and explain missing or unsupported inputs without launching Gmsh or Elmer.',
    inputSchema: z.strictObject({ study: z.record(z.string(), z.unknown()) }),
    outputSchema: validationOutputSchema,
    annotations: READ_ONLY,
    handler: async (simulation, args) => simulation.validateStudy(args.study),
  }),
  defineTool({
    name: 'prepare_study',
    title: 'Prepare Study',
    description:
      'Queue validation, meshing and solver-input generation for an available study type in the background. Transient thermal requires density, heat capacity, a uniform initial temperature, timestep and step count. Transient flow uses first-order BDF with explicit quiescent initial velocity. Returns a jobId immediately; inspect_job polls until the prepared-study artifact is available.',
    inputSchema: z.strictObject({ study: studySchema }),
    outputSchema: preparationJobSchema,
    annotations: WRITE,
    handler: async (simulation, args) => simulation.prepareStudy(args.study),
  }),
  defineTool({
    name: 'run_study',
    title: 'Run Study',
    description:
      'Execute an immutable prepared study asynchronously. Returns a jobId; use inspect_job, list_jobs, query_results or cancel_job.',
    inputSchema: z.strictObject({ prepared: artifactSchema }),
    outputSchema: jobSchema,
    annotations: WRITE,
    handler: async (simulation, args) => {
      const run = await simulation.runStudy(args.prepared);
      const { runId, ...rest } = run;
      return { ...rest, jobId: runId };
    },
  }),
  defineTool({
    name: 'inspect_job',
    title: 'Inspect Job',
    description:
      'Inspect preparation or solver job status, diagnostics and available artifacts. Interrupted jobs are not resumed automatically.',
    inputSchema: z.strictObject({ jobId: id }),
    outputSchema: operationJobSchema,
    annotations: READ_ONLY,
    handler: async (simulation, args) => simulation.inspectJob(args.jobId),
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
      "Retrieve bounded evidence for a solver job: status, convergence, observations and acceptance, the summaries backing them, distinct output fields, and a paginated artifact page. Pass include:['summaries'] for the full history, observations to filter, time to select the frame for observations without an explicit time, and limit/cursor to page artifacts.",
    inputSchema: z.strictObject({
      jobId: id,
      include: z.array(z.enum(['summaries'])).optional(),
      observations: z.array(z.string()).optional(),
      time: z.number().nonnegative().optional(),
      limit: z.number().int().positive().max(500).optional(),
      cursor: z.string().optional(),
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
    inputSchema: z.strictObject({ jobId: id }),
    outputSchema: operationJobSchema,
    annotations: DESTRUCTIVE,
    handler: async (simulation, args) => simulation.cancelJob(args.jobId),
  }),
];
