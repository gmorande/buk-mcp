import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { BukClient } from './buk-client.js';
import { createServer } from './server.js';
import { BukOAuthProvider, type BukCredentials, type OAuthOptions, validateRedirectUri } from './oauth.js';

export interface HttpOptions {
  env?: NodeJS.ProcessEnv;
  publicUrl?: string;
  authMode?: 'oauth' | 'bearer';
  bearerToken?: string;
  credentials?: { tenantUrl: string; apiKey: string; country?: string; allowWrites?: boolean };
  oauth?: Partial<Omit<OAuthOptions, 'publicUrl'>>;
  /** Injection points for deterministic tests; production uses the real Buk client and MCP server. */
  clientFactory?: (credentials: { tenantUrl: string; apiKey: string; country?: string; allowWrites?: boolean }) => BukClient;
  serverFactory?: (client: BukClient) => Server;
}

const DEFAULT_REDIRECTS = ['https://chatgpt.com/connector_platform/oauth_redirect'];
const digest = (value: string) => createHash('sha256').update(value).digest();

export function parsePublicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('PUBLIC_URL must be a valid absolute URL.'); }
  const loopback = ['localhost', '127.0.0.1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('PUBLIC_URL must be an HTTPS origin without a path, credentials, query or fragment. HTTP is allowed only on localhost/127.0.0.1.');
  }
  return url;
}

/** Creates an authenticated, stateless HTTP app. Every POST owns its client, server and transport. */
export function createHttpApp(options: HttpOptions = {}): Express {
  const env = options.env ?? process.env;
  const publicUrl = parsePublicUrl(options.publicUrl ?? env.PUBLIC_URL ?? 'http://127.0.0.1:3000');
  const configuredMode = options.authMode ?? env.BUK_AUTH_MODE ?? 'oauth';
  if (!['oauth', 'bearer'].includes(configuredMode)) throw new Error('BUK_AUTH_MODE must be oauth or bearer.');
  const mode = configuredMode as 'oauth' | 'bearer';
  const factory = options.clientFactory ?? (credentials => new BukClient(credentials));
  const serverFactory = options.serverFactory ?? createServer;
  const redirects = options.oauth?.redirectUris ?? (env.OAUTH_REDIRECT_URIS ? env.OAUTH_REDIRECT_URIS.split(',').map(value => value.trim()).filter(Boolean) : DEFAULT_REDIRECTS);
  const allowedOrigins = new Set([publicUrl.origin, ...redirects.map(uri => new URL(validateRedirectUri(uri)).origin)]);
  const app = express();
  app.disable('x-powered-by');
  // Deliberately do not trust arbitrary Forwarded/X-Forwarded-* headers. A local
  // reverse proxy must preserve Host; per-IP limits then also aggregate at it.
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    if (publicUrl.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const host = req.headers.host ?? '';
    let hostname: string;
    try {
      if (!host || /[\s/@\\]/.test(host)) throw new Error('invalid');
      hostname = new URL(`http://${host}`).hostname;
    } catch { res.status(400).json({ error: 'invalid_host' }); return; }
    if (hostname !== publicUrl.hostname) { res.status(403).json({ error: 'untrusted_host' }); return; }
    const origin = req.get('origin');
    if (origin && !allowedOrigins.has(origin)) { res.status(403).json({ error: 'untrusted_origin' }); return; }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });
  const smallJson = express.json({ limit: '256kb', strict: true });
  // MCP bodies are parsed only after authentication and rate limiting. An
  // isolated write deployment also needs room for the supported 10 MiB file
  // payload after its base64 expansion; public read-only OAuth stays smaller.
  app.use((req, res, next) => /^\/mcp\/?$/i.test(req.path) ? next() : smallJson(req, res, next));
  app.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 20 }));
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok', transport: 'streamable-http', auth: mode }); });
  app.get('/', (_req, res) => { res.type('text').send('Buk MCP community server. Authenticated MCP endpoint: /mcp. This integration is not an official Buk product.'); });

  let provider: BukOAuthProvider | undefined;
  let fixedCredentials: { tenantUrl: string; apiKey: string; country?: string; allowWrites?: boolean } | undefined;
  if (mode === 'oauth') {
    if (env.BUK_ALLOW_WRITES === 'true' || options.credentials?.allowWrites) throw new Error('Writes cannot be enabled in multi-tenant OAuth mode. Use an isolated single-tenant deployment.');
    const masterKey = options.oauth?.masterKey ?? env.OAUTH_MASTER_KEY;
    if (!masterKey) throw new Error('OAUTH_MASTER_KEY is required in OAuth mode. Generate 32 random bytes and supply them through the deployment secret manager.');
    provider = new BukOAuthProvider({
      ...options.oauth,
      publicUrl,
      masterKey,
      dataDir: options.oauth?.dataDir ?? env.OAUTH_DATA_DIR ?? '.buk-mcp',
      redirectUris: redirects,
      validateCredentials: options.oauth?.validateCredentials ?? (async credentials => { await factory(credentials).read('/employees', { query: { page: 1, page_size: 25 } }); }),
    });
    app.locals.oauthProvider = provider;
    app.post('/authorize/complete', rateLimiter(10, 60_000), (req, res, next) => { provider!.completeAuthorization(req, res).catch(next); });
    app.use(mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      resourceServerUrl: provider.resource,
      resourceName: 'Buk MCP',
      scopesSupported: ['buk:read'],
      // Keep client secrets stable; access and refresh tokens expire normally.
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }));
    app.use('/mcp', requireBearerAuth({ verifier: provider, requiredScopes: ['buk:read'], expectedResource: provider.resource, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(provider.resource) }));
  } else {
    const token = options.bearerToken ?? env.BUK_MCP_ACCESS_TOKEN;
    if (!token || token.length < 32 || /\s/.test(token)) throw new Error('BUK_MCP_ACCESS_TOKEN must be a random bearer token of at least 32 characters, without whitespace.');
    fixedCredentials = options.credentials ?? { tenantUrl: env.BUK_TENANT_URL ?? '', apiKey: env.BUK_API_KEY ?? '', country: env.BUK_COUNTRY ?? 'chile', allowWrites: env.BUK_ALLOW_WRITES === 'true' };
    // Validate configuration at startup; never perform a live request here.
    factory(fixedCredentials);
    const expected = digest(token);
    app.use('/mcp', (req, res, next) => {
      const match = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') ?? '');
      if (!match || !timingSafeEqual(digest(match[1]), expected)) { res.setHeader('WWW-Authenticate', 'Bearer'); res.status(401).json({ error: 'invalid_token' }); return; }
      next();
    });
  }

  app.post('/mcp', rateLimiter(120, 60_000), express.json({ limit: mode === 'bearer' && fixedCredentials?.allowWrites ? '16mb' : '256kb', strict: true }), async (req, res) => {
    let server: Server | undefined;
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      const credentials = provider ? await provider.credentialsForAccessToken(req.auth!.token) : { ...fixedCredentials! };
      // Fresh per-request objects prevent cross-tenant transport/session leakage.
      const client = factory(credentials);
      server = serverFactory(client);
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => { void transport?.close().catch(() => {}); void server?.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'The request could not be completed.' }, id: null });
      else res.end();
      await transport?.close().catch(() => {});
      await server?.close().catch(() => {});
    }
  });
  app.all('/mcp', (_req, res) => { res.setHeader('Allow', 'POST'); res.status(405).json({ error: 'method_not_allowed', message: 'This server uses stateless Streamable HTTP POST requests.' }); });
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { res.end(); return; }
    const status = error && typeof error === 'object' && 'status' in error && error.status === 413 ? 413 : 400;
    res.status(status).json({ error: status === 413 ? 'request_too_large' : 'invalid_request' });
  });
  return app;
}

