#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BukClient } from './buk-client.js';
import { createServer, SERVER_VERSION } from './server.js';

async function main() {
  const mode = process.argv[2] ?? 'stdio';
  if (mode === '--version' || mode === '-v') { console.log(SERVER_VERSION); return; }
  if (mode === '--help' || mode === '-h') {
    console.log('buk-mcp [stdio|http]\n\nstdio: set BUK_TENANT_URL and BUK_API_KEY.\nhttp: see docs/DEPLOYMENT.md for OAuth or bearer authentication.\n');
    return;
  }
  if (mode === 'http') {
    const { startHttpServer } = await import('./http.js');
    await startHttpServer();
    return;
  }
  if (mode !== 'stdio') throw new Error('Unknown mode. Use stdio or http.');
  const tenantUrl = process.env.BUK_TENANT_URL;
  const apiKey = process.env.BUK_API_KEY;
  if (!tenantUrl || !apiKey) throw new Error('Set BUK_TENANT_URL and BUK_API_KEY in your environment.');
  const client = new BukClient({ tenantUrl, apiKey, country: process.env.BUK_COUNTRY ?? 'chile',
    allowWrites: process.env.BUK_ALLOW_WRITES === 'true',
    maxPages: process.env.BUK_MAX_PAGES ? Number(process.env.BUK_MAX_PAGES) : 100,
    timeoutMs: process.env.BUK_TIMEOUT_MS ? Number(process.env.BUK_TIMEOUT_MS) : 30_000,
  });
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
  const stop = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch(() => {
  // Avoid ever printing environment values, tokens or third-party error bodies.
  process.stderr.write('Buk MCP could not start. Check required configuration and see docs/DEPLOYMENT.md.\n');
  process.exitCode = 1;
});
