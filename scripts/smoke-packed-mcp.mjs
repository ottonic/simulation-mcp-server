import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const smokeRoot = resolve(process.env.SIMULATION_SMOKE_ROOT ?? 'smoke');
const server = join(smokeRoot, 'node_modules/simulation-mcp-server/dist/src/index.js');
const fixture = fileURLToPath(new URL('../tests/fixtures/bar.step', import.meta.url));
const clientSdk = createRequire(import.meta.url);
const { Client } = clientSdk('@modelcontextprotocol/client');
const { StdioClientTransport } = clientSdk('@modelcontextprotocol/client/stdio');
const client = new Client(
  { name: 'simulation-mcp-pack-smoke', version: '1.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [server],
  cwd: process.cwd(),
  env: {
    ...process.env,
    SIMULATION_INPUT_ROOTS: JSON.stringify([dirname(fixture)]),
    SIMULATION_WORKSPACE: join(smokeRoot, 'runs'),
  },
  stderr: 'inherit',
});

try {
  await client.connect(transport);
  assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
  const result = await client.callTool({
    name: 'inspect_model',
    arguments: { uri: pathToFileURL(fixture).href },
  });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const inventory = result.structuredContent?.inventory;
  assert.ok(inventory, 'Packaged MCP server returned no inventory');
  assert.equal(inventory.entities.filter((entity) => entity.dimension === 3).length, 1);
  assert.equal(inventory.entities.filter((entity) => entity.dimension === 2).length, 6);
  console.log('Packed MCP server negotiated the modern protocol and inspected the STEP fixture');
} finally {
  await client.close();
}
