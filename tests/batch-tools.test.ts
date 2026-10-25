import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Integration tests for the batch/compact tools: run the built MCP server
// against a mock Grocy that records requests and returns canned data.

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'build', 'index.js');

type Recorded = { method: string; url: string; body: any };

let grocy: HttpServer;
let client: Client;
let recorded: Recorded[] = [];
// Per-test hook: return {status, data} to override the default empty-array reply.
let respond: (r: Recorded) => { status?: number; data: any } | undefined = () => undefined;

const PRODUCTS = [
  { id: 1, name: 'Tilapia', qu_id_stock: 7 },
  { id: 2, name: 'Chicken thighs', qu_id_stock: 8 },
];
const LOCATIONS = [
  { id: 1, name: 'Fridge' },
  { id: 2, name: 'Freezer' },
];

const text = (result: any) => JSON.parse(result.content[0].text);

beforeAll(async () => {
  execSync('npm run build', { cwd: root, stdio: 'ignore' });
  if (!existsSync(entry)) throw new Error(`build output missing: ${entry}`);

  grocy = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const rec: Recorded = { method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : null };
      recorded.push(rec);
      const custom = respond(rec);
      res.statusCode = custom?.status ?? 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(custom ? custom.data : []));
    });
  });
  await new Promise<void>((resolve) => grocy.listen(0, '127.0.0.1', resolve));
  const { port } = grocy.address() as AddressInfo;

  client = new Client({ name: 'batch-tools-test', version: '0.0.0' }, { capabilities: {} });
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
  recorded = [];
  respond = () => undefined;
});

describe('batch_api_calls', () => {
  it('runs each call in order with its method and body', async () => {
    const res = await client.callTool({
      name: 'batch_api_calls',
      arguments: {
        calls: [
          { method: 'POST', endpoint: 'objects/products', body: { name: 'Salt' } },
          { method: 'GET', endpoint: '/objects/locations' },
        ],
      },
    });
    expect(recorded.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /api/objects/products',
      'GET /api/objects/locations',
    ]);
    expect(recorded[0].body).toEqual({ name: 'Salt' });
    const out = text(res);
    expect(out).toMatchObject({ total: 2, executed: 2, failed: 0 });
    expect(res.isError).toBeUndefined();
  });

  it('continues past a failed call and flags the result as an error', async () => {
    respond = (r) => (r.url.includes('bad') ? { status: 400, data: { error_message: 'nope' } } : undefined);
    const res = await client.callTool({
      name: 'batch_api_calls',
      arguments: {
        calls: [
          { method: 'GET', endpoint: 'objects/bad' },
          { method: 'GET', endpoint: 'objects/products' },
        ],
      },
    });
    const out = text(res);
    expect(out).toMatchObject({ executed: 2, failed: 1 });
    expect(out.results[0].ok).toBe(false);
    expect(out.results[1].ok).toBe(true);
    expect(res.isError).toBe(true);
  });

  it('stops at the first failure when stopOnError is set', async () => {
    respond = (r) => (r.url.includes('bad') ? { status: 500, data: {} } : undefined);
    const res = await client.callTool({
      name: 'batch_api_calls',
      arguments: {
        stopOnError: true,
        calls: [
          { method: 'GET', endpoint: 'objects/bad' },
          { method: 'GET', endpoint: 'objects/products' },
        ],
      },
    });
    expect(text(res)).toMatchObject({ total: 2, executed: 1, failed: 1 });
    expect(recorded).toHaveLength(1);
  });

  it('rejects an invalid batch before making any request', async () => {
    await expect(
      client.callTool({
        name: 'batch_api_calls',
        arguments: {
          calls: [
            { method: 'GET', endpoint: 'objects/products' },
            { method: 'GET', endpoint: 'https://evil.example/steal' },
          ],
        },
      }),
    ).rejects.toThrow(/calls\[1\]/);
    expect(recorded).toEqual([]);
  });

  it('rejects an empty or oversized batch', async () => {
    await expect(client.callTool({ name: 'batch_api_calls', arguments: { calls: [] } })).rejects.toThrow(/non-empty/);
    const tooMany = Array.from({ length: 101 }, () => ({ method: 'GET', endpoint: 'objects/products' }));
    await expect(client.callTool({ name: 'batch_api_calls', arguments: { calls: tooMany } })).rejects.toThrow(/Too many/);
    expect(recorded).toEqual([]);
  });
});

