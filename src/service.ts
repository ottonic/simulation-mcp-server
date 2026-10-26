import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { onAbort } from './abort.js';
import { pollUntilTerminal } from './jobs.js';
import { Artifacts, digest, MAX_OUTPUT_BYTES } from './artifacts.js';
import { SimulationError, errorData, requireThat } from './errors.js';
import { dimensionOfCanonical, fromSI, toSI } from './units.js';
import {
  artifactSchema,
  caseSchema,
  controlsSchema,
  groupSchema,
  id,
  inventorySchema,
  jobSchema,
  meshSchema,
  operationJobSchema,
  preparationJobSchema,
  preparedStudySchema,
  studySchema,
  workerMeshSchema,
  type ArtifactRef,
  type Case,
  type Mesh,
  type Study,
  type StaticStructural,
  type Modal,
  type DcConduction,
  type LaminarFlowConfig,
  type Thermal,
} from './schemas.js';
import { meshFiles, validateConversion, validateGroups } from './mesh.js';
import { runProcess, termination, type ProcessResult } from './process.js';
import {
  necessaryStudyCondition,
  physicsByCase,
  physicsByStudy,
  RUN_DIAGNOSTICS,
  type CaseConfig,
} from './physics.js';
import { validatePrescribedBoundaryNodes, type PrescribedBoundaryValues } from './boundaries.js';
import {
  describeVtu,
  parseLaminarFlowConvergence,
  parseScalars,
  parseModalEigenvalues,
  parseTransientScalars,
  parseVtu,
} from './results.js';

const inspectionSchema = z.strictObject({
  source: artifactSchema,
  inventory: inventorySchema,
});

function acceptanceThresholdMatches(
  threshold: { value: number; units: string },
  expectedUnit: string | undefined,
) {
  if (!expectedUnit) return false;
  if (expectedUnit === 'Hz') return threshold.units === 'Hz';
  try {
    return toSI(threshold.value, threshold.units).dimension === dimensionOfCanonical(expectedUnit);
  } catch {
    return false;
  }
}

function acceptanceValues(
  threshold: { value: number; units: string },
  observation: { value?: number; units?: string },
) {
  if (observation.value === undefined || !observation.units) return undefined;
  if (threshold.units === 'Hz' && observation.units === 'Hz')
    return { limit: threshold.value, actual: observation.value };
  try {
    const limit = toSI(threshold.value, threshold.units);
    const actual = toSI(observation.value, observation.units);
    return limit.dimension === actual.dimension
      ? { limit: limit.value, actual: actual.value }
      : undefined;
  } catch {
    return undefined;
  }
}

function checkBoundaryNodeConflicts(
  config: Thermal | StaticStructural | Modal | DcConduction | LaminarFlowConfig,
  boundaryFile: string,
) {
  const conditions: PrescribedBoundaryValues[] =
    config.physics === 'steady-heat-conduction' || config.physics === 'transient-heat-conduction'
      ? config.boundaries.flatMap((boundary) =>
          boundary.kind === 'temperature'
            ? [
                {
                  group: boundary.group,
                  dofs: { temperature: boundary.temperature.value },
                },
              ]
            : [],
        )
      : config.physics === 'static-structural'
        ? config.boundaries.flatMap((boundary) =>
            boundary.kind === 'fixed-displacement'
              ? [
                  {
                    group: boundary.group,
                    dofs: {
                      displacement_x: 0,
                      displacement_y: 0,
                      displacement_z: 0,
                    },
                  },
                ]
              : boundary.kind === 'prescribed-displacement'
                ? [
                    {
                      group: boundary.group,
                      dofs: {
                        displacement_x: boundary.displacement[0].value,
                        displacement_y: boundary.displacement[1].value,
                        displacement_z: boundary.displacement[2].value,
                      },
                    },
                  ]
                : [],
          )
        : config.physics === 'modal'
          ? config.boundaries.flatMap((boundary) =>
              boundary.kind === 'fixed-displacement'
                ? [
                    {
                      group: boundary.group,
                      dofs: {
                        displacement_x: 0,
                        displacement_y: 0,
                        displacement_z: 0,
                      },
                    },
                  ]
                : [],
            )
          : config.physics === 'dc-conduction'
            ? config.boundaries.flatMap((boundary) =>
                boundary.kind === 'potential'
                  ? [
                      {
                        group: boundary.group,
                        dofs: { potential: boundary.potential.value },
                      },
                    ]
                  : [],
              )
            : config.boundaries.map((boundary): PrescribedBoundaryValues =>
                boundary.kind === 'pressure'
                  ? {
                      group: boundary.group,
                      dofs: { pressure: boundary.pressure.value },
                    }
                  : {
                      group: boundary.group,
                      dofs: { velocity_x: 0, velocity_y: 0, velocity_z: 0 },
                    },
              );
  validatePrescribedBoundaryNodes(boundaryFile, conditions);
}
// Persisted solve record: identical fields to the MCP job output, keyed by
// runId instead of jobId.
export const runSchema = z.strictObject({
  runId: id,
  ...jobSchema.omit({ jobId: true }).shape,
});
export type Run = z.infer<typeof runSchema>;
export type PreparationJob = z.infer<typeof preparationJobSchema>;
type ActivePreparation = {
  abort: AbortController;
  done: Promise<void>;
  state: PreparationJob;
};
export type Settings = {
  workspace: string;
  roots: string[];
  python: string;
  elmerGrid: string;
  elmerSolver: string;
  timeoutMs: number;
};
export type ServiceOptions = { solverRunner?: typeof runProcess };
// Bounds and filters for query_results. Defaults return only observation-backed
// summaries and a bounded artifact page so large transient runs stay compact.
export type QueryResultsOptions = {
  include?: string[];
  observations?: string[];
  time?: number;
  limit?: number;
  cursor?: string;
};
const OBSERVATION_DIMENSIONS: Readonly<Record<string, string>> = {
  temperature_min: 'temperature',
  temperature_max: 'temperature',
  temperature_mean: 'temperature',
  heat_flux_magnitude_mean: 'heatFlux',
  displacement_magnitude_min: 'length',
  displacement_magnitude_max: 'length',
  displacement_magnitude_mean: 'length',
  displacement_x_min: 'length',
  displacement_x_max: 'length',
  displacement_x_mean: 'length',
  stress_xx_min: 'pressure',
  stress_xx_max: 'pressure',
  stress_xx_mean: 'pressure',
  von_mises_stress_max: 'pressure',
  potential_min: 'potential',
  potential_max: 'potential',
  potential_mean: 'potential',
  velocity_magnitude_max: 'speed',
  velocity_x_max: 'speed',
  pressure_min: 'pressure',
  pressure_max: 'pressure',
};

