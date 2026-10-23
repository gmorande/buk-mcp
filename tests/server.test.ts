import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BukClient } from '../src/buk-client.js';
import { createServer } from '../src/server.js';
import { findByRoute, operations } from '../src/catalog.js';

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(open.splice(0).map(value => value.close())); });

async function connect(allowWrites = false) {
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    pagination: { next: null, previous: null, count: 1, total_pages: 1 },
    data: [{ id: 42, first_name: 'Synthetic', full_name: 'Synthetic Example' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const server = createServer(new BukClient({ tenantUrl: 'https://test.buk.cl', apiKey: 'synthetic-test-key', allowWrites }, fetcher));
  const client = new Client({ name: 'protocol-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  open.push(client, server);
  return client;
}

describe('MCP protocol', () => {
  it('negotiates initialization, discovers the full API and executes a real tools/call', async () => {
    const client = await connect();
    expect(client.getServerVersion()?.name).toBe('buk-mcp');
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toContain('buk_salary_history');
    expect(tools.tools.map(tool => tool.name)).not.toContain('buk_write');
    const discovery = await client.callTool({ name: 'buk_list_operations', arguments: { limit: 100 } });
    expect(discovery.isError).not.toBe(true);
    expect((discovery.structuredContent as any).result.total).toBe(operations.length);
    const read = await client.callTool({ name: 'buk_read', arguments: { operationId: findByRoute('GET', '/employees')!.id } });
    expect(read.isError).not.toBe(true);
    expect((read.structuredContent as any).result.data.data[0].id).toBe(42);
  });

  it('validates inputs and never permits a write through buk_read', async () => {
    const client = await connect();
    const invalid = await client.callTool({ name: 'buk_list_operations', arguments: { limit: 10000 } });
    expect(invalid.isError).toBe(true);
    const write = operations.find(operation => operation.write)!;
    expect((await client.callTool({ name: 'buk_read', arguments: { operationId: write.id } })).isError).toBe(true);
    expect((await client.callTool({ name: 'buk_write', arguments: { operationId: write.id } })).isError).toBe(true);
  });

  it('exposes a clearly annotated write tool only with server opt-in', async () => {
    const client = await connect(true);
    const tool = (await client.listTools()).tools.find(item => item.name === 'buk_write');
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });

  it('provides auditable API resources and payroll prompts without exposing credentials', async () => {
    const client = await connect();
    const resources = await client.listResources();
    expect(resources.resources).toHaveLength(3);
    const catalog = await client.readResource({ uri: 'buk://api/catalog' });
    expect(JSON.parse(String(catalog.contents[0].text))).toHaveLength(operations.length);
    const guide = await client.readResource({ uri: 'buk://guide/payroll' });
    expect(String(guide.contents[0].text)).toContain('Real salary change');
    const prompt = await client.getPrompt({ name: 'team_monthly_cost', arguments: { team: 'Tech', month: '2026-09' } });
    expect(prompt.messages[0].content.type).toBe('text');
    expect(JSON.stringify(prompt)).toContain('Tech');
    expect(JSON.stringify({ resources, catalog, guide, prompt })).not.toContain('synthetic-test-key');
  });
});
