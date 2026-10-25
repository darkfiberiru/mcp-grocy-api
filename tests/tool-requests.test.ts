import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Integration tests: run the built MCP server against a mock Grocy and
// assert which Grocy API URLs each tool requests.

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'build', 'index.js');

let grocy: HttpServer;
let client: Client;
let requested: string[] = [];

beforeAll(async () => {
  // Always rebuild so the test exercises the current source, not a stale build/.
  execSync('npm run build', { cwd: root, stdio: 'ignore' });
  if (!existsSync(entry)) throw new Error(`build output missing: ${entry}`);

  grocy = createServer((req, res) => {
    requested.push(req.url ?? '');
    res.setHeader('Content-Type', 'application/json');
    res.end('[]');
  });
  await new Promise<void>((resolve) => grocy.listen(0, '127.0.0.1', resolve));
  const { port } = grocy.address() as AddressInfo;

  client = new Client({ name: 'tool-requests-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        ...(process.env as Record<string, string>),
        GROCY_BASE_URL: `http://127.0.0.1:${port}`,
        GROCY_APIKEY_VALUE: 'test-key',
        ENABLE_HTTP_SERVER: 'false',
      },
    }),
  );
}, 120_000);

afterAll(async () => {
  await client?.close();
  await new Promise<void>((resolve) => grocy?.close(() => resolve()));
});

beforeEach(() => {
  requested = [];
});

describe('get_stock_by_location', () => {
  it('requests the per-location entries endpoint', async () => {
    await client.callTool({ name: 'get_stock_by_location', arguments: { locationId: 3 } });
    expect(requested).toEqual(['/api/stock/locations/3/entries']);
  });

  it('rejects a missing locationId without calling Grocy', async () => {
    await expect(
      client.callTool({ name: 'get_stock_by_location', arguments: {} }),
    ).rejects.toThrow(/locationId is required/);
    expect(requested).toEqual([]);
  });
});

describe('get_meal_plan', () => {
  it('filters on the exact given date', async () => {
    await client.callTool({ name: 'get_meal_plan', arguments: { date: '2026-10-25' } });
    // The server percent-encodes the query: query[]=day=DATE -> query%5B%5D=day%3DDATE
    expect(requested).toEqual(['/api/objects/meal_plan?query%5B%5D=day%3D2026-10-25&limit=100']);
  });

  it('defaults to today when no date is given', async () => {
    await client.callTool({ name: 'get_meal_plan', arguments: {} });
    const today = new Date().toISOString().split('T')[0];
    expect(requested).toHaveLength(1);
    expect(decodeURIComponent(requested[0])).toBe(
      `/api/objects/meal_plan?query[]=day=${today}&limit=100`,
    );
  });

  it('no longer advertises startDate or days', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'get_meal_plan');
    const props = Object.keys((tool?.inputSchema as any).properties);
    expect(props).toEqual(['date']);
  });
});
