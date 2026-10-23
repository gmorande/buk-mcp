import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { BukOAuthProvider, validateRedirectUri, type BukCredentials } from '../src/oauth.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

const CALLBACK = 'https://chatgpt.com/connector_platform/oauth_redirect';
const URL_BASE = new URL('https://mcp.example.com');
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(validateCredentials?: (config: BukCredentials) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'buk-oauth-test-'));
  directories.push(directory);
  let time = Math.floor(Date.now() / 1000);
  const options = { publicUrl: URL_BASE, dataDir: directory, masterKey: randomBytes(32).toString('base64'), redirectUris: [CALLBACK], now: () => time, accessTokenSeconds: 60, refreshTokenSeconds: 3600, validateCredentials: validateCredentials ?? (async () => {}) };
  return { provider: new BukOAuthProvider(options), options, directory, advance: (seconds: number) => { time += seconds; } };
}

function response() {
  const result = { status: 200, html: '', redirect: '', cookie: '', cleared: false };
  const res = {
    cookie(_name: string, value: string) { result.cookie = value; return this; },
    clearCookie() { result.cleared = true; return this; },
    setHeader() { return this; },
    type() { return this; },
    send(value: string) { result.html = value; return this; },
    status(value: number) { result.status = value; return this; },
    redirect(status: number, value: string) { result.status = status; result.redirect = value; return this; },
  } as unknown as Response;
  return { res, result };
}

async function register(provider: BukOAuthProvider) {
  return provider.clientsStore.registerClient!({ redirect_uris: [CALLBACK], client_name: 'Test client', token_endpoint_auth_method: 'none' });
}

async function begin(provider: BukOAuthProvider, client: OAuthClientInformationFull) {
  const challenge = createHash('sha256').update('a'.repeat(43)).digest('base64url');
  const output = response();
  await provider.authorize(client, { codeChallenge: challenge, redirectUri: CALLBACK, state: 'state123', resource: new URL('/mcp', URL_BASE), scopes: ['buk:read'] }, output.res);
  return { ...output, id: /name="request_id" value="([^"]+)"/.exec(output.result.html)![1], csrf: /name="csrf" value="([^"]+)"/.exec(output.result.html)![1] };
}

async function approve(provider: BukOAuthProvider, client: OAuthClientInformationFull, credentials = { tenantUrl: 'https://alpha.buk.cl', apiKey: 'alpha-api-secret' }) {
  const auth = await begin(provider, client);
  const output = response();
  const req = { body: { request_id: auth.id, csrf: auth.csrf, decision: 'allow', tenant_url: credentials.tenantUrl, api_key: credentials.apiKey, country: 'chile' }, headers: { cookie: `buk_oauth_browser=${auth.result.cookie}` }, get: (name: string) => name === 'origin' ? URL_BASE.origin : undefined } as unknown as Request;
  await provider.completeAuthorization(req, output.res);
  expect(output.result.status).toBe(303);
  const redirect = new URL(output.result.redirect);
  expect(redirect.origin).toBe(new URL(CALLBACK).origin);
  expect(redirect.searchParams.get('state')).toBe('state123');
  expect(redirect.searchParams.get('iss')).toBe(URL_BASE.href);
  return { code: redirect.searchParams.get('code')!, request: req };
}

