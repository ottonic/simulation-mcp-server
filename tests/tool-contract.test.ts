import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { TOOL_REGISTRY } from '../src/tools.js';
import { service } from './helpers.js';

const artifact = {
  revision: `sha256:${'0'.repeat(64)}`,
  uri: 'file:///workspace/artifact.json',
  format: 'json',
};
const ctx = { signal: new AbortController().signal };
const tool = (name: string) => {
  const found = TOOL_REGISTRY.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
};

const solveJob = {
  kind: 'solve',
  jobId: randomUUID(),
  status: 'succeeded',
  createdAt: '2026-01-01T00:00:00.000Z',
  source: artifact,
  mesh: artifact,
  case: artifact,
  sif: artifact,
  solver: { executable: 'ElmerSolver', version: '26.2' },
  logs: [],
  outputs: [],
  results: [],
  summaries: [],
  convergence: 'ok',
  diagnostics: [],
};

const inventory = {
  protocol: 1,
  gmshVersion: '4.15.0',
  sourceUnits: 'mm',
  scaleToMeters: 0.001,
  idScheme: 'gmsh-occ-import-v1',
  frame: {
    id: 'step-world-si',
    units: 'm',
    origin: [0, 0, 0],
    axes: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    handedness: 'right',
  },
  entities: [],
  diagnostics: [],
};

// Parses a representative success object with the tool's declared output schema.
const accepts = (name: string, value: unknown) => {
  const parsed = tool(name).outputSchema.safeParse(value);
  expect(
    parsed.success,
    `${name}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`,
  ).toBe(true);
};

it('declares a unique, non-empty contract for every tool', () => {
  const names = TOOL_REGISTRY.map((entry) => entry.name);
  expect(new Set(names).size).toBe(names.length);
  for (const entry of TOOL_REGISTRY) {
    expect(entry.title.length, entry.name).toBeGreaterThan(0);
    expect(entry.description.length, entry.name).toBeGreaterThan(0);
    expect(entry.outputSchema, entry.name).toBeDefined();
    expect(entry.annotations.readOnlyHint, entry.name).toBeTypeOf('boolean');
  }
});

it('returns schema-valid output for the tools that need no solver', async () => {
  const sim = await service();
  try {
    const capabilities = await tool('get_capabilities').handler(sim, {}, ctx);
    expect(tool('get_capabilities').outputSchema.safeParse(capabilities).success).toBe(true);

    const validation = await tool('validate_study').handler(sim, { study: {} }, ctx);
    expect(tool('validate_study').outputSchema.safeParse(validation).success).toBe(true);

    const jobs = await tool('list_jobs').handler(sim, {}, ctx);
    expect(tool('list_jobs').outputSchema.safeParse(jobs).success).toBe(true);
  } finally {
    await sim.close();
  }
});

it('accepts the documented success shape for every tool', () => {
  accepts('inspect_model', {
    source: artifact,
    inspection: artifact,
    inventory,
    logs: [],
  });
  accepts('query_model', { entities: [], nextCursor: '10' });
  accepts('prepare_study', {
    jobId: randomUUID(),
    kind: 'prepare',
    status: 'succeeded',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    study: artifact,
    artifacts: [],
    diagnostics: [],
  });
  accepts('run_study', solveJob);
  accepts('inspect_job', solveJob);
  accepts('cancel_job', solveJob);
  accepts('query_results', {
    status: 'succeeded',
    convergence: 'ok',
    summaries: [],
    fields: [{ name: 'velocity', components: 3, association: 'point', units: 'm/s' }],
    observations: [
      {
        id: 'peak',
        quantity: 'velocity_magnitude_max',
        status: 'available',
        value: 1,
        units: 'm/s',
        time: { value: 1, units: 's' },
      },
    ],
    acceptance: [],
    artifacts: [],
    artifactCount: 0,
    diagnostics: [],
  });
});

it('rejects a success shape that omits required fields', () => {
  const { artifactCount: _omitted, ...withoutCount } = {
    status: 'succeeded',
    convergence: 'ok',
    summaries: [],
    fields: [],
    observations: [],
    acceptance: [],
    artifacts: [],
    artifactCount: 0,
    diagnostics: [],
  };
  expect(tool('query_results').outputSchema.safeParse(withoutCount).success).toBe(false);
  expect(tool('run_study').outputSchema.safeParse({ kind: 'solve' }).success).toBe(false);
});
