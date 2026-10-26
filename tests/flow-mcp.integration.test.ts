import { copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, it } from 'vitest';
import { temporary } from './helpers.js';
import { ductSelection, ductStudy } from './flow-helpers.js';
import type { ArtifactRef, Inventory } from '../src/schemas.js';

type Inspected = {
  source: ArtifactRef;
  inspection: ArtifactRef;
  inventory: Inventory;
};

type QueryResult = {
  jobId: string;
  source: ArtifactRef;
  preparedStudy?: ArtifactRef;
  status: string;
  fields: { name: string; components: number; units?: string }[];
  observations: {
    id: string;
    status: string;
    time?: { value: number; units: string };
  }[];
  acceptance: { observationId: string; status: string }[];
};

async function withClient(
  check: (client: Client, root: string, inspected: Inspected) => Promise<void>,
) {
  const root = await temporary();
  const client = new Client(
    { name: 'simulation-flow-mcp-test', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', fileURLToPath(new URL('../src/index.ts', import.meta.url))],
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      SIMULATION_INPUT_ROOTS: JSON.stringify([root]),
      SIMULATION_WORKSPACE: join(root, 'workspace'),
    },
    stderr: 'inherit',
  });
  try {
    await client.connect(transport, { timeout: 5_000 });
    const fixture = join(root, 'bar.step');
    await copyFile(fileURLToPath(new URL('./fixtures/bar.step', import.meta.url)), fixture);
    const inspected = await client.callTool({
      name: 'inspect_model',
      arguments: { uri: pathToFileURL(fixture).href },
    });
    expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
    await check(client, root, inspected.structuredContent as unknown as Inspected);
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function poll(client: Client, jobId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let result: Record<string, unknown> = {};
  do {
    const response = await client.callTool({
      name: 'inspect_job',
      arguments: { jobId },
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    result = response.structuredContent as Record<string, unknown>;
    if (['succeeded', 'failed', 'timeout', 'cancelled'].includes(String(result.status)))
      return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for MCP job ${jobId}`);
}

// Runs a study end to end through the MCP tools and returns query_results.
async function runThroughMcp(
  client: Client,
  study: ReturnType<typeof ductStudy>,
): Promise<QueryResult> {
  const prepared = await client.callTool({
    name: 'prepare_study',
    arguments: { study },
  });
  expect(prepared.isError, JSON.stringify(prepared)).not.toBe(true);
  const preparation = prepared.structuredContent as { jobId: string };
  const preparedJob = await poll(client, preparation.jobId, 90_000);
  expect(preparedJob.status, JSON.stringify(preparedJob)).toBe('succeeded');
  const run = await client.callTool({
    name: 'run_study',
    arguments: { prepared: preparedJob.prepared },
  });
  expect(run.isError, JSON.stringify(run)).not.toBe(true);
  const runId = (run.structuredContent as { jobId: string }).jobId;
  const completed = await poll(client, runId, 120_000);
  expect(completed.status, JSON.stringify(completed)).toBe('succeeded');
  const queried = await client.callTool({
    name: 'query_results',
    arguments: { jobId: runId },
  });
  expect(queried.isError, JSON.stringify(queried)).not.toBe(true);
  const results = queried.structuredContent as unknown as QueryResult;
  expect(results.jobId).toBe(runId);
  expect(results.source).toMatchObject({
    revision: study.model.source.revision,
    format: 'step',
    units: study.model.source.units,
  });
  expect(results.preparedStudy).toEqual(completed.prepared);
  return results;
}

const MESH = { minSize: 0.002, maxSize: 0.004 };

it('runs steady laminar flow through the MCP protocol', async () => {
  await withClient(async (client, _root, inspected) => {
    const selection = ductSelection(inspected.inventory);
    const queried = await runThroughMcp(
      client,
      ductStudy({
        inspected,
        selection,
        mesh: MESH,
        regime: { mode: 'steady' },
      }),
    );
    expect(queried.status).toBe('succeeded');
    expect(queried.fields).toEqual(
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
  });
}, 180_000);

it('runs transient laminar flow with a time-selected observation through the MCP protocol', async () => {
  await withClient(async (client, _root, inspected) => {
    const selection = ductSelection(inspected.inventory);
    const queried = await runThroughMcp(
      client,
      ductStudy({
        inspected,
        selection,
        mesh: MESH,
        regime: { mode: 'transient', timestep: 0.05, steps: 8 },
        observations: [
          {
            id: 'early',
            quantity: 'velocity_magnitude_max',
            time: { value: 0.2, units: 's' },
          },
          { id: 'final', quantity: 'velocity_magnitude_max' },
        ],
        acceptanceCriteria: [
          {
            observationId: 'early',
            operator: '>',
            threshold: { value: 0, units: 'm/s' },
          },
        ],
      }),
    );
    expect(queried.status).toBe('succeeded');
    expect(queried.observations).toEqual([
      expect.objectContaining({
        id: 'early',
        status: 'available',
        time: { value: 0.2, units: 's' },
      }),
      expect.objectContaining({
        id: 'final',
        status: 'available',
        time: { value: 0.4, units: 's' },
      }),
    ]);
    expect(queried.acceptance).toEqual([
      expect.objectContaining({ observationId: 'early', status: 'pass' }),
    ]);
    expect(queried.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'velocity',
          components: 3,
          units: 'm/s',
        }),
      ]),
    );
  });
}, 180_000);