describe('bulk_purchase_products', () => {
  it('posts one purchase per item, applying shared defaults', async () => {
    const res = await client.callTool({
      name: 'bulk_purchase_products',
      arguments: {
        locationId: 2,
        storeId: 5,
        items: [
          { productId: 1, amount: 3, price: 4.5, bestBeforeDate: '2027-01-01' },
          { productId: 2, locationId: 1 },
        ],
      },
    });
    expect(recorded.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /api/stock/products/1/add',
      'POST /api/stock/products/2/add',
    ]);
    expect(recorded[0].body).toMatchObject({
      amount: 3,
      price: 4.5,
      best_before_date: '2027-01-01',
      location_id: 2,
      shopping_location_id: 5,
      transaction_type: 'purchase',
    });
    // Item-level location overrides the default; missing amount defaults to 1.
    expect(recorded[1].body).toMatchObject({ amount: 1, location_id: 1, shopping_location_id: 5 });
    expect(recorded[1].body.best_before_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(text(res)).toMatchObject({ total: 2, failed: 0 });
  });

  it('reports per-item failures without aborting the rest', async () => {
    respond = (r) => (r.url.includes('/products/1/') ? { status: 400, data: { error_message: 'unknown product' } } : undefined);
    const res = await client.callTool({
      name: 'bulk_purchase_products',
      arguments: { items: [{ productId: 1 }, { productId: 2 }] },
    });
    const out = text(res);
    expect(out.failed).toBe(1);
    expect(out.results.map((r: any) => r.ok)).toEqual([false, true]);
    expect(res.isError).toBe(true);
  });

  it('validates items before making any request', async () => {
    await expect(
      client.callTool({ name: 'bulk_purchase_products', arguments: { items: [{ productId: 1 }, { amount: 2 }] } }),
    ).rejects.toThrow(/items\[1\]/);
    await expect(
      client.callTool({ name: 'bulk_purchase_products', arguments: { items: [{ productId: 1, amount: -1 }] } }),
    ).rejects.toThrow(/positive/);
    expect(recorded).toEqual([]);
  });
});

describe('create_recipe', () => {
  it('without ingredients, only creates the recipe', async () => {
    respond = () => ({ data: { created_object_id: 9 } });
    const res = await client.callTool({ name: 'create_recipe', arguments: { name: 'Soup', servings: 4 } });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ method: 'POST', url: '/api/objects/recipes' });
    expect(recorded[0].body).toMatchObject({ name: 'Soup', base_servings: 4 });
    expect(text(res)).toEqual({ created_object_id: 9 });
  });

  it('creates ingredient rows against the new recipe id', async () => {
    respond = (r) => {
      if (r.url === '/api/objects/recipes') return { data: { created_object_id: 9 } };
      if (r.url === '/api/objects/products/1') return { data: PRODUCTS[0] };
      return undefined;
    };
    const res = await client.callTool({
      name: 'create_recipe',
      arguments: {
        name: 'Pesto Tilapia',
        ingredients: [
          { productId: 1, amount: 2, note: 'thawed' },
          { productId: 2, amount: 1.5, quantityUnitId: 3 },
        ],
      },
    });
    const rows = recorded.filter((r) => r.url === '/api/objects/recipes_pos');
    expect(rows.map((r) => r.body)).toEqual([
      { recipe_id: 9, product_id: 1, amount: 2, qu_id: 7, note: 'thawed' }, // unit looked up from product
      { recipe_id: 9, product_id: 2, amount: 1.5, qu_id: 3 }, // explicit unit, no lookup
    ]);
    // Only product 1 needed a lookup.
    expect(recorded.filter((r) => r.url.startsWith('/api/objects/products/')).map((r) => r.url)).toEqual([
      '/api/objects/products/1',
    ]);
    expect(text(res).ingredients).toMatchObject({ total: 2, failed: 0 });
  });

  it('reports a failed ingredient but keeps the created recipe', async () => {
    respond = (r) => {
      if (r.url === '/api/objects/recipes') return { data: { created_object_id: 9 } };
      if (r.url === '/api/objects/recipes_pos') return { status: 400, data: { error_message: 'bad row' } };
      return undefined;
    };
    const res = await client.callTool({
      name: 'create_recipe',
      arguments: { name: 'Soup', ingredients: [{ productId: 1, amount: 1, quantityUnitId: 3 }] },
    });
    const out = text(res);
    expect(out.recipe).toEqual({ created_object_id: 9 });
    expect(out.ingredients.failed).toBe(1);
    expect(res.isError).toBe(true);
  });

  it('rejects malformed ingredients before creating anything', async () => {
    await expect(
      client.callTool({ name: 'create_recipe', arguments: { name: 'Soup', ingredients: [{ productId: 1 }] } }),
    ).rejects.toThrow(/ingredients\[0\]/);
    expect(recorded).toEqual([]);
  });
});