export class Simulation {
  private active = new Map<string, { abort: AbortController; done: Promise<void>; state: Run }>();
  private preparations = new Map<string, ActivePreparation>();
  private constructor(
    public artifacts: Artifacts,
    public settings: Settings,
    private solverRunner: typeof runProcess,
  ) {}
  static async create(settings: Settings, options: ServiceOptions = {}) {
    requireThat(
      Number.isInteger(settings.timeoutMs) &&
        settings.timeoutMs > 0 &&
        settings.timeoutMs <= 3_600_000,
      'invalid_input',
      'Timeout must be between 1 and 3600000 ms.',
    );
    return new Simulation(
      await Artifacts.create(settings.workspace, settings.roots),
      settings,
      options.solverRunner ?? runProcess,
    );
  }
  async logs(dir: string, prefix: string) {
    return Promise.all(
      ['stdout', 'stderr'].map((suffix) =>
        this.artifacts.capture(join(dir, `${prefix}.${suffix}`), 'text'),
      ),
    );
  }
  async worker(dir: string, request: object, signal?: AbortSignal) {
    await this.artifacts.put(
      dir,
      'request.json',
      JSON.stringify({ protocol: 1, ...request }),
      'json',
    );
    const worker = fileURLToPath(new URL('../worker/gmsh_worker.py', import.meta.url));
    const process = await runProcess(
      this.settings.python,
      [worker, 'request.json', 'response.json'],
      dir,
      'gmsh',
      this.settings.timeoutMs,
      signal,
    );
    const logs = await this.logs(dir, 'gmsh');
    const failure = termination(process, 'worker_failed');
    if (failure)
      throw new SimulationError(failure, 'Gmsh worker failed; inspect its retained logs.', {
        logs,
      });
    let response: unknown;
    try {
      response = JSON.parse(
        (await this.artifacts.bytes(pathToFileURL(join(dir, 'response.json')).href)).toString(),
      );
    } catch {
      throw new SimulationError('worker_protocol', 'Gmsh returned a malformed response.', { logs });
    }
    return { response, logs };
  }
  async inspect(input: { uri?: string; source?: ArtifactRef }, signal?: AbortSignal) {
    requireThat(
      Boolean(input.uri) !== Boolean(input.source),
      'invalid_input',
      'Supply exactly one STEP URI or artifact ref.',
    );
    const bytes = input.source
      ? await this.artifacts.verify(input.source, 'step')
      : await this.artifacts.bytes(input.uri!);
    requireThat(
      bytes.toString('ascii', 0, 128).trimStart().startsWith('ISO-10303-21;'),
      'unsupported_format',
      'Expected STEP Part 21.',
    );
    const dir = await this.artifacts.directory();
    const snapshot = await this.artifacts.put(dir, 'source.step', bytes, 'step');
    const { response, logs } = await this.worker(
      dir,
      { operation: 'inspect', source: 'source.step' },
      signal,
    );
    const inventory = inventorySchema.parse(response);
    if (input.source?.units)
      requireThat(
        input.source.units === inventory.sourceUnits,
        'invalid_input',
        'Artifact units disagree with STEP declaration.',
      );
    const source = artifactSchema.parse({
      ...snapshot,
      units: inventory.sourceUnits,
    });
    if (input.source) await this.artifacts.verify(input.source, 'step');
    else
      requireThat(
        digest(await this.artifacts.bytes(input.uri!)) === source.revision,
        'stale_artifact',
        'Source changed during inspection.',
      );
    const inspection = await this.artifacts.put(
      dir,
      'inspection.json',
      JSON.stringify({ source, inventory }),
      'json',
    );
    return { source, inspection, inventory, logs };
  }
  async queryModel(input: {
    model: ArtifactRef;
    dimension?: 2 | 3;
    cursor?: string;
    limit?: number;
  }) {
    const document = await this.artifacts.json(input.model, inspectionSchema);
    const limit = input.limit ?? 50;
    requireThat(
      Number.isInteger(limit) && limit > 0 && limit <= 200,
      'invalid_input',
      'limit must be an integer between 1 and 200.',
    );
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    requireThat(
      Number.isSafeInteger(offset) && offset >= 0,
      'invalid_input',
      'Invalid entity pagination cursor.',
    );
    const entities = document.inventory.entities.filter(
      (entity) => input.dimension === undefined || entity.dimension === input.dimension,
    );
    const page = entities.slice(offset, offset + limit);
    return {
      entities: page.map((entity) => ({
        id: `${entity.dimension}:${entity.tag}`,
        dimension: entity.dimension,
        label: entity.label,
        bounds: entity.bounds,
        center: entity.center,
        measure: { value: entity.measure, units: entity.measureUnits },
        adjacentVolumes: entity.adjacentVolumes,
      })),
      ...(offset + limit < entities.length ? { nextCursor: String(offset + limit) } : {}),
    };
  }
  async validateStudy(input: unknown) {
    const parsed = studySchema.safeParse(input);
    if (!parsed.success)
      return {
        valid: false,
        issues: parsed.error.issues.map((issue) => ({
          severity: 'error' as const,
          code: 'invalid_study',
          path: `/${issue.path.join('/')}`,
          message: issue.message,
        })),
        deferredChecks: [],
      };
    const study = parsed.data;
    const issues: {
      severity: 'error' | 'warning' | 'info';
      code: string;
      path?: string;
      message: string;
    }[] = [];
    // Only error-severity issues block a study; warnings are advisory and must
    // not skip the remaining checks.
    const hasError = () => issues.some((issue) => issue.severity === 'error');
    try {
      await this.artifacts.verify(study.model.source, 'step');
      const inspection = await this.artifacts.json(study.model.inspection, inspectionSchema);
      requireThat(
        inspection.source.revision === study.model.source.revision,
        'stale_artifact',
        'Inspection does not match the supplied model revision.',
      );
      const names = study.selections.map((selection) => selection.name);
      const selectedIds = study.selections.flatMap((selection) => selection.entities);
      const validIds = new Set(
        inspection.inventory.entities.map((entity) => `${entity.dimension}:${entity.tag}`),
      );
      requireThat(
        new Set(names).size === names.length &&
          new Set(selectedIds).size === selectedIds.length &&
          selectedIds.length === validIds.size &&
          selectedIds.every((entityId) => validIds.has(entityId)),
        'invalid_study',
        'Selections must uniquely cover every inspected entity exactly once.',
      );
      requireThat(
        study.selections.every(
          (selection) =>
            new Set(selection.entities.map((entityId) => Number(entityId.split(':')[0]))).size ===
            1,
        ),
        'invalid_study',
        'Each selection must contain entities of exactly one dimension.',
      );
      requireThat(
        study.selections
          .filter((selection) => selection.entities[0]!.startsWith('3:'))
          .every((selection) => selection.entities.length === 1),
        'invalid_study',
        'Each volume selection must contain exactly one solid.',
      );
      // Advisory: mesh sizes are in meters, and a millimeter value here silently
      // produces a near-single-element mesh. Never blocks the run.
      const solids = inspection.inventory.entities.filter((entity) => entity.dimension === 3);
      if (solids.length) {
        const smallest = Math.min(
          ...solids.map((entity) =>
            Math.min(
              entity.bounds[3] - entity.bounds[0],
              entity.bounds[4] - entity.bounds[1],
              entity.bounds[5] - entity.bounds[2],
            ),
          ),
        );
        if (Number.isFinite(smallest) && smallest > 0 && study.mesh.maxSize > smallest)
          issues.push({
            severity: 'warning',
            code: 'mesh_size_large',
            path: '/mesh/maxSize',
            message: `mesh.maxSize (${study.mesh.maxSize} m) is not smaller than the model's smallest dimension (${smallest} m); mesh sizes are in meters.`,
          });
      }
    } catch (error) {
      const data = errorData(error);
      issues.push({
        severity: 'error',
        code: data.code,
        path: data.code === 'invalid_study' ? '/selections' : '/model',
        message: data.message,
      });
    }
    if (
      !hasError() &&
      (study.physics.kind === 'steady-thermal' || study.physics.kind === 'transient-thermal')
    ) {
      try {
        await this.artifacts.verify(study.model.source, 'step');
        const inspection = await this.artifacts.json(study.model.inspection, inspectionSchema);
        requireThat(
          inspection.source.revision === study.model.source.revision,
          'stale_artifact',
          'Inspection does not match the supplied model revision.',
        );
        const names = study.selections.map((selection) => selection.name);
        requireThat(
          new Set(names).size === names.length,
          'invalid_study',
          'Selection names must be unique.',
        );
        const selectedTags = study.selections.flatMap((selection) => selection.entities);
        requireThat(
          new Set(selectedTags).size === selectedTags.length,
          'invalid_study',
          'An entity cannot belong to multiple selections.',
        );
        requireThat(
          selectedTags.length === inspection.inventory.entities.length &&
            inspection.inventory.entities.every((entity) =>
              selectedTags.includes(`${entity.dimension}:${entity.tag}`),
            ),
          'invalid_study',
          'Selections must cover every inspected solid and surface exactly once.',
        );
        const dimensions = new Map(
          study.selections.map((selection) => [
            selection.name,
            new Set(selection.entities.map((entityId) => Number(entityId.split(':')[0]))),
          ]),
        );
        requireThat(
          [...dimensions.values()].every((dimension) => dimension.size === 1),
          'invalid_study',
          'Each selection must contain known entities of one dimension.',
        );
        const volumes = names.filter((name) => dimensions.get(name)?.has(3));
        const surfaces = names.filter((name) => dimensions.get(name)?.has(2));
        requireThat(
          study.selections
            .filter((selection) => dimensions.get(selection.name)?.has(3))
            .every((selection) => selection.entities.length === 1),
          'invalid_study',
          'Each solid selection must contain exactly one solid.',
        );
        requireThat(
          study.physics.materials.length === volumes.length &&
            new Set(study.physics.materials.map((material) => material.selection)).size ===
              volumes.length &&
            study.physics.materials.every((material) => volumes.includes(material.selection)),
          'invalid_study',
          'Assign exactly one material to each solid selection.',
        );
        requireThat(
          new Set(study.physics.boundaries.map((boundary) => boundary.selection)).size ===
            study.physics.boundaries.length &&
            study.physics.boundaries.every((boundary) => surfaces.includes(boundary.selection)),
          'invalid_study',
          'Boundary overrides must uniquely reference surface selections.',
        );
        requireThat(
          study.physics.sources.every((source) => volumes.includes(source.selection)),
          'invalid_study',
          'Heat sources must reference solid selections.',
        );
        const observationIds = study.observations.map((observation) => observation.id);
        requireThat(
          new Set(observationIds).size === observationIds.length &&
            study.acceptanceCriteria.every((criterion) =>
              observationIds.includes(criterion.observationId),
            ),
          'invalid_study',
          'Observation IDs must be unique and acceptance criteria must reference an observation.',
        );
        const expectedUnits = physicsByStudy(study.physics.kind).observationUnits;
        requireThat(
          study.observations.every(
            (observation) => expectedUnits[observation.quantity] !== undefined && !observation.mode,
          ) &&
            study.acceptanceCriteria.every((criterion) => {
              const observation = study.observations.find(
                (item) => item.id === criterion.observationId,
              )!;
              return acceptanceThresholdMatches(
                criterion.threshold,
                expectedUnits[observation.quantity],
              );
            }),
          'invalid_study',
          'Acceptance threshold units must match the observed quantity.',
        );
        if (study.physics.kind === 'transient-thermal') {
          const timing = study.physics.time;
          const horizon = timing.steps * timing.timestep.value;
          requireThat(
            Number.isFinite(horizon) &&
              study.observations.every((observation) => {
                if (!observation.time) return true;
                const requestedTime = observation.time.value;
                const step = requestedTime / timing.timestep.value;
                return (
                  requestedTime > 0 &&
                  requestedTime <= horizon &&
                  Math.abs(step - Math.round(step)) <= 1e-9
                );
              }),
            'invalid_study',
            'Transient observation times must be positive, within the run horizon, and aligned to a timestep.',
          );
        } else {
          requireThat(
            study.observations.every((observation) => !observation.time),
            'invalid_study',
            'Observation times are only valid for transient-thermal studies.',
          );
        }
      } catch (error) {
        const data = errorData(error);
        issues.push({
          severity: 'error' as const,
          code: data.code,
          message: data.message,
        });
      }
    }
    if (!hasError() && study.physics.kind === 'static-structural') {
      try {
        await this.artifacts.verify(study.model.source, 'step');
        const inspection = await this.artifacts.json(study.model.inspection, inspectionSchema);
        requireThat(
          inspection.source.revision === study.model.source.revision,
          'stale_artifact',
          'Inspection does not match the supplied model revision.',
        );
        const names = study.selections.map((selection) => selection.name);
        const entityIds = study.selections.flatMap((selection) => selection.entities);
        requireThat(
          new Set(names).size === names.length &&
            new Set(entityIds).size === entityIds.length &&
            entityIds.length === inspection.inventory.entities.length &&
            inspection.inventory.entities.every((entity) =>
              entityIds.includes(`${entity.dimension}:${entity.tag}`),
            ),
          'invalid_study',
          'Selections must uniquely cover every inspected solid and surface.',
        );
        const dims = new Map(
          study.selections.map((selection) => [
            selection.name,
            new Set(selection.entities.map((entity) => Number(entity.split(':')[0]))),
          ]),
        );
        requireThat(
          [...dims.values()].every((set) => set.size === 1) &&
            study.selections
              .filter((selection) => dims.get(selection.name)?.has(3))
              .every((selection) => selection.entities.length === 1),
          'invalid_study',
          'Each selection must contain one dimension; solid selections must contain one solid.',
        );
        const volumes = names.filter((name) => dims.get(name)?.has(3));
        const surfaces = names.filter((name) => dims.get(name)?.has(2));
        requireThat(
          study.physics.materials.length === volumes.length &&
            new Set(study.physics.materials.map((item) => item.selection)).size ===
              volumes.length &&
            study.physics.materials.every((item) => volumes.includes(item.selection)),
          'invalid_study',
          'Assign exactly one elastic material to each solid selection.',
        );
        requireThat(
          study.physics.boundaries.length === surfaces.length &&
            new Set(study.physics.boundaries.map((item) => item.selection)).size ===
              surfaces.length &&
            study.physics.boundaries.every((item) => surfaces.includes(item.selection)),
          'invalid_study',
          'Assign exactly one explicit displacement, traction, or free condition to every surface selection.',
        );
        const observationIds = study.observations.map((item) => item.id);
        const expectedUnits = physicsByStudy(study.physics.kind).observationUnits;
        requireThat(
          new Set(observationIds).size === observationIds.length &&
            study.observations.every(
              (observation) =>
                !observation.time &&
                !observation.mode &&
                expectedUnits[observation.quantity] !== undefined,
            ) &&
            study.acceptanceCriteria.every((criterion) => {
              const observation = study.observations.find(
                (item) => item.id === criterion.observationId,
              );
              return (
                observation &&
                acceptanceThresholdMatches(criterion.threshold, expectedUnits[observation.quantity])
              );
            }),
          'invalid_study',
          'Structural observation IDs must be unique and acceptance units must match their quantities.',
        );
      } catch (error) {
        const data = errorData(error);
        issues.push({
          severity: 'error',
          code: data.code,
          message: data.message,
        });
      }
    }
    if (!hasError() && study.physics.kind === 'modal') {
      try {
        await this.artifacts.verify(study.model.source, 'step');
        const inspection = await this.artifacts.json(study.model.inspection, inspectionSchema);
        requireThat(
          inspection.source.revision === study.model.source.revision,
          'stale_artifact',
          'Inspection does not match the supplied model revision.',
        );
        const names = study.selections.map((selection) => selection.name);
        const entities = study.selections.flatMap((selection) => selection.entities);
        requireThat(
          new Set(names).size === names.length &&
            new Set(entities).size === entities.length &&
            entities.length === inspection.inventory.entities.length &&
            inspection.inventory.entities.every((entity) =>
              entities.includes(`${entity.dimension}:${entity.tag}`),
            ),
          'invalid_study',
          'Selections must uniquely cover every inspected solid and surface.',
        );
        const dims = new Map(
          study.selections.map((selection) => [
            selection.name,
            new Set(selection.entities.map((entity) => Number(entity.split(':')[0]))),
          ]),
        );
        requireThat(
          [...dims.values()].every((set) => set.size === 1) &&
            study.selections
              .filter((selection) => dims.get(selection.name)?.has(3))
              .every((selection) => selection.entities.length === 1),
          'invalid_study',
          'Each selection must contain one dimension; solid selections must contain one solid.',
        );
        const volumes = names.filter((name) => dims.get(name)?.has(3));
        const surfaces = names.filter((name) => dims.get(name)?.has(2));
        requireThat(
          study.physics.materials.length === volumes.length &&
            new Set(study.physics.materials.map((item) => item.selection)).size ===
              volumes.length &&
            study.physics.materials.every((item) => volumes.includes(item.selection)),
          'invalid_study',
          'Assign exactly one density and elastic material to each solid selection.',
        );
        requireThat(
          study.physics.boundaries.length === surfaces.length &&
            new Set(study.physics.boundaries.map((item) => item.selection)).size ===
              surfaces.length &&
            study.physics.boundaries.every((item) => surfaces.includes(item.selection)),
          'invalid_study',
          'Assign exactly one fixed-displacement or free condition to every surface selection.',
        );
        const observations = study.observations;
        const requestedModes = study.physics.modes;
        requireThat(
          new Set(observations.map((item) => item.id)).size === observations.length &&
            observations.every(
              (item) =>
                item.quantity === 'eigenfrequency' &&
                item.mode !== undefined &&
                item.mode <= requestedModes &&
                !item.time,
            ) &&
            study.acceptanceCriteria.every((criterion) => {
              const observation = observations.find((item) => item.id === criterion.observationId);
              return observation && acceptanceThresholdMatches(criterion.threshold, 'Hz');
            }),
          'invalid_study',
          'Modal observations must request a mode from the solved range and use Hz acceptance thresholds.',
        );
      } catch (error) {
        const data = errorData(error);
        issues.push({
          severity: 'error',
          code: data.code,
          message: data.message,
        });
      }
    }
    if (!hasError() && study.physics.kind === 'dc-conduction') {
      try {
        await this.artifacts.verify(study.model.source, 'step');
        const inspection = await this.artifacts.json(study.model.inspection, inspectionSchema);
        requireThat(
          inspection.source.revision === study.model.source.revision,
          'stale_artifact',
          'Inspection does not match the supplied model revision.',
        );
        const names = study.selections.map((selection) => selection.name);
        const entities = study.selections.flatMap((selection) => selection.entities);
        requireThat(
          new Set(names).size === names.length &&
            new Set(entities).size === entities.length &&
            entities.length === inspection.inventory.entities.length &&
            inspection.inventory.entities.every((entity) =>
              entities.includes(`${entity.dimension}:${entity.tag}`),
            ),
          'invalid_study',
          'Selections must uniquely cover every inspected solid and surface.',
        );
        const dims = new Map(
          study.selections.map((selection) => [
            selection.name,
            new Set(selection.entities.map((entity) => Number(entity.split(':')[0]))),
          ]),
        );
        requireThat(
          [...dims.values()].every((set) => set.size === 1) &&
            study.selections
              .filter((selection) => dims.get(selection.name)?.has(3))
              .every((selection) => selection.entities.length === 1),
          'invalid_study',
          'Each selection must contain one dimension; solid selections must contain one solid.',
        );
        const volumes = names.filter((name) => dims.get(name)?.has(3));
        const surfaces = names.filter((name) => dims.get(name)?.has(2));
        requireThat(
          study.physics.materials.length === volumes.length &&
            new Set(study.physics.materials.map((item) => item.selection)).size ===
              volumes.length &&
            study.physics.materials.every((item) => volumes.includes(item.selection)),
          'invalid_study',
          'Assign exactly one electrical conductivity to each solid selection.',
        );
        requireThat(
          study.physics.boundaries.length === surfaces.length &&
            new Set(study.physics.boundaries.map((item) => item.selection)).size ===
              surfaces.length &&
            study.physics.boundaries.every((item) => surfaces.includes(item.selection)),
          'invalid_study',
          'Assign exactly one potential or insulated condition to every surface selection.',
        );
        const expectedUnits = physicsByStudy(study.physics.kind).observationUnits;
        requireThat(
          new Set(study.observations.map((item) => item.id)).size === study.observations.length &&
            study.observations.every(
              (item) => expectedUnits[item.quantity] !== undefined && !item.time && !item.mode,
            ) &&
            study.acceptanceCriteria.every((criterion) => {
              const observation = study.observations.find(
                (item) => item.id === criterion.observationId,
              );
              return (
                observation &&
                acceptanceThresholdMatches(criterion.threshold, expectedUnits[observation.quantity])
              );
            }),
          'invalid_study',
          'DC observations must use supported potential quantities and volts.',
        );
      } catch (error) {
        const data = errorData(error);
        issues.push({
          severity: 'error',
          code: data.code,
          message: data.message,
        });
      }
    }
    if (!hasError() && study.physics.kind === 'laminar-flow') {
      try {
        const names = study.selections.map((selection) => selection.name);
        const volumes = study.selections
          .filter((selection) => selection.entities.every((entity) => entity.startsWith('3:')))
          .map((selection) => selection.name);
        const surfaces = study.selections
          .filter((selection) => selection.entities.every((entity) => entity.startsWith('2:')))
          .map((selection) => selection.name);
        requireThat(
          new Set(names).size === names.length &&
            study.physics.materials.length === volumes.length &&
            new Set(study.physics.materials.map((item) => item.selection)).size ===
              volumes.length &&
            study.physics.materials.every((item) => volumes.includes(item.selection)),
          'invalid_study',
          'Assign density and dynamic viscosity exactly once to each fluid volume selection.',
        );
        requireThat(
          study.physics.boundaries.length === surfaces.length &&
            new Set(study.physics.boundaries.map((item) => item.selection)).size ===
              surfaces.length &&
            study.physics.boundaries.every((item) => surfaces.includes(item.selection)),
          'invalid_study',
          'Assign explicit pressure or no-slip to every surface selection.',
        );
        if (study.physics.regime.mode === 'transient')
          requireThat(
            study.physics.regime.initialVelocity.every((item) => item.value === 0),
            'unsupported_condition',
            'Transient flow currently requires quiescent initial velocity.',
          );
        const expectedUnits = physicsByStudy(study.physics.kind).observationUnits;
        requireThat(
          new Set(study.observations.map((item) => item.id)).size === study.observations.length &&
            study.observations.every(
              (item) => expectedUnits[item.quantity] !== undefined && !item.mode,
            ) &&
            study.acceptanceCriteria.every((criterion) => {
              const observation = study.observations.find(
                (item) => item.id === criterion.observationId,
              );
              return (
                observation &&
                acceptanceThresholdMatches(criterion.threshold, expectedUnits[observation.quantity])
              );
            }),
          'invalid_study',
          'Flow observations must use supported velocity or pressure quantities and matching SI units.',
        );
        if (study.physics.regime.mode === 'transient') {
          const { timestep, steps } = study.physics.regime.time;
          const horizon = timestep.value * steps;
          requireThat(
            Number.isFinite(horizon) &&
              study.observations.every((item) => {
                if (!item.time) return true;
                const step = item.time.value / timestep.value;
                return (
                  item.time.value > 0 &&
                  item.time.value <= horizon &&
                  Math.abs(step - Math.round(step)) <= 1e-9
                );
              }),
            'invalid_study',
            'Transient flow observation times must be positive, within the run horizon, and timestep-aligned.',
          );
        } else {
          requireThat(
            study.observations.every((item) => !item.time),
            'invalid_study',
            'Steady flow observations cannot specify a time.',
          );
        }
      } catch (error) {
        const data = errorData(error);
        issues.push({
          severity: 'error',
          code: data.code,
          message: data.message,
        });
      }
    }
    if (!hasError()) {
      const condition = necessaryStudyCondition(study.physics);
      if (condition)
        issues.push({
          severity: 'error',
          code: 'invalid_study',
          path: '/physics',
          message: condition,
        });
    }
    return {
      valid: !hasError(),
      issues,
      deferredChecks: [
        'Per-component requirements (a fixed-temperature/potential/displacement datum and two distinct prescribed values per disconnected body), mesh validity, boundary-node conflicts, and solver convergence are checked during preparation or execution.',
      ],
    };
  }
  async propose(
    source: ArtifactRef,
    inspection: ArtifactRef,
    controls: z.infer<typeof controlsSchema>,
  ) {
    controlsSchema.parse(controls);
    await this.artifacts.verify(source, 'step');
    const document = await this.artifacts.json(inspection, inspectionSchema);
    requireThat(
      document.source.revision === source.revision,
      'stale_artifact',
      'Inspection belongs to a different STEP revision.',
    );
    return {
      source,
      inspection,
      controls,
      inventory: document.inventory,
      diagnostics: [
        'Confirm explicit physical groups for every listed volume and surface before generation. No groups are auto-selected.',
      ],
    };
  }
  async mesh(
    source: ArtifactRef,
    inspection: ArtifactRef,
    controlsInput: unknown,
    groupsInput: unknown,
    signal?: AbortSignal,
  ) {
    const controls = controlsSchema.parse(controlsInput);
    const groups = z.array(groupSchema).min(1).parse(groupsInput);
    const bytes = await this.artifacts.verify(source, 'step');
    const document = await this.artifacts.json(inspection, inspectionSchema);
    requireThat(
      document.source.revision === source.revision,
      'stale_artifact',
      'Inventory belongs to another STEP revision.',
    );
    validateGroups(groups, document.inventory);
    const dir = await this.artifacts.directory();
    const staged = await this.artifacts.put(
      dir,
      'source.step',
      bytes,
      'step',
      document.inventory.sourceUnits,
    );
    const { response, logs } = await this.worker(
      dir,
      {
        operation: 'mesh',
        source: 'source.step',
        expectedInventory: document.inventory,
        controls,
        groups,
        output: 'mesh.msh',
      },
      signal,
    );
    const generated = workerMeshSchema.parse(response);
    requireThat(
      JSON.stringify(generated.inventory) === JSON.stringify(document.inventory),
      'stale_artifact',
      'Importer/topology changed; inspect source again.',
    );
    const converted = await runProcess(
      this.settings.elmerGrid,
      ['14', '2', 'mesh.msh', '-out', 'mesh'],
      dir,
      'elmergrid',
      this.settings.timeoutMs,
      signal,
    );
    const conversionLogs = await this.logs(dir, 'elmergrid');
    const failure = termination(converted, 'conversion_failed');
    if (failure)
      throw new SimulationError(failure, 'ElmerGrid conversion failed.', {
        logs: [...logs, ...conversionLogs],
      });
    const contents = Object.fromEntries(
      await Promise.all(
        meshFiles.map(async (name) => [
          name,
          (await this.artifacts.bytes(pathToFileURL(join(dir, 'mesh', name)).href)).toString(),
        ]),
      ),
    ) as Record<(typeof meshFiles)[number], string>;
    const gmsh = await this.artifacts.capture(join(dir, 'mesh.msh'), 'gmsh-msh', 'm');
    const correspondence = validateConversion(
      (await this.artifacts.verify(gmsh)).toString(),
      contents,
      generated.groups,
    );
    requireThat(
      correspondence.nodeCount === generated.nodeCount &&
        correspondence.elementCount === generated.elementCount,
      'bad_mesh',
      'Worker/native mesh counts disagree.',
    );
    const files = Object.fromEntries(
      await Promise.all(
        meshFiles.map(async (name) => [
          name,
          await this.artifacts.capture(join(dir, 'mesh', name), 'elmer-mesh', 'm'),
        ]),
      ),
    ) as Mesh['files'];
    await this.artifacts.verify(source, 'step');
    await this.artifacts.verify(inspection, 'json');
    const mesh = meshSchema.parse({
      kind: 'simulation-mesh-v1',
      source: staged,
      inventory: inspection,
      controls,
      groups: generated.groups,
      gmsh,
      files,
      gmshVersion: generated.inventory.gmshVersion,
      elmerGridVersion: version(converted, 'ElmerGrid'),
      minimumQuality: generated.minimumQuality,
      ...correspondence,
      logs: [...logs, ...conversionLogs],
      diagnostics: [
        'ASCII MSH2.2; linear tetrahedra; native group membership checked by coordinates/connectivity.',
        'SI mesh coordinates. No geometry repair, fragmentation or contact modelling.',
      ],
    });
    const artifact = await this.artifacts.put(dir, 'mesh.json', JSON.stringify(mesh), 'json');
    return { mesh: artifact, metadata: mesh };
  }
  async loadMesh(ref: ArtifactRef) {
    const mesh = await this.artifacts.json(ref, meshSchema);
    await this.artifacts.verify(mesh.source, 'step');
    const inspection = await this.artifacts.json(mesh.inventory, inspectionSchema);
    requireThat(
      inspection.source.revision === mesh.source.revision &&
        inspection.inventory.gmshVersion === mesh.gmshVersion,
      'stale_artifact',
      'Mesh provenance mismatch.',
    );
    validateGroups(mesh.groups, inspection.inventory);
    const contents = Object.fromEntries(
      await Promise.all(
        meshFiles.map(async (name) => {
          requireThat(mesh.files[name].units === 'm', 'bad_mesh', 'Native mesh must use meters.');
          return [name, (await this.artifacts.verify(mesh.files[name], 'elmer-mesh')).toString()];
        }),
      ),
    ) as Record<(typeof meshFiles)[number], string>;
    const checked = validateConversion(
      (await this.artifacts.verify(mesh.gmsh, 'gmsh-msh')).toString(),
      contents,
      mesh.groups,
    );
    requireThat(
      JSON.stringify(checked.connectedBodies) === JSON.stringify(mesh.connectedBodies) &&
        JSON.stringify(checked.boundaryBodies) === JSON.stringify(mesh.boundaryBodies) &&
        checked.nodeCount === mesh.nodeCount &&
        checked.elementCount === mesh.elementCount,
      'bad_mesh',
      'Mesh metadata no longer matches its constituent files.',
    );
    return { mesh, contents };
  }
  async configure(meshRef: ArtifactRef, input: unknown) {
    const { mesh, contents } = await this.loadMesh(meshRef);
    const physics =
      typeof input === 'object' &&
      input !== null &&
      'physics' in input &&
      typeof input.physics === 'string'
        ? (input.physics as CaseConfig['physics'])
        : 'steady-heat-conduction';
    const module = physicsByCase(physics);
    const config = module.normalize(input, mesh);
    const sifText = module.generate(config);
    checkBoundaryNodeConflicts(config, contents['mesh.boundary']);
    const dir = await this.artifacts.directory();
    const sif = await this.artifacts.put(dir, 'case.sif', sifText, 'elmer-sif');
    const document = caseSchema.parse({
      kind: 'simulation-case-v1',
      mesh: meshRef,
      config,
      sif,
    });
    const artifact = await this.artifacts.put(dir, 'case.json', JSON.stringify(document), 'json');
    return { case: artifact, configuration: document };
  }
  async prepareStudy(input: unknown, signal?: AbortSignal) {
    const study = studySchema.parse(input);
    const dir = await this.artifacts.directory();
    const studyRef = await this.artifacts.put(dir, 'study.json', JSON.stringify(study), 'json');
    const state: PreparationJob = {
      jobId: basename(dir),
      kind: 'prepare',
      status: 'preparing',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      study: studyRef,
      diagnostics: [],
      artifacts: [],
    };
    await this.persistPreparation(dir, state);
    const abort = new AbortController();
    // A cancelled or timed-out client request stops the mesh instead of
    // leaving it running unattended (spec: servers SHOULD stop on cancellation).
    const onAbort = () => abort.abort();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const entry: ActivePreparation = { abort, state, done: Promise.resolve() };
    this.preparations.set(state.jobId, entry);
    entry.done = this.executePreparation(dir, state, study, abort.signal)
      .finally(() => signal?.removeEventListener('abort', onAbort))
      .catch(async () => {
        if (abort.signal.aborted) return;
        state.status = 'failed';
        state.error = {
          code: 'persistence_failed',
          message: 'Could not persist preparation status; inspect the workspace.',
        };
        // Best-effort persist so a crash outside the inner try/finally does not
        // leave a stale "preparing" record on disk.
        await this.persistPreparation(dir, state).catch(() => {});
      })
      .finally(() => this.preparations.delete(state.jobId));
    return structuredClone(state);
  }
  private async executePreparation(
    dir: string,
    state: PreparationJob,
    study: Study,
    signal: AbortSignal,
  ) {
    try {
      const result = await this.buildStudy(study, signal);
      state.prepared = result.prepared;
      state.diagnostics = result.document.diagnostics;
      state.status = 'succeeded';
    } catch (error) {
      const data = errorData(error);
      const validationDetails =
        error instanceof SimulationError &&
        error.details &&
        typeof error.details === 'object' &&
        'issues' in error.details &&
        Array.isArray(error.details.issues)
          ? error.details.issues
              .map((issue) => {
                if (!issue || typeof issue !== 'object') return undefined;
                const item = issue as { path?: unknown; message?: unknown };
                return `${typeof item.path === 'string' ? `${item.path}: ` : ''}${typeof item.message === 'string' ? item.message : 'Invalid study input.'}`;
              })
              .filter((issue): issue is string => issue !== undefined)
          : [];
      const message = validationDetails.length
        ? `${data.message} ${validationDetails.join(' ')}`
        : data.message;
      state.status =
        data.code === 'cancelled' ? 'cancelled' : data.code === 'timeout' ? 'timeout' : 'failed';
      state.error = { code: data.code, message };
      state.diagnostics.push(message);
      if (
        error instanceof SimulationError &&
        error.details &&
        typeof error.details === 'object' &&
        'logs' in error.details &&
        Array.isArray(error.details.logs)
      ) {
        state.artifacts = error.details.logs.filter(
          (ref): ref is ArtifactRef => artifactSchema.safeParse(ref).success,
        );
      }
    } finally {
      state.endedAt = new Date().toISOString();
      try {
        await this.persistPreparation(dir, state);
      } catch {
        state.status = 'failed';
        state.error = {
          code: 'persistence_failed',
          message: 'Could not persist preparation status; inspect the workspace.',
        };
      }
    }
  }
  private async buildStudy(study: Study, signal?: AbortSignal) {
    const validation = await this.validateStudy(study);
    if (!validation.valid)
      throw new SimulationError('invalid_study', 'Study validation failed.', {
        issues: validation.issues,
      });
    if (
      study.physics.kind !== 'steady-thermal' &&
      study.physics.kind !== 'transient-thermal' &&
      study.physics.kind !== 'static-structural' &&
      study.physics.kind !== 'modal' &&
      study.physics.kind !== 'dc-conduction' &&
      study.physics.kind !== 'laminar-flow'
    )
      throw new SimulationError('unsupported_physics', 'Physics is not available yet.');
    await this.artifacts.verify(study.model.source, 'step');
    const inspection = await this.artifacts.json(study.model.inspection, inspectionSchema);
    requireThat(
      inspection.source.revision === study.model.source.revision,
      'stale_artifact',
      'Model inspection belongs to another STEP revision.',
    );
    const controls = controlsSchema.parse({
      minSize: study.mesh.minSize,
      maxSize: study.mesh.maxSize,
      units: 'm',
    });
    const selected = new Map<string, { dimension: 2 | 3; entities: number[] }>();
    for (const selection of study.selections) {
      const dimensions = new Set(
        selection.entities.map((entityId) => Number(entityId.split(':')[0])),
      );
      requireThat(
        dimensions.size === 1,
        'invalid_selection',
        `Selection '${selection.name}' has unknown or mixed-dimension entities.`,
      );
      selected.set(selection.name, {
        dimension: [...dimensions][0] as 2 | 3,
        entities: selection.entities.map((entityId) => Number(entityId.split(':')[1])),
      });
    }
    const groups = study.selections.map((selection, index) => ({
      id: index + 1,
      name: selection.name,
      ...selected.get(selection.name)!,
    }));
    const meshed = await this.mesh(
      study.model.source,
      study.model.inspection,
      controls,
      groups,
      signal,
    );
    const groupId = new Map(
      study.selections.map((selection, index) => [selection.name, index + 1]),
    );
    const module = physicsByStudy(study.physics.kind);
    const config = module.build(study.physics, {
      groupId,
      surfaces: study.selections
        .filter((selection) => selected.get(selection.name)!.dimension === 2)
        .map((selection) => selection.name),
    });
    const configured = await this.configure(meshed.mesh, config);
    requireThat(
      !signal?.aborted,
      'cancelled',
      'Study preparation was cancelled before publishing its prepared artifact.',
    );
    return this.publishPrepared(
      study,
      meshed,
      configured.case,
      module.diagnostics(study.physics),
      signal,
    );
  }
  // Shared prepared-study publication: one place that builds the document,
  // persists it, and re-checks cancellation for every physics kind.
  private async publishPrepared(
    study: Study,
    meshed: Awaited<ReturnType<Simulation['mesh']>>,
    caseRef: ArtifactRef,
    diagnostics: string[],
    signal?: AbortSignal,
  ) {
    const document = preparedStudySchema.parse({
      kind: 'simulation-prepared-study-v1',
      study,
      mesh: meshed.mesh,
      case: caseRef,
      diagnostics: [...meshed.metadata.diagnostics, ...diagnostics],
    });
    const prepared = await this.artifacts.put(
      await this.artifacts.directory(),
      'prepared-study.json',
      JSON.stringify(document),
      'json',
    );
    requireThat(
      !signal?.aborted,
      'cancelled',
      'Study preparation was cancelled before completion.',
    );
    return { prepared, document };
  }
  async runStudy(preparedRef: ArtifactRef, signal?: AbortSignal) {
    const prepared = await this.artifacts.json(preparedRef, preparedStudySchema);
    const job = await this.start(prepared.case, preparedRef);
    // Stop the solver if the caller goes away. Cancellation is cooperative: the
    // run record ends as `cancelled` whether or not the process had begun.
    const startedJob = job as { runId?: string; jobId?: string };
    const jobId = startedJob.runId ?? startedJob.jobId;
    if (jobId) onAbort(signal, () => void this.cancel(jobId).catch(() => {}));
    return job;
  }
  /**
   * Wait up to `waitMs` for a job to reach a terminal state, then return it.
   * Polling happens in-process, so a caller replaces dozens of round-trips
   * with one call. Returns the current state either way.
   */
  async waitForJob(jobId: string, waitMs: number) {
    return pollUntilTerminal(() => this.inspectJob(jobId), waitMs);
  }

