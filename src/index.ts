#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { Simulation } from './service.js';
import { logEvent } from './logging.js';
import { runTool } from './tool-helper.js';
import { SERVER_NAME, PROTOCOL_VERSION, CACHE_TTL_MS } from './identity.js';
import { TOOL_REGISTRY } from './tools.js';
import { helpDocument, HELP_URI, WORKFLOW_TEXT, WORKFLOW_URI } from './catalog.js';

export function createServer(simulation: Simulation) {
  const server = new McpServer(
    { name: SERVER_NAME, version: pkg.version },
    {
      // Static tool/resource sets: never emit listChanged notifications.
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
      },
      instructions:
        'Local STEP-to-simulation server. Call get_capabilities to see implemented physics, then read simulation://help for the machine-readable study schema (fields, units, observation quantities, examples). Workflow: inspect_model → query_model → validate_study → prepare_study → run_study → inspect_job → query_results; list_jobs recovers jobs and cancel_job stops them. Supply every material, load, and boundary explicitly; results are computed facts, not engineering approval.',
      cacheHints: {
        'server/discover': { ttlMs: CACHE_TTL_MS, cacheScope: 'public' },
        'tools/list': { ttlMs: CACHE_TTL_MS, cacheScope: 'public' },
        'resources/list': { ttlMs: CACHE_TTL_MS, cacheScope: 'public' },
        'resources/read': { ttlMs: CACHE_TTL_MS, cacheScope: 'public' },
      },
    },
  );
  for (const tool of TOOL_REGISTRY) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      (args, ctx) =>
        runTool(tool.name, () => tool.handler(simulation, args, { signal: ctx.mcpReq.signal })),
    );
  }
  server.registerResource(
    'workflow',
    WORKFLOW_URI,
    {
      title: 'Simulation workflow',
      mimeType: 'text/plain',
      description: 'Standalone simulation workflow and currently installed physics capabilities.',
      annotations: { audience: ['assistant'], priority: 0.8 },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/plain',
          text: WORKFLOW_TEXT,
        },
      ],
    }),
  );
  server.registerResource(
    'help',
    HELP_URI,
    {
      title: 'Simulation physics help',
      mimeType: 'application/json',
      description:
        'Machine-readable study schema for every physics kind: material and boundary fields with units, regimes, observation quantities with time/mode selectors, enums, and examples. Fetched on demand by the client.',
      annotations: { audience: ['assistant'], priority: 0.9 },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(helpDocument(), null, 2),
        },
      ],
    }),
  );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const roots = JSON.parse(process.env.SIMULATION_INPUT_ROOTS ?? '[]') as unknown;
  const configuredRoots = z.array(z.string().min(1)).min(1).parse(roots);
  const simulation = await Simulation.create({
    workspace: resolve(process.env.SIMULATION_WORKSPACE ?? '.simulation-runs'),
    roots: configuredRoots,
    python: process.env.SIMULATION_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'),
    elmerGrid: process.env.SIMULATION_ELMERGRID ?? 'ElmerGrid',
    elmerSolver: process.env.SIMULATION_ELMERSOLVER ?? 'ElmerSolver',
    timeoutMs: Number(process.env.SIMULATION_TIMEOUT_MS ?? 120000),
  });
  const handle = serveStdio(() => createServer(simulation), {
    legacy: 'reject',
  });
  logEvent('server.started', {
    tools: TOOL_REGISTRY.length,
    protocol: PROTOCOL_VERSION,
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await simulation.close();
      await handle.close();
    })());
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  process.stdin.once('end', () => void close());
}
