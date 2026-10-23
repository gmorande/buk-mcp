import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, type Server as HttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BukClient } from '../src/buk-client.js';
import { createHttpApp, parsePublicUrl, startHttpServer } from '../src/http.js';

const servers: HttpServer[] = [];
const directories: string[] = [];
const callback = 'https://chatgpt.com/connector_platform/oauth_redirect';
const publicUrl = 'http://127.0.0.1:3000';
const accessToken = 'fixed-test-token-'.repeat(4);
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function testServer(client: BukClient): Server {
  const server = new Server({ name: 'isolation-test', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'whoami', description: 'Return the connected tenant for this test.', inputSchema: { type: 'object', properties: {} } }] }));
  server.setRequestHandler(CallToolRequestSchema, async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return { content: [{ type: 'text', text: client.tenantUrl }], structuredContent: { tenant: client.tenantUrl, writes: client.allowWrites } };
  });
  return server;
}

async function start(mode: 'oauth' | 'bearer' = 'bearer', allowWrites = false) {
  const directory = mkdtempSync(join(tmpdir(), 'buk-http-test-'));
  directories.push(directory);
  const app = createHttpApp({
    env: {}, publicUrl, authMode: mode, bearerToken: accessToken,
    credentials: { tenantUrl: 'https://alpha.buk.cl', apiKey: 'test-buk-api-key', allowWrites },
    serverFactory: testServer,
    oauth: { dataDir: directory, masterKey: randomBytes(32).toString('base64'), redirectUris: [callback], validateCredentials: async () => {} },
  });
  const server = await new Promise<HttpServer>((resolve, reject) => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); running.once('error', reject); });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Invalid test listener');
  return { base: `http://127.0.0.1:${address.port}`, app };
}

async function formPost(base: string, path: string, body: Record<string, string>) {
  return fetch(`${base}${path}`, { method: 'POST', body: new URLSearchParams(body), redirect: 'manual' });
}

async function authorize(base: string, tenant: string) {
  const registration = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: 'none', client_name: 'HTTP integration test' }) });
  expect(registration.status).toBe(201);
  const client = await registration.json() as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: callback, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), scope: 'buk:read', resource: `${publicUrl}/mcp`, state: 'test-state' });
  const auth = await fetch(`${base}/authorize?${params}`, { redirect: 'manual' });
  expect(auth.status).toBe(200);
  const html = await auth.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
  const cookie = auth.headers.get('set-cookie')!.split(';')[0];
  const consent = await fetch(`${base}/authorize/complete`, { method: 'POST', headers: { origin: publicUrl, cookie }, body: new URLSearchParams({ request_id: requestId, csrf, decision: 'allow', tenant_url: tenant, api_key: `key-for-${tenant}`, country: 'chile' }), redirect: 'manual' });
  expect(consent.status).toBe(303);
  const url = new URL(consent.headers.get('location')!);
  expect(url.searchParams.get('state')).toBe('test-state');
  return { clientId: client.client_id, verifier, code: url.searchParams.get('code')! };
}

async function exchange(base: string, auth: Awaited<ReturnType<typeof authorize>>, override: Record<string, string> = {}) {
  return formPost(base, '/token', { grant_type: 'authorization_code', client_id: auth.clientId, code: auth.code, code_verifier: auth.verifier, redirect_uri: callback, resource: `${publicUrl}/mcp`, ...override });
}

describe('HTTP authentication, OAuth and stateless transport', () => {
  it('requires authentication and completes a real SDK handshake/tools call', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toEqual(['whoami']);
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    expect(result.structuredContent).toEqual({ tenant: 'https://alpha.buk.cl', writes: false });
    await client.close();
  });

  it('rejects Host/Origin injection and does not leak malformed request bodies', async () => {
    const { base } = await start();
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${base}/healthz`, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    expect(hostStatus).toBe(403);
    expect((await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, Origin: 'https://evil.example' } })).status).toBe(403);
    const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: '{"key":"DO-NOT-LEAK"' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain('DO-NOT-LEAK');
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${accessToken}` } })).status).toBe(405);
  });

  it('exposes OAuth discovery and validates PKCE at the SDK token endpoint', async () => {
    const { base } = await start('oauth');
    const unauthorized = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');
    const discovery = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(discovery.code_challenge_methods_supported).toEqual(['S256']);
    expect(discovery.registration_endpoint).toBe(`${publicUrl}/register`);
    const protectedResource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(protectedResource.resource).toBe(`${publicUrl}/mcp`);
    const auth = await authorize(base, 'https://alpha.buk.cl');
    const rejected = await exchange(base, auth, { code_verifier: 'x'.repeat(43) });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toBe('invalid_grant');
    const accepted = await exchange(base, auth);
    expect(accepted.status).toBe(200);
    const token = await accepted.json();
    expect(token.access_token).toBeTypeOf('string');
    expect(token.scope).toBe('buk:read');
    expect((await exchange(base, auth)).status).toBe(400);
  });

  it('authenticates before parsing MCP bodies and permits larger isolated write uploads', async () => {
    const read = await start();
    const write = await start('bearer', true);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'whoami', arguments: { dataBase64: 'a'.repeat(300_000) } } });
    const headers = { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };
    const unauthorized = await fetch(`${read.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(unauthorized.status).toBe(401);
    const oversizedRead = await fetch(`${read.base}/mcp`, { method: 'POST', headers, body });
    expect(oversizedRead.status).toBe(413);
    const acceptedWrite = await fetch(`${write.base}/mcp`, { method: 'POST', headers, body });
    expect(acceptedWrite.status).toBe(200);
    expect((await acceptedWrite.json()).result.structuredContent.writes).toBe(true);
  });

  it('keeps parallel OAuth clients isolated even when JSON-RPC IDs overlap', async () => {
    const { base } = await start('oauth');
    const tokens = await Promise.all(['https://alpha.buk.cl', 'https://beta.buk.cl'].map(async tenant => {
      const auth = await authorize(base, tenant);
      const response = await exchange(base, auth);
      expect(response.status).toBe(200);
      return { tenant, ...(await response.json()) as { access_token: string } };
    }));
    const results = await Promise.all(tokens.map(async token => {
      const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'whoami', arguments: {} } }) });
      expect(response.status).toBe(200);
      const output = await response.json();
      expect(output.result.structuredContent.tenant).toBe(token.tenant);
      expect(output.result.structuredContent.writes).toBe(false);
      return output;
    }));
    expect(results[0].result.structuredContent.tenant).not.toBe(results[1].result.structuredContent.tenant);
  });

  it('rejects unsafe configuration and OAuth write enablement before serving', async () => {
    for (const value of ['http://remote.example', 'https://example.com/path', 'https://user:secret@example.com', 'https://example.com?key=secret']) expect(() => parsePublicUrl(value)).toThrow();
    expect(() => createHttpApp({ env: {}, authMode: 'bearer', bearerToken: 'short' })).toThrow('32');
    expect(() => createHttpApp({ env: { BUK_ALLOW_WRITES: 'true' }, authMode: 'oauth' })).toThrow('Writes');
    await expect(startHttpServer({ env: {}, host: '0.0.0.0', publicUrl: 'http://127.0.0.1:3000' })).rejects.toThrow('loopback');
  });
});