/** Start the HTTP transport. Production PUBLIC_URL uses HTTPS at the reverse proxy. */
export async function startHttpServer(options: HttpOptions & { port?: number; host?: string } = {}): Promise<HttpServer> {
  const env = options.env ?? process.env;
  const port = options.port ?? Number(env.PORT ?? 3000);
  const host = options.host ?? env.HOST ?? '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535.');
  const publicUrl = parsePublicUrl(options.publicUrl ?? env.PUBLIC_URL ?? `http://127.0.0.1:${port || 3000}`);
  if (publicUrl.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Development HTTP must bind to a loopback interface. Configure an HTTPS PUBLIC_URL before exposing the server.');
  const app = createHttpApp({ ...options, publicUrl: publicUrl.href });
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
    server.requestTimeout = 60_000;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 5000;
  });
}

/** Bounded in-memory rate limiter. With a reverse proxy, limits aggregate unless isolated upstream. */
function rateLimiter(maximum: number, windowMs: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (buckets.size > 5000) for (const [key, value] of buckets) if (value.resetAt <= now) buckets.delete(key);
    const key = req.auth ? digest(req.auth.token).toString('hex') : req.ip ?? req.socket.remoteAddress ?? 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= 10_000) { res.status(429).json({ error: 'too_many_requests' }); return; }
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    if (++bucket.count > maximum) { res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000))); res.status(429).json({ error: 'too_many_requests' }); return; }
    next();
  };
}
