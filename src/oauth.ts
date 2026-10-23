import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Request, Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTargetError, InvalidTokenError, TemporarilyUnavailableError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export interface BukCredentials {
  tenantUrl: string;
  apiKey: string;
  country?: string;
  allowWrites?: false;
}

interface Connection { credentials: BukCredentials; createdAt: number }
interface Grant {
  clientId: string;
  connectionId: string;
  familyId: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
  used?: boolean;
  revoked?: boolean;
}
interface StoredState {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  connections: Record<string, Connection>;
  accessTokens: Record<string, Grant>;
  refreshTokens: Record<string, Grant>;
}
interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  codeChallenge: string;
  state?: string;
  csrf: string;
  browserHash: string;
  expiresAt: number;
}
interface AuthorizationCode extends Omit<PendingAuthorization, 'csrf' | 'browserHash'> { connectionId: string }

export interface OAuthOptions {
  publicUrl: URL;
  masterKey: string;
  dataDir: string;
  /** Exact callback URLs admitted during client registration. No wildcards. */
  redirectUris: string[];
  validateCredentials: (credentials: BukCredentials) => Promise<void>;
  now?: () => number;
  accessTokenSeconds?: number;
  refreshTokenSeconds?: number;
  maximumConnections?: number;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const nonce = () => randomBytes(32).toString('base64url');
const equal = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const COOKIE_NAME = 'buk_oauth_browser';
const MAX_ENTRIES = 10_000;

/**
 * Small, single-process encrypted credential store. This is deliberately not a
 * distributed database. One process must own the data directory (see deployment).
 * Raw access/refresh tokens are never written to disk: only SHA-256 digests are.
 */
class EncryptedStore {
  readonly state: StoredState;
  private readonly key: Buffer;
  private readonly filename: string;