describe('OAuth authorization and credential custody', () => {
  it('keeps every access token bound to its own tenant and stores only encrypted secrets', async () => {
    const f = fixture();
    const client = await register(f.provider);
    const first = await approve(f.provider, client);
    const alpha = await f.provider.exchangeAuthorizationCode(client, first.code, undefined, CALLBACK);
    const second = await approve(f.provider, client, { tenantUrl: 'https://beta.buk.cl', apiKey: 'beta-api-secret' });
    const beta = await f.provider.exchangeAuthorizationCode(client, second.code, undefined, CALLBACK);
    expect((await f.provider.credentialsForAccessToken(alpha.access_token)).tenantUrl).toBe('https://alpha.buk.cl');
    expect((await f.provider.credentialsForAccessToken(beta.access_token)).tenantUrl).toBe('https://beta.buk.cl');
    expect((await f.provider.credentialsForAccessToken(alpha.access_token)).allowWrites).toBe(false);
    const file = readFileSync(join(f.directory, 'oauth-state.enc'), 'utf8');
    for (const secret of ['alpha-api-secret', 'beta-api-secret', alpha.access_token, alpha.refresh_token!, beta.access_token]) expect(file).not.toContain(secret);
    const restarted = new BukOAuthProvider(f.options);
    expect((await restarted.credentialsForAccessToken(beta.access_token)).apiKey).toBe('beta-api-secret');
    expect(() => new BukOAuthProvider({ ...f.options, masterKey: randomBytes(32).toString('base64') })).toThrow('Unable to open OAuth state');
  });

  it('expires tokens, rotates refresh tokens and revokes the family on reuse', async () => {
    const f = fixture();
    const client = await register(f.provider);
    const { code } = await approve(f.provider, client);
    const initial = await f.provider.exchangeAuthorizationCode(client, code);
    f.advance(61);
    await expect(f.provider.verifyAccessToken(initial.access_token)).rejects.toThrow('expired');
    const rotated = await f.provider.exchangeRefreshToken(client, initial.refresh_token!);
    expect(rotated.refresh_token).not.toBe(initial.refresh_token);
    await expect(f.provider.verifyAccessToken(rotated.access_token)).resolves.toHaveProperty('clientId', client.client_id);
    await expect(f.provider.exchangeRefreshToken(client, initial.refresh_token!)).rejects.toThrow('replay');
    await expect(f.provider.verifyAccessToken(rotated.access_token)).rejects.toThrow();
  });

  it('does not let a different client consume, refresh or revoke someone else’s grant', async () => {
    const f = fixture();
    const owner = await register(f.provider);
    const other = await register(f.provider);
    const { code } = await approve(f.provider, owner);
    await expect(f.provider.challengeForAuthorizationCode(other, code)).rejects.toThrow();
    const tokens = await f.provider.exchangeAuthorizationCode(owner, code);
    await expect(f.provider.exchangeRefreshToken(other, tokens.refresh_token!)).rejects.toThrow();
    await f.provider.revokeToken(other, { token: tokens.access_token });
    await expect(f.provider.verifyAccessToken(tokens.access_token)).resolves.toBeDefined();
    await f.provider.revokeToken(owner, { token: tokens.refresh_token! });
    await expect(f.provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  it('checks resource, redirect and one-time authorization-code use', async () => {
    const f = fixture();
    const client = await register(f.provider);
    const { code } = await approve(f.provider, client);
    await expect(f.provider.exchangeAuthorizationCode(client, code, undefined, 'https://evil.example/callback')).rejects.toThrow('redirect');
    await expect(f.provider.exchangeAuthorizationCode(client, code, undefined, CALLBACK, new URL('https://evil.example/mcp'))).rejects.toThrow('resource');
    await f.provider.exchangeAuthorizationCode(client, code, undefined, CALLBACK, new URL('/mcp', URL_BASE));
    await expect(f.provider.exchangeAuthorizationCode(client, code)).rejects.toThrow();
  });

  it('rejects callback injection and scope escalation', async () => {
    const f = fixture();
    await expect(f.provider.clientsStore.registerClient!({ redirect_uris: ['https://evil.example/callback'], token_endpoint_auth_method: 'none' })).rejects.toThrow('allowlist');
    const client = await register(f.provider);
    const output = response();
    await expect(f.provider.authorize(client, { codeChallenge: 'a'.repeat(43), redirectUri: CALLBACK, scopes: ['buk:write'] }, output.res)).rejects.toThrow('buk:read');
    await expect(f.provider.authorize(client, { codeChallenge: 'a'.repeat(43), redirectUri: CALLBACK, resource: new URL('https://other.example/mcp') }, output.res)).rejects.toThrow('resource');
    for (const callback of ['http://external.example/callback', 'https://example.com/#fragment', 'https://user:secret@example.com/callback', 'https://example.com/*']) expect(() => validateRedirectUri(callback)).toThrow();
  });

  it('bounds public registration metadata before persisting it', async () => {
    const f = fixture();
    const before = readFileSync(join(f.directory, 'oauth-state.enc'), 'utf8');
    await expect(f.provider.clientsStore.registerClient!({ redirect_uris: [CALLBACK], client_name: 'x'.repeat(4096), token_endpoint_auth_method: 'none' })).rejects.toThrow('4 KiB');
    expect(readFileSync(join(f.directory, 'oauth-state.enc'), 'utf8')).toBe(before);
    await expect(register(f.provider)).resolves.toHaveProperty('client_id');
  });

  it('rejects consent without matching origin, cookie and CSRF token', async () => {
    const f = fixture();
    const client = await register(f.provider);
    const auth = await begin(f.provider, client);
    const output = response();
    await f.provider.completeAuthorization({ body: { request_id: auth.id, csrf: auth.csrf, decision: 'allow' }, headers: { cookie: `buk_oauth_browser=${auth.result.cookie}` }, get: () => 'https://evil.example' } as unknown as Request, output.res);
    expect(output.result.status).toBe(403);
    const output2 = response();
    await f.provider.completeAuthorization({ body: { request_id: auth.id, csrf: 'wrong', decision: 'allow' }, headers: { cookie: `buk_oauth_browser=${auth.result.cookie}` }, get: () => URL_BASE.origin } as unknown as Request, output2.res);
    expect(output2.result.status).toBe(403);
    const output3 = response();
    await f.provider.completeAuthorization({ body: { request_id: auth.id, csrf: auth.csrf, decision: 'allow' }, headers: { cookie: 'buk_oauth_browser=wrong' }, get: () => URL_BASE.origin } as unknown as Request, output3.res);
    expect(output3.result.status).toBe(403);
  });

  it('does not echo credentials or upstream errors when verification fails', async () => {
    const f = fixture(async credentials => { throw new Error(`Network failed ${credentials.apiKey}`); });
    const client = await register(f.provider);
    const auth = await begin(f.provider, client);
    const output = response();
    await f.provider.completeAuthorization({ body: { request_id: auth.id, csrf: auth.csrf, decision: 'allow', tenant_url: 'https://alpha.buk.cl', api_key: 'SUPERSECRET', country: 'chile' }, headers: { cookie: `buk_oauth_browser=${auth.result.cookie}` }, get: () => URL_BASE.origin } as unknown as Request, output.res);
    expect(output.result.status).toBe(400);
    expect(output.result.html).not.toContain('SUPERSECRET');
    expect(readFileSync(join(f.directory, 'oauth-state.enc'), 'utf8')).not.toContain('SUPERSECRET');
  });

  it('rejects expired authorization sessions and absolute refresh expiry', async () => {
    const f = fixture();
    const client = await register(f.provider);
    const { code } = await approve(f.provider, client);
    f.advance(121);
    await expect(f.provider.exchangeAuthorizationCode(client, code)).rejects.toThrow();
    const next = await approve(f.provider, client);
    const tokens = await f.provider.exchangeAuthorizationCode(client, next.code);
    f.advance(3601);
    await expect(f.provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow('expired');
  });
});