  async inspectJob(jobId: string) {
    id.parse(jobId);
    const livePreparation = this.preparations.get(jobId);
    if (livePreparation) return structuredClone(livePreparation.state);
    try {
      const state = preparationJobSchema.parse(
        JSON.parse(
          (
            await this.artifacts.bytes(
              pathToFileURL(join(this.artifacts.workspace, jobId, 'prep-status.json')).href,
            )
          ).toString(),
        ),
      );
      if (state.status === 'preparing') {
        state.status = 'interrupted';
        state.endedAt = new Date().toISOString();
        state.diagnostics.push(
          'Preparation was interrupted by server shutdown and will not resume automatically.',
        );
        await this.persistPreparation(join(this.artifacts.workspace, jobId), state);
      }
      await this.artifacts.verify(state.study, 'json');
      if (state.prepared) await this.artifacts.json(state.prepared, preparedStudySchema);
      return state;
    } catch (error) {
      if (errorData(error).code !== 'file_not_found') throw error;
    }
    const run = await this.status(jobId);
    const { runId, ...job } = run;
    return { ...job, jobId: runId };
  }
  async cancelJob(jobId: string) {
    id.parse(jobId);
    const preparation = this.preparations.get(jobId);
    if (preparation) {
      preparation.abort.abort();
      await preparation.done;
      return this.inspectJob(jobId);
    }
    // Confirm the job exists before cancelling so an unknown id surfaces
    // file_not_found rather than a misleading invalid_input.
    const job = await this.inspectJob(jobId);
    if (job.kind === 'prepare') return job;
    await this.cancel(jobId);
    return this.inspectJob(jobId);
  }
  async listJobs() {
    const entries = await readdir(this.artifacts.workspace, {
      withFileTypes: true,
    });
    const jobs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return operationJobSchema.parse(await this.inspectJob(entry.name));
          } catch {
            return undefined;
          }
        }),
    );
    return {
      jobs: jobs
        .filter((job): job is z.infer<typeof operationJobSchema> => job !== undefined)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100)
        .map((job) => ({
          jobId: job.jobId,
          kind: job.kind,
          status: job.status,
          createdAt: job.createdAt,
          endedAt: job.endedAt,
          error: job.error,
        })),
    };
  }
  async queryResults(jobId: string, options: QueryResultsOptions = {}) {
    const job = await this.inspectJob(jobId);
    requireThat(
      job.kind === 'solve',
      'invalid_job_kind',
      'Results are available only for solver jobs.',
    );
    const run = await this.status(jobId);
    const prepared = run.prepared
      ? await this.artifacts.json(run.prepared, preparedStudySchema)
      : undefined;
    const regime = prepared?.study.physics;
    const finalTime =
      regime?.kind === 'transient-thermal'
        ? regime.time.steps * regime.time.timestep.value
        : regime?.kind === 'laminar-flow' && regime.regime.mode === 'transient'
          ? regime.regime.time.steps * regime.regime.time.timestep.value
          : undefined;
    const backing = new Map<string, (typeof run.summaries)[number]>();
    const observations: {
      id: string;
      quantity: string;
      status: 'available' | 'inconclusive';
      value?: number;
      units?: string;
      method?: string;
      evidence?: ArtifactRef[];
      reason?: string;
      time?: { value: number; units: 's' };
      mode?: number;
    }[] = (prepared?.study.observations ?? [])
      .filter(
        (observation) => !options.observations || options.observations.includes(observation.id),
      )
      .map((observation) => {
        // An explicit observation time wins; otherwise a query-level time
        // selects the frame, falling back to the final timestep.
        const sampleTime = observation.time?.value ?? options.time ?? finalTime;
        const summaryName =
          observation.quantity === 'eigenfrequency' && observation.mode
            ? `eigenfrequency_mode_${observation.mode}`
            : observation.quantity;
        const summary = run.summaries.find(
          (item) =>
            item.name === summaryName &&
            (sampleTime === undefined
              ? item.time === undefined
              : item.time !== undefined &&
                Math.abs(item.time.value - sampleTime) <=
                  Math.max(1, Math.abs(sampleTime)) * 1e-10),
        );
        if (summary && run.status === 'succeeded')
          backing.set(`${summary.name}@${summary.time?.value ?? ''}`, summary);
        return {
          id: observation.id,
          quantity: observation.quantity,
          ...(observation.mode === undefined ? {} : { mode: observation.mode }),
          status:
            summary && run.status === 'succeeded'
              ? ('available' as const)
              : ('inconclusive' as const),
          ...(summary && run.status === 'succeeded'
            ? {
                value: summary.value,
                units: summary.units,
                method: summary.method,
                evidence: [summary.source],
                ...(sampleTime === undefined
                  ? {}
                  : { time: { value: sampleTime, units: 's' as const } }),
              }
            : { reason: 'Required validated summary is unavailable.' }),
        };
      });
    const acceptance = (prepared?.study.acceptanceCriteria ?? [])
      .filter(
        (criterion) =>
          !options.observations || options.observations.includes(criterion.observationId),
      )
      .map((criterion) => {
        const observation = observations.find((item) => item.id === criterion.observationId);
        const converted =
          observation?.status === 'available'
            ? acceptanceValues(criterion.threshold, observation)
            : undefined;
        if (!observation || !converted)
          return {
            observationId: criterion.observationId,
            status: 'inconclusive' as const,
            reason: 'Observation unavailable or threshold units are incompatible.',
          };
        const value = converted.actual;
        const threshold = converted.limit;
        const pass =
          criterion.operator === '<'
            ? value < threshold
            : criterion.operator === '<='
              ? value <= threshold
              : criterion.operator === '>'
                ? value > threshold
                : value >= threshold;
        return {
          observationId: criterion.observationId,
          status: pass ? ('pass' as const) : ('fail' as const),
          value,
          threshold,
          units: observation.units,
        };
      });
    const displayUnits = prepared?.study.displayUnits as
      Record<string, string | undefined> | undefined;
    if (displayUnits) {
      const displayUnit = (quantity: string) => {
        const dimension = OBSERVATION_DIMENSIONS[quantity];
        return dimension ? displayUnits[dimension] : undefined;
      };
      for (const observation of observations) {
        if (observation.status !== 'available') continue;
        const unit = displayUnit(observation.quantity);
        if (!unit) continue;
        observation.value = fromSI(observation.value!, unit);
        observation.units = unit;
      }
      for (const item of acceptance) {
        if (!('value' in item) || item.value === undefined || item.threshold === undefined)
          continue;
        const observation = observations.find((entry) => entry.id === item.observationId);
        const unit = observation ? displayUnit(observation.quantity) : undefined;
        if (!unit) continue;
        item.value = fromSI(item.value, unit);
        item.threshold = fromSI(item.threshold, unit);
        item.units = unit;
      }
    }
    const timeMatches = (item: (typeof run.summaries)[number]) =>
      options.time === undefined ||
      (item.time !== undefined &&
        Math.abs(item.time.value - options.time) <= Math.max(1, Math.abs(options.time)) * 1e-9);
    // Observations already contain the selected value, unit, method and source;
    // return summaries on request, or as a fallback when no observation was
    // declared. Full history remains opt-in.
    const summaries = options.include?.includes('summaries')
      ? run.summaries.filter(timeMatches)
      : observations.length === 0 && options.observations === undefined
        ? run.summaries.filter(timeMatches)
        : [];
    const fields = [
      ...new Map(
        run.results
          .flatMap((result) => result.fields)
          .map((field) => [
            `${field.name}|${field.components}|${field.association}|${field.units ?? ''}`,
            field,
          ]),
      ).values(),
    ];
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 500);
    const offset = options.cursor === undefined ? 0 : Number(options.cursor);
    requireThat(
      Number.isInteger(offset) && offset >= 0,
      'invalid_input',
      'cursor must be a non-negative integer offset.',
    );
    const artifacts = run.outputs.slice(offset, offset + limit);
    const nextCursor = offset + limit < run.outputs.length ? String(offset + limit) : undefined;
    return {
      jobId: run.runId,
      source: run.source,
      ...(run.prepared === undefined ? {} : { preparedStudy: run.prepared }),
      status: run.status,
      convergence: run.convergence,
      summaries,
      observations,
      acceptance,
      fields,
      artifacts,
      artifactCount: run.outputs.length,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      diagnostics: run.diagnostics,
      error: run.error,
    };
  }
  private async persist(dir: string, state: Run) {
    await writeFile(join(dir, 'status.tmp'), JSON.stringify(runSchema.parse(state)), {
      mode: 0o600,
    });
    await rename(join(dir, 'status.tmp'), join(dir, 'status.json'));
  }
  private async persistPreparation(dir: string, state: PreparationJob) {
    await writeFile(
      join(dir, 'prep-status.tmp'),
      JSON.stringify(preparationJobSchema.parse(state)),
      { mode: 0o600 },
    );
    await rename(join(dir, 'prep-status.tmp'), join(dir, 'prep-status.json'));
  }
  async start(caseRef: ArtifactRef, preparedRef?: ArtifactRef) {
    const document = await this.artifacts.json(caseRef, caseSchema);
    const { mesh, contents } = await this.loadMesh(document.mesh);
    const module = physicsByCase(document.config.physics);
    const config = module.normalize(document.config, mesh);
    const sifText = module.generate(config);
    checkBoundaryNodeConflicts(config, contents['mesh.boundary']);
    requireThat(
      (await this.artifacts.verify(document.sif, 'elmer-sif')).toString() === sifText,
      'invalid_input',
      'SIF must exactly match the typed, generated configuration.',
    );
    const dir = await this.artifacts.directory();
    await mkdir(join(dir, 'mesh'), { mode: 0o700 });
    for (const name of meshFiles)
      await this.artifacts.put(join(dir, 'mesh'), name, contents[name], 'elmer-mesh', 'm');
    const sif = await this.artifacts.put(dir, 'case.sif', sifText, 'elmer-sif');
    const state: Run = {
      kind: 'solve',
      runId: basename(dir),
      status: 'preparing',
      createdAt: new Date().toISOString(),
      case: caseRef,
      ...(preparedRef ? { prepared: preparedRef } : {}),
      source: mesh.source,
      mesh: document.mesh,
      sif,
      solver: { executable: 'ElmerSolver', version: 'pending solver banner' },
      logs: [],
      outputs: [],
      results: [],
      summaries: [],
      convergence: 'not evaluated',
      diagnostics: [
        RUN_DIAGNOSTICS[document.config.physics],
        'Timeout and captured-output bounds are enforced. OS memory/disk quotas are deployment policy, not guaranteed by this server.',
      ],
    };
    await this.persist(dir, state);
    const abort = new AbortController();
    const entry = { abort, state, done: Promise.resolve() };
    this.active.set(state.runId, entry);
    entry.done = this.solve(dir, state, document, abort.signal)
      .catch(async () => {
        state.status = 'failed';
        state.error = {
          code: 'persistence_failed',
          message: 'Could not persist run status; inspect workspace storage.',
        };
        await this.persist(dir, state).catch(() => {});
      })
      .finally(() => this.active.delete(state.runId));
    return structuredClone(state);
  }
  private async solve(dir: string, state: Run, document: Case, signal: AbortSignal) {
    try {
      await this.artifacts.verify(state.case, 'json');
      await this.artifacts.verify(state.sif, 'elmer-sif');
      await this.loadMesh(document.mesh);
      state.status = 'running';
      state.startedAt = new Date().toISOString();
      await this.persist(dir, state);
      const result = await this.solverRunner(
        this.settings.elmerSolver,
        ['case.sif'],
        dir,
        'solver',
        this.settings.timeoutMs,
        signal,
      );
      state.logs = await this.logs(dir, 'solver');
      state.solver.version = version(result, 'ElmerSolver');
      state.execution = {
        exitCode: result.exitCode,
        signal: result.signal,
        termination: result.status,
        timeoutMs: this.settings.timeoutMs,
      };
      const failed = termination(result);
      // Keep generated outputs even when termination failed. Do not publish
      // summaries or a success status until all required output checks pass.
      let collectedBytes = 0;
      const collectOutputs = async (directory: string): Promise<void> => {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await collectOutputs(path);
          else if (
            entry.isFile() &&
            (entry.name.endsWith('.vtu') ||
              entry.name === 'scalars.dat' ||
              entry.name === 'scalars.dat.names')
          ) {
            const size = (await stat(path)).size;
            requireThat(
              collectedBytes + size <= MAX_OUTPUT_BYTES,
              'too_large',
              `Solver outputs exceed the ${MAX_OUTPUT_BYTES / (1024 * 1024 * 1024)} GiB local collection limit.`,
            );
            collectedBytes += size;
            state.outputs.push(
              await this.artifacts.capture(
                path,
                entry.name.endsWith('.vtu') ? 'vtu' : 'text',
                entry.name.endsWith('.vtu') ? 'm' : undefined,
              ),
            );
          }
        }
      };
      await collectOutputs(dir);
      if (failed)
        throw new SimulationError(
          failed,
          'Elmer execution failed; inspect retained logs and partial outputs.',
        );
      const scalar = state.outputs.find((r) => r.uri?.endsWith('/scalars.dat'));
      const names = state.outputs.find((r) => r.uri?.endsWith('/scalars.dat.names'));
      const structuralConfig =
        document.config.physics === 'static-structural' ? document.config : undefined;
      const modalConfig = document.config.physics === 'modal' ? document.config : undefined;
      const dcConfig = document.config.physics === 'dc-conduction' ? document.config : undefined;
      const flowConfig = document.config.physics === 'laminar-flow' ? document.config : undefined;
      const transientConfig =
        document.config.physics === 'transient-heat-conduction' ? document.config : undefined;
      if (modalConfig) {
        const converged = result.stdout.match(/Number of converged Ritz values is:\s*(\d+)/i);
        requireThat(
          converged && Number(converged[1]) === modalConfig.modes,
          'solver_failed',
          `Elmer did not converge all ${modalConfig.modes} requested modal eigenvalues.`,
        );
      }
      let summaries: Awaited<ReturnType<typeof parseScalars>> = [];
      if (structuralConfig || dcConfig || flowConfig) {
        requireThat(
          !scalar && !names,
          'malformed_results',
          'Unexpected scalar output for field-based study.',
        );
      } else {
        requireThat(
          scalar && names,
          'malformed_results',
          'Elmer did not produce required scalar output.',
        );
        const scalarData = (await this.artifacts.verify(scalar)).toString();
        const scalarNames = (await this.artifacts.verify(names)).toString();
        summaries = modalConfig
          ? parseModalEigenvalues(scalarData, scalarNames, scalar, modalConfig.modes)
          : transientConfig
            ? parseTransientScalars(
                scalarData,
                scalarNames,
                scalar,
                transientConfig.time.steps,
                transientConfig.time.timestep.value,
              )
            : parseScalars(scalarData, scalarNames, scalar);
      }
      const vtus = state.outputs.filter((r) => r.format === 'vtu');
      requireThat(
        (modalConfig ? vtus.length === 0 : vtus.length > 0) &&
          (!transientConfig || vtus.length === transientConfig.time.steps) &&
          (!(structuralConfig || dcConfig || (flowConfig && flowConfig.regime.mode === 'steady')) ||
            vtus.length === 1) &&
          (!flowConfig ||
            flowConfig.regime.mode !== 'transient' ||
            vtus.length === flowConfig.regime.time.steps),
        'malformed_results',
        transientConfig
          ? `Elmer did not produce one VTU output for each of ${transientConfig.time.steps} timesteps.`
          : structuralConfig
            ? 'Elmer did not produce exactly one static structural VTU output.'
            : flowConfig && flowConfig.regime.mode === 'transient'
              ? `Elmer did not produce one VTU per each of ${flowConfig.regime.time.steps} flow timesteps.`
              : dcConfig
                ? 'Elmer did not produce exactly one DC conduction VTU output.'
                : modalConfig
                  ? 'Modal analysis unexpectedly produced VTU output.'
                  : 'Elmer did not produce VTU output.',
      );
      const expectedTimesteps =
        transientConfig?.time.steps ??
        (flowConfig?.regime.mode === 'transient' ? flowConfig.regime.time.steps : undefined);
      if (expectedTimesteps !== undefined) {
        const outputSteps = vtus.map((artifact) => {
          if (!artifact.uri) return Number.NaN;
          const match = basename(fileURLToPath(artifact.uri)).match(/_t(\d+)\.vtu$/);
          return match ? Number(match[1]) : Number.NaN;
        });
        requireThat(
          outputSteps.length === expectedTimesteps &&
            outputSteps.every((step, index) => step === index + 1),
          'malformed_results',
          `Transient output files must identify each timestep exactly once in order (1..${expectedTimesteps}).`,
        );
      }
      const results = [];
      const resultModule = physicsByCase(document.config.physics);
      for (const [index, artifact] of vtus.entries()) {
        const vtu = parseVtu(
          (await this.artifacts.verify(artifact)).toString(),
          resultModule.resultField,
        );
        const frameTime =
          flowConfig?.regime.mode === 'transient'
            ? (index + 1) * flowConfig.regime.time.timestep.value
            : transientConfig
              ? (index + 1) * transientConfig.time.timestep.value
              : undefined;
        results.push({
          artifact,
          ...describeVtu(vtu),
          coordinateUnits: 'm' as const,
          ...(frameTime === undefined ? {} : { time: { value: frameTime, units: 's' as const } }),
        });
        if (resultModule.metrics)
          summaries = [...summaries, ...resultModule.metrics(vtu, artifact, frameTime)];
      }
      await this.artifacts.verify(state.case, 'json');
      await this.artifacts.verify(state.sif, 'elmer-sif');
      await this.loadMesh(document.mesh);
      state.results = results;
      state.summaries = summaries;
      const flowConvergence = flowConfig
        ? parseLaminarFlowConvergence(
            result.stdout,
            flowConfig.regime.mode,
            flowConfig.regime.mode === 'transient' ? flowConfig.regime.time.steps : 1,
          )
        : undefined;
      state.convergence = modalConfig
        ? `Exit 0; exactly ${modalConfig.modes} positive, finite Elmer eigenvalues validated and converted to frequencies; requested mode count is complete.`
        : flowConfig
          ? `Exit 0; ${flowConfig.regime.mode} incompressible Newtonian flow; ${flowConvergence!.samples} converged output sample(s), all nodal velocity and pressure values validated; maximum nonlinear relative change ${flowConvergence!.maximumRelativeChange}.`
          : dcConfig
            ? 'Exit 0; one finite nodal potential value per VTU point validated; prescribed-potential system solved with natural zero-current flux on insulated surfaces.'
            : structuralConfig
              ? 'Exit 0; finite nodal displacement and stress fields validated in the single static VTU; linear solver abort-on-nonconvergence enabled.'
              : transientConfig
                ? 'Exit 0, exactly one finite scalar sample and VTU per requested timestep, positive temperature convergence flag at every step, and linear abort-on-nonconvergence enabled.'
                : 'Exit 0, no fatal/nonconvergence diagnostics, finite VTU and scalars, positive Temperature NonlinConverged flag; linear abort-on-nonconvergence enabled.';
      state.status = 'succeeded';
    } catch (error) {
      const data = errorData(error);
      state.status =
        data.code === 'timeout' ? 'timeout' : data.code === 'cancelled' ? 'cancelled' : 'failed';
      state.error = { code: data.code, message: data.message };
      state.convergence = 'not established';
    } finally {
      state.endedAt = new Date().toISOString();
      await this.persist(dir, state);
    }
  }
  async status(runId: string) {
    id.parse(runId);
    const live = this.active.get(runId);
    const state = live
      ? structuredClone(live.state)
      : runSchema.parse(
          JSON.parse(
            (
              await this.artifacts.bytes(
                pathToFileURL(join(this.artifacts.workspace, runId, 'status.json')).href,
              )
            ).toString(),
          ),
        );
    if (!live && ['running', 'preparing'].includes(state.status)) {
      state.status = 'interrupted';
      state.convergence = 'not established';
      state.diagnostics.push(
        'No active process is owned by this server instance. Previous process may have been interrupted; inspect workspace before starting a new run.',
      );
      await this.persist(join(this.artifacts.workspace, runId), state);
    }
    if (state.status === 'succeeded') {
      await this.artifacts.verify(state.case);
      await this.artifacts.verify(state.sif);
      await this.loadMesh(state.mesh);
      for (const ref of [...state.logs, ...state.outputs]) await this.artifacts.verify(ref);
    }
    return runSchema.parse(state);
  }
  async cancel(runId: string) {
    id.parse(runId);
    const live = this.active.get(runId);
    requireThat(live, 'invalid_input', 'Run is not active in this server instance.');
    live.abort.abort();
    await live.done;
    return this.status(runId);
  }
  async close() {
    const active = [...this.active.values()];
    const preparations = [...this.preparations.values()];
    active.forEach((run) => run.abort.abort());
    preparations.forEach((job) => job.abort.abort());
    await Promise.allSettled([
      ...active.map((run) => run.done),
      ...preparations.map((job) => job.done),
    ]);
  }
}

function version(result: ProcessResult, executable: string) {
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/);
  return (
    lines
      .filter((line) => /version|revision|git sha|ElmerGrid|ElmerSolver/i.test(line))
      .slice(0, 8)
      .map((s) => s.trim())
      .join('; ')
      .slice(0, 1200) || `${executable}: version not present in process banner; see revisioned logs`
  );
}