  constructor(dataDir: string, masterKey: string) {
    this.key = Buffer.from(masterKey, 'base64');
    if (this.key.length !== 32 || this.key.toString('base64') !== masterKey) {
      throw new Error('OAUTH_MASTER_KEY must be exactly 32 random bytes, encoded as canonical base64.');
    }
    const directory = resolve(dataDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.filename = join(directory, 'oauth-state.enc');
    if (!existsSync(this.filename)) {
      this.state = { version: 1, clients: {}, connections: {}, accessTokens: {}, refreshTokens: {} };
      this.save();
      return;
    }
    try {
      if (statSync(this.filename).size > 20 * 1024 * 1024) throw new Error('oversized store');
      const envelope = JSON.parse(readFileSync(this.filename, 'utf8'));
      if (envelope.version !== 1) throw new Error('unknown version');
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from('buk-mcp-oauth-state-v1'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      const parsed = JSON.parse(plaintext.toString('utf8')) as StoredState;
      if (parsed.version !== 1 || !parsed.clients || !parsed.connections || !parsed.accessTokens || !parsed.refreshTokens) throw new Error('invalid state');
      this.state = parsed;
      chmodSync(this.filename, 0o600);
    } catch {
      throw new Error('Unable to open OAuth state. Check OAUTH_MASTER_KEY and restore an intact encrypted backup; the state was not replaced.');
    }
  }

  save(): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('buk-mcp-oauth-state-v1'));
    const data = Buffer.concat([cipher.update(JSON.stringify(this.state), 'utf8'), cipher.final()]);
    const temporary = `${this.filename}.${nonce()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.filename);
  }
}

/** OAuth 2.1 provider for the SDK's standard auth handlers; Buk keys stay server-side. */
export class BukOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly resource: URL;
  private readonly store: EncryptedStore;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly now: () => number;
  private readonly accessTokenSeconds: number;
  private readonly refreshTokenSeconds: number;
  private readonly maximumConnections: number;
  private readonly redirects: Set<string>;

  constructor(private readonly options: OAuthOptions) {
    this.resource = new URL('/mcp', options.publicUrl);
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.accessTokenSeconds = options.accessTokenSeconds ?? 3600;
    this.refreshTokenSeconds = options.refreshTokenSeconds ?? 30 * 24 * 3600;
    this.maximumConnections = options.maximumConnections ?? 1000;
    this.redirects = new Set(options.redirectUris.map(validateRedirectUri));
    if (this.redirects.size === 0) throw new Error('OAUTH_REDIRECT_URIS must contain at least one exact trusted OAuth callback URL.');
    this.store = new EncryptedStore(options.dataDir, options.masterKey);
    this.clientsStore = {
      getClient: clientId => Object.hasOwn(this.store.state.clients, clientId) ? this.store.state.clients[clientId] : undefined,
      registerClient: async metadata => {
        this.cleanup();
        // DCR is public. Bound bytes as well as client count so oversized names,
        // JWKs or software statements cannot exhaust the persistent store.
        if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 4096) throw new InvalidClientMetadataError('Client metadata exceeds the 4 KiB registration limit.');
        if (Object.keys(this.store.state.clients).length >= 1000) throw new TemporarilyUnavailableError('Client registration capacity reached.');
        if (!metadata.redirect_uris.length || metadata.redirect_uris.length > 10 || metadata.redirect_uris.some(uri => !this.redirects.has(validateRedirectUri(uri)))) {
          throw new InvalidClientMetadataError('A redirect URI is not in the operator callback allowlist.');
        }
        if (!['none', 'client_secret_post'].includes(metadata.token_endpoint_auth_method ?? 'client_secret_post')) throw new InvalidClientMetadataError('Unsupported client authentication method.');
        if (metadata.grant_types?.some(value => !['authorization_code', 'refresh_token'].includes(value)) || metadata.response_types?.some(value => value !== 'code')) throw new InvalidClientMetadataError('Only authorization code with PKCE and refresh tokens are supported.');
        const client: OAuthClientInformationFull = {
          ...metadata,
          client_id: nonce(),
          client_id_issued_at: this.now(),
          client_secret_expires_at: metadata.client_secret ? 0 : undefined,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: 'buk:read',
        };
        this.store.state.clients[client.client_id] = client;
        this.store.save();
        return client;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.cleanup();
    this.checkResource(params.resource);
    if (!client.redirect_uris.includes(params.redirectUri) || !this.redirects.has(params.redirectUri)) throw new InvalidRequestError('Unregistered redirect URI.');
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('A valid S256 PKCE challenge is required.');
    const scopes = params.scopes?.filter(Boolean).length ? params.scopes.filter(Boolean) : ['buk:read'];
    if (scopes.some(scope => scope !== 'buk:read')) throw new InvalidScopeError('This server grants buk:read only.');
    if ((params.state?.length ?? 0) > 1024) throw new InvalidRequestError('State is too long.');
    if (this.pending.size >= 500) throw new TemporarilyUnavailableError('Too many outstanding authorization requests.');
    const id = nonce();
    const browserSecret = nonce();
    const csrf = nonce();
    this.pending.set(id, { clientId: client.client_id, redirectUri: params.redirectUri, resource: this.resource.href, codeChallenge: params.codeChallenge, scopes: [...new Set(scopes)], state: params.state, csrf, browserHash: hash(browserSecret), expiresAt: this.now() + 600 });
    res.cookie(COOKIE_NAME, browserSecret, { httpOnly: true, secure: this.options.publicUrl.protocol === 'https:', sameSite: 'lax', maxAge: 600_000, path: '/authorize' });
    const clientName = String(client.client_name ?? 'MCP client').slice(0, 120);
    const callback = new URL(params.redirectUri);
    res.type('html').send(consentPage(id, csrf, clientName, callback.origin));
  }

  /** The browser posts directly to this handler; credentials never enter MCP tool arguments. */
  async completeAuthorization(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const body = req.body as Record<string, unknown> | undefined;
    const id = typeof body?.request_id === 'string' ? body.request_id : '';
    const record = this.pending.get(id);
    const csrf = typeof body?.csrf === 'string' ? body.csrf : '';
    const cookies = req.headers.cookie?.split(';').map(value => value.trim()) ?? [];
    const cookie = cookies.find(value => value.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1) ?? '';
    if (!record || record.expiresAt <= this.now() || req.get('origin') !== this.options.publicUrl.origin || !equal(csrf, record.csrf) || !equal(hash(cookie), record.browserHash)) {
      res.status(403).type('text').send('Authorization session invalid or expired. Start a new connection from your MCP client.');
      return;
    }
    // Consume before asynchronous validation: one browser request cannot mint multiple grants.
    this.pending.delete(id);
    res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: this.options.publicUrl.protocol === 'https:', sameSite: 'lax', path: '/authorize' });
    const redirect = new URL(record.redirectUri);
    if (record.state) redirect.searchParams.set('state', record.state);
    redirect.searchParams.set('iss', this.options.publicUrl.href);
    if (body?.decision !== 'allow') {
      redirect.searchParams.set('error', 'access_denied');
      res.redirect(303, redirect.href);
      return;
    }
    const tenantUrl = typeof body.tenant_url === 'string' ? body.tenant_url.trim() : '';
    const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
    const country = typeof body.country === 'string' ? body.country : 'chile';
    if (!tenantUrl || tenantUrl.length > 256 || !apiKey || apiKey.length > 4096 || /[\r\n]/.test(apiKey) || country !== 'chile') {
      res.status(400).type('text').send('Invalid connection fields. Start a new connection and check the Buk URL and API key.');
      return;
    }
    const credentials: BukCredentials = { tenantUrl, apiKey, country, allowWrites: false };
    try {
      await this.options.validateCredentials(credentials);
      this.cleanup();
      if (Object.keys(this.store.state.connections).length >= this.maximumConnections) throw new Error('capacity');
      const connectionId = nonce();
      this.store.state.connections[connectionId] = { credentials, createdAt: this.now() };
      const code = nonce();
      this.codes.set(hash(code), { clientId: record.clientId, redirectUri: record.redirectUri, resource: record.resource, scopes: record.scopes, codeChallenge: record.codeChallenge, state: record.state, expiresAt: this.now() + 120, connectionId });
      this.store.save();
      redirect.searchParams.set('code', code);
      res.redirect(303, redirect.href);
    } catch {
      // Never send Buk response bodies, credentials or network errors back to the browser.
      res.status(400).type('text').send('The connection could not be verified. Check API access and permissions in Buk, then start a new connection.');
    }
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.validCode(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    this.checkResource(resource);
    const record = this.validCode(client, code);
    if (redirectUri !== undefined && record.redirectUri !== redirectUri) throw new InvalidGrantError('Authorization code redirect mismatch.');
    // The SDK token handler validates S256 PKCE before calling this method.
    this.codes.delete(hash(code));
    return this.issueTokens({ clientId: client.client_id, connectionId: record.connectionId, familyId: nonce(), resource: record.resource, scopes: record.scopes, expiresAt: this.now() + this.refreshTokenSeconds });
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.checkResource(resource);
    const record = this.store.state.refreshTokens[hash(token)];
    if (!record || record.clientId !== client.client_id || record.expiresAt <= this.now()) throw new InvalidGrantError('Invalid or expired refresh token.');
    if (record.used || record.revoked) {
      this.revokeFamily(record.familyId);
      throw new InvalidGrantError('Refresh token replay detected; reconnect your account.');
    }
    if (scopes?.some(scope => !record.scopes.includes(scope))) throw new InvalidScopeError('Cannot expand the granted scope.');
    if (!this.store.state.connections[record.connectionId]) throw new InvalidGrantError('Connection was revoked.');
    // Rotation has an absolute lifetime: repeated refreshes do not extend authorization forever.
    record.used = true;
    return this.issueTokens({ ...record, used: undefined, revoked: undefined, scopes: scopes?.length ? scopes : record.scopes });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.state.accessTokens[hash(token)];
    if (!record || record.revoked || record.expiresAt <= this.now() || record.resource !== this.resource.href || !this.store.state.connections[record.connectionId]) throw new InvalidTokenError('Invalid or expired access token.');
    return { token, clientId: record.clientId, scopes: record.scopes, expiresAt: record.expiresAt, resource: this.resource, extra: { connectionId: record.connectionId } };
  }

  async credentialsForAccessToken(token: string): Promise<BukCredentials> {
    const auth = await this.verifyAccessToken(token);
    const connection = this.store.state.connections[String(auth.extra?.connectionId)];
    return { ...connection.credentials, allowWrites: false };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const digest = hash(request.token);
    const record = this.store.state.accessTokens[digest] ?? this.store.state.refreshTokens[digest];
    if (record?.clientId === client.client_id) this.revokeFamily(record.familyId);
  }

  private issueTokens(grant: Grant): OAuthTokens {
    this.cleanup();
    if (Object.keys(this.store.state.accessTokens).length + Object.keys(this.store.state.refreshTokens).length >= MAX_ENTRIES) throw new TemporarilyUnavailableError('Token storage capacity reached.');
    const accessToken = nonce();
    const refreshToken = nonce();
    const accessExpires = Math.min(this.now() + this.accessTokenSeconds, grant.expiresAt);
    this.store.state.accessTokens[hash(accessToken)] = { ...grant, expiresAt: accessExpires };
    this.store.state.refreshTokens[hash(refreshToken)] = { ...grant };
    this.store.save();
    return { access_token: accessToken, token_type: 'Bearer', expires_in: accessExpires - this.now(), refresh_token: refreshToken, scope: grant.scopes.join(' ') };
  }

  private validCode(client: OAuthClientInformationFull, code: string): AuthorizationCode {
    const record = this.codes.get(hash(code));
    if (!record || record.clientId !== client.client_id || record.expiresAt <= this.now()) throw new InvalidGrantError('Invalid, expired or already used authorization code.');
    return record;
  }

  private checkResource(resource?: URL): void {
    if (resource && resource.href !== this.resource.href) throw new InvalidTargetError('The requested resource does not match this MCP server.');
  }

  private revokeFamily(familyId: string): void {
    const connectionIds = new Set<string>();
    for (const table of [this.store.state.accessTokens, this.store.state.refreshTokens]) {
      for (const grant of Object.values(table)) if (grant.familyId === familyId) { grant.revoked = true; connectionIds.add(grant.connectionId); }
    }
    for (const id of connectionIds) delete this.store.state.connections[id];
    this.store.save();
  }

  private cleanup(): void {
    const now = this.now();
    for (const [key, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(key);
    for (const [key, value] of this.codes) if (value.expiresAt <= now) this.codes.delete(key);
    for (const table of [this.store.state.accessTokens, this.store.state.refreshTokens]) {
      for (const [key, value] of Object.entries(table)) if (value.expiresAt <= now) delete table[key];
    }
    const used = new Set([...Object.values(this.store.state.accessTokens), ...Object.values(this.store.state.refreshTokens), ...this.codes.values()].map(value => value.connectionId));
    for (const [id, connection] of Object.entries(this.store.state.connections)) if (!used.has(id) && connection.createdAt < now - 180) delete this.store.state.connections[id];
  }
}

export function validateRedirectUri(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new InvalidClientMetadataError('Invalid redirect URI.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || value.includes('*') || value.length > 2048 || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new InvalidClientMetadataError('Redirect URIs must use HTTPS, or HTTP on loopback for development, without credentials, fragments or wildcards.');
  return url.href;
}

function consentPage(id: string, csrf: string, clientName: string, callbackOrigin: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar Buk</title><style>body{font:16px system-ui;background:#f5f6fa;color:#14213d;margin:0;padding:32px 18px}main{max-width:520px;margin:auto;background:#fff;padding:28px;border:1px solid #dfe3eb;border-radius:12px}h1{font-size:26px}label{display:block;margin-top:18px;font-weight:600}input,select{box-sizing:border-box;width:100%;padding:11px;border:1px solid #abb4c4;border-radius:5px;font:inherit;margin-top:6px}button{padding:12px 16px;margin:20px 8px 0 0;border-radius:5px;border:0;font:inherit;cursor:pointer}button[value=allow]{background:#213d8d;color:white}small{display:block;color:#536079;line-height:1.5}p{line-height:1.5}.client{overflow-wrap:anywhere;background:#eef2fa;padding:12px}</style></head><body><main><h1>Conectar tu empresa en Buk</h1><p>Autoriza consultas de lectura desde este cliente:</p><p class="client"><strong>${escapeHtml(clientName)}</strong><br>${escapeHtml(callbackOrigin)}</p><p>El acceso incluye los datos que permita tu API key, también remuneraciones si habilitaste datos sensibles. Este servidor no modificará Buk. Usa una clave dedicada con permisos de lectura.</p><form method="post" action="/authorize/complete" autocomplete="off"><input type="hidden" name="request_id" value="${id}"><input type="hidden" name="csrf" value="${csrf}"><label>URL de tu empresa en Buk<input name="tenant_url" type="url" placeholder="https://tuempresa.buk.cl" maxlength="256" required></label><label>País<select name="country"><option value="chile">Chile</option></select></label><label>API key de Buk<input name="api_key" type="password" maxlength="4096" autocomplete="new-password" required></label><small>La clave se envía directamente a este servidor y se guarda cifrada. No se comparte con el cliente MCP ni aparece en la conversación. El operador del servidor puede acceder a los datos autorizados. Revoca la conexión desde el cliente o elimina la clave en Buk para retirar el acceso.</small><button type="submit" name="decision" value="allow">Autorizar lectura</button><button type="submit" name="decision" value="deny" formnovalidate>Cancelar</button></form></main></body></html>`;
}