describe('get_stock (compact by default)', () => {
  const entriesByLocation: Record<string, any[]> = {
    '/api/stock/locations/1/entries': [{ product_id: 2, amount: 1, best_before_date: '2026-11-01' }],
    '/api/stock/locations/2/entries': [{ product_id: 1, amount: 4, best_before_date: '2027-03-01' }],
  };
  const grocyData = (r: Recorded) => {
    if (r.url === '/api/objects/products') return { data: PRODUCTS };
    if (r.url === '/api/objects/locations') return { data: LOCATIONS };
    if (r.url in entriesByLocation) return { data: entriesByLocation[r.url] };
    return undefined;
  };

  it('returns short rows across all locations, sorted by name, with no arguments', async () => {
    respond = grocyData;
    const out = text(await client.callTool({ name: 'get_stock', arguments: {} }));
    expect(out.count).toBe(2);
    expect(out.entries).toEqual([
      { productId: 2, name: 'Chicken thighs', amount: 1, location: 'Fridge', bestBefore: '2026-11-01' },
      { productId: 1, name: 'Tilapia', amount: 4, location: 'Freezer', bestBefore: '2027-03-01' },
    ]);
  });

  it('only queries the given location when locationId is set', async () => {
    respond = grocyData;
    const out = text(await client.callTool({ name: 'get_stock', arguments: { locationId: 2 } }));
    expect(out.entries.map((e: any) => e.name)).toEqual(['Tilapia']);
    expect(recorded.map((r) => r.url)).toContain('/api/stock/locations/2/entries');
    expect(recorded.map((r) => r.url)).not.toContain('/api/stock/locations/1/entries');
  });

  it('returns the full /stock response only when full: true is passed', async () => {
    await client.callTool({ name: 'get_stock', arguments: { full: true } });
    expect(recorded.map((r) => r.url)).toEqual(['/api/stock']);
  });

  it('still honours the older compact: false opt-out', async () => {
    await client.callTool({ name: 'get_stock', arguments: { compact: false } });
    expect(recorded.map((r) => r.url)).toEqual(['/api/stock']);
  });

  it('rejects full: true combined with locationId', async () => {
    await expect(
      client.callTool({ name: 'get_stock', arguments: { full: true, locationId: 2 } }),
    ).rejects.toThrow(/cannot be combined/);
    expect(recorded).toEqual([]);
  });

  it('advertises full and locationId but no longer a compact parameter', async () => {
    const { tools } = await client.listTools();
    const props = Object.keys((tools.find((t) => t.name === 'get_stock')?.inputSchema as any).properties);
    expect(props.sort()).toEqual(['full', 'locationId']);
  });
});

describe('tool descriptions (guidance for the model)', () => {
  it('steers the model away from the full stock dump and toward the batch tools', async () => {
    const { tools } = await client.listTools();
    const desc = (name: string) => tools.find((t) => t.name === name)?.description ?? '';
    expect(desc('get_stock')).toMatch(/full: true/);
    expect(desc('get_stock')).toMatch(/flood your context/);
    expect(desc('purchase_product')).toMatch(/bulk_purchase_products/);
    expect(desc('create_recipe')).toMatch(/ingredients/);
    expect(desc('batch_api_calls')).toMatch(/more than two or three/);
  });
});
