import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect, it } from 'vitest';
import { temporary } from './helpers.js';

async function withClient(
  version: '2026-07-28' | '2025-11-25',
  check: (client: Client, transport: StdioClientTransport, root: string) => Promise<void>,
) {
  const root = await temporary();
  const client = new Client(
    { name: 'simulation-mcp-protocol-test', version: '1.0.0' },
    {
      ...(version === '2025-11-25' ? { supportedProtocolVersions: [version] } : {}),
      versionNegotiation: {
        mode: version === '2025-11-25' ? 'legacy' : { pin: version },
      },
    },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', fileURLToPath(new URL('../src/index.ts', import.meta.url))],
    cwd: dirname(dirname(fileURLToPath(new URL('../src/index.ts', import.meta.url)))),
    env: {
      ...process.env,
      SIMULATION_INPUT_ROOTS: JSON.stringify([root]),
      SIMULATION_WORKSPACE: join(root, 'workspace'),
    },
    stderr: 'inherit',
  });
  try {
    await check(client, transport, root);
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}

it('serves discovery, resources and tool errors over the modern MCP protocol', async () => {
  await withClient('2026-07-28', async (client, transport, root) => {
    await client.connect(transport, { timeout: 5_000 });
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(client.getProtocolEra()).toBe('modern');

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'cancel_job',
      'get_capabilities',
      'inspect_job',
      'inspect_model',
      'list_jobs',
      'prepare_study',
      'query_model',
      'query_results',
      'run_study',
      'validate_study',
    ]);
    const inspect = tools.find((tool) => tool.name === 'inspect_model');
    expect(inspect?.inputSchema).toMatchObject({ type: 'object' });
    expect(inspect?.inputSchema).toHaveProperty('properties.uri');
    expect(inspect?.inputSchema).toHaveProperty('properties.source');
    expect(inspect?.outputSchema).toMatchObject({ type: 'object' });

    const { tools: advertisedTools } = await client.listTools();
    expect(advertisedTools).toHaveLength(10);
    const capabilities = await client.callTool({
      name: 'get_capabilities',
      arguments: {},
    });
    expect(capabilities.isError).not.toBe(true);
    expect(capabilities.structuredContent).toMatchObject({
      schemaVersion: '1',
      physics: expect.arrayContaining([
        expect.objectContaining({ kind: 'steady-thermal', available: true }),
        expect.objectContaining({ kind: 'transient-thermal', available: true }),
        expect.objectContaining({ kind: 'static-structural', available: true }),
        expect.objectContaining({ kind: 'modal', available: true }),
        expect.objectContaining({ kind: 'dc-conduction', available: true }),
      ]),
    });
    const advertisedPhysics = (
      capabilities.structuredContent as {
        physics: {
          kind: string;
          boundaryKinds: string[];
          quantities: string[];
        }[];
      }
    ).physics;
    const capability = (kind: string) => advertisedPhysics.find((item) => item.kind === kind)!;
    expect(capability('dc-conduction')).toMatchObject({
      boundaryKinds: ['potential', 'insulated'],
      quantities: ['potential_min', 'potential_max', 'potential_mean'],
    });
    expect(capability('laminar-flow')).toMatchObject({
      boundaryKinds: ['pressure', 'no-slip'],
      quantities: ['velocity_magnitude_max', 'velocity_x_max', 'pressure_min', 'pressure_max'],
    });
    expect(capability('steady-thermal').quantities).toEqual([
      'temperature_min',
      'temperature_max',
      'temperature_mean',
      'heat_flux_magnitude_mean',
    ]);
    const invalidStudy = await client.callTool({
      name: 'validate_study',
      arguments: { study: {} },
    });
    expect(invalidStudy.isError).not.toBe(true);
    const invalidContent = invalidStudy.structuredContent as {
      valid: boolean;
      issues: { code: string; path?: string }[];
    };
    expect(invalidContent.valid).toBe(false);
    expect(invalidContent.issues.length).toBeGreaterThan(0);
    expect(invalidContent.issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid_study',
        path: '/schemaVersion',
      }),
    );

    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      'simulation://help',
      'simulation://workflow',
    ]);
    const workflow = await client.readResource({
      uri: 'simulation://workflow',
    });
    expect(workflow.contents).toEqual([
      expect.objectContaining({
        uri: 'simulation://workflow',
        mimeType: 'text/plain',
        text: expect.stringContaining('inspect_model'),
      }),
    ]);
    const help = await client.readResource({
      uri: 'simulation://help',
    });
    expect(help.contents).toEqual([
      expect.objectContaining({
        uri: 'simulation://help',
        mimeType: 'application/json',
      }),
    ]);
    const helpText = help.contents[0]! as { text: string };
    const helpDocument = JSON.parse(helpText.text) as {
      physics: { kind: string; examples: { kind: string }[] }[];
      rules: string[];
    };
    expect(helpDocument.physics.map((entry) => entry.kind).sort()).toEqual(
      advertisedPhysics.map((entry) => entry.kind).sort(),
    );
    expect(
      helpDocument.physics
        .find((entry) => entry.kind === 'laminar-flow')!
        .examples.some((example) => example.kind === 'laminar-flow'),
    ).toBe(true);
    expect(helpDocument.rules.join(' ')).toContain('get_capabilities');

    const result = await client.callTool({
      name: 'inspect_model',
      arguments: { uri: pathToFileURL(join(root, 'missing.step')).href },
    });
    expect(result.isError).toBe(true);
    const text = result.content.find((item) => item.type === 'text');
    expect(text?.type).toBe('text');
    if (text?.type !== 'text') throw new Error('Expected an actionable error text block');
    expect(text.text).toMatch(/^file_not_found: /);
  });
}, 15_000);

it('serves the 2025-era handshake that stock MCP hosts negotiate', async () => {
  await withClient('2025-11-25', async (client, transport) => {
    await client.connect(transport, { timeout: 5_000 });
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect(client.getProtocolEra()).toBe('legacy');
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(10);
    expect(tools.map((tool) => tool.name)).toContain('get_capabilities');
  });
}, 15_000);
