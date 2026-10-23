import { afterEach, describe, expect, it, vi } from 'vitest';
import { BukApiError, BukClient, validateTenantUrl } from '../src/buk-client.js';

const TENANT = 'https://example.buk.cl';
const KEY = 'fake-test-token-do-not-use';
function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function client(fetcher: ReturnType<typeof vi.fn>, options: Record<string, unknown> = {}): BukClient {
  return new BukClient({ tenantUrl: TENANT, apiKey: KEY, retries: 0, ...options }, fetcher as typeof fetch);
}
function paged(data: unknown[], next: string | null, total_pages: number) {
  return { pagination: { next, previous: null, count: data.length, total_pages }, data };
}
afterEach(() => { vi.useRealTimers(); });

describe('Buk tenant and token boundaries', () => {
  it.each([
    'http://example.buk.cl', 'https://buk.cl', 'https://a.b.buk.cl', 'https://example.buk.cl.evil.invalid',
    'https://example.buk.cl:443', 'https://example.buk.cl/api/v1/chile', 'https://example.buk.cl/?x=1',
    'https://example.buk.cl#x', 'https://secret@example.buk.cl', 'https://127.0.0.1',
    'https://169.254.169.254', 'https://example.buk.cl\\@evil.invalid',
  ])('rejects an unsafe tenant origin %s before a request', tenantUrl => {
    const fetcher = vi.fn();
    expect(() => new BukClient({ tenantUrl, apiKey: KEY }, fetcher)).toThrow(BukApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('infers country without claiming a non-Chile schema and keeps the token non-enumerable', async () => {
    expect(validateTenantUrl('https://Tenant.buk.com.br/')).toEqual({ tenantUrl: 'https://tenant.buk.com.br', country: 'brasil' });
    const fetcher = vi.fn().mockResolvedValue(json({ data: [] }));
    const buk = new BukClient({ tenantUrl: 'https://tenant.buk.pe', apiKey: KEY }, fetcher);
    expect(buk.country).toBe('peru');
    expect(JSON.stringify(buk)).not.toContain(KEY);
    const result = await buk.read('/vacations/{id}', { path: { id: '123' } });
    expect(fetcher.mock.calls[0][0]).toBe('https://tenant.buk.pe/api/v1/peru/vacations/123');
    expect(fetcher.mock.calls[0][1].headers.auth_token).toBe(KEY);
    expect(result.meta.schemaCountry).toBe('chile');
  });

  it.each(['../accounting', '%2faccounting', '..', 'a/b', 'a\\b', 'a?x=1', 'a#fragment', 'a\nvalue'])('rejects path injection %s', async id => {
    const fetcher = vi.fn();
    await expect(client(fetcher).read('/vacations/{id}', { path: { id } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts only catalog routes, strict types and declared query fields', async () => {
    const fetcher = vi.fn(); const buk = client(fetcher);
    await expect(buk.read('https://evil.invalid')).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' });
    await expect(buk.read('/employees/{id}/jobs', { path: { id: { injected: '123' } } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    await expect(buk.read('/employees', { query: { auth_token: 'injected' } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('blocks redirects without forwarding the token or returning upstream text', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(KEY, { status: 302, headers: { location: 'https://evil.invalid' } }));
    await expect(client(fetcher).read('/employees')).rejects.toMatchObject({ code: 'REDIRECT_BLOCKED', status: 302 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].redirect).toBe('manual');
  });
});

describe('request validation and supported encodings', () => {
  it('gates writes before validation or network calls', async () => {
    const fetcher = vi.fn();
    await expect(client(fetcher).execute({ operationId: 'post_employees', body: {} })).rejects.toMatchObject({ code: 'WRITES_DISABLED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('serializes an allowed JSON write and never retries a failed write', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ message: KEY }, 503));
    const buk = client(fetcher, { allowWrites: true, retries: 2 });
    await expect(buk.execute({ operationId: 'post_piecework_tasks', body: { task: { code: 1, description: 'Example' } } })).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].body).toBe('{"task":{"code":1,"description":"Example"}}');
    expect(fetcher.mock.calls[0][1].headers['content-type']).toBe('application/json');
  });

  it('requires JSON bodies and validates nested documented fields', async () => {
    const fetcher = vi.fn(); const buk = client(fetcher, { allowWrites: true });
    await expect(buk.execute({ operationId: 'post_piecework_tasks' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    await expect(buk.execute({ operationId: 'post_piecework_tasks', body: { task: { seventh_workday: 'yes' } } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('serializes official multi-valued queries without changing query keys', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ pagination: { next: null, total_pages: 1 }, applicants: [] }));
    await client(fetcher).read('/recruiting/applicants/', { query: { 'selection_processes[]': [12, 17] } });
    const url = new URL(fetcher.mock.calls[0][0]);
    expect(url.searchParams.getAll('selection_processes[]')).toEqual(['12', '17']);
  });

  it('uploads multipart bytes with a generated boundary and Rails nested base64 fields', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(json({ employee_file: { id: 1 } }, 201)));
    const buk = client(fetcher, { allowWrites: true });
    await buk.execute({ operationId: 'post_employees_id_docs', path: { id: 7 }, query: { visible: false },
      form: { file: { filename: 'hello.txt', mimeType: 'text/plain', dataBase64: 'aGVsbG8=' } } });
    const init = fetcher.mock.calls[0][1];
    expect(init.headers['content-type']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    expect(await (init.body.get('file') as File).text()).toBe('hello');
    expect((init.body.get('file') as File).name).toBe('hello.txt');
    expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('visible')).toBe('false');
    await buk.execute({ operationId: 'post_employees_id_docs', path: { id: 7 }, form: { file_base64: { filename: 'hello.txt', content: 'aGVsbG8=' } } });
    expect(fetcher.mock.calls[1][1].body.get('file_base64[filename]')).toBe('hello.txt');
    expect(fetcher.mock.calls[1][1].body.get('file_base64[content]')).toBe('aGVsbG8=');
  });

  it('rejects missing documents, invalid base64 and unsafe filenames before writing', async () => {
    const fetcher = vi.fn(); const buk = client(fetcher, { allowWrites: true });
    for (const form of [{}, { file: { filename: '../secret', dataBase64: 'YQ==' } }, { file: { filename: 'x.pdf', dataBase64: 'not_base64' } }]) {
      await expect(buk.execute({ operationId: 'post_employees_id_docs', path: { id: 1 }, form })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns binary endpoints without corrupting file bytes', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 0, 255]);
    const fetcher = vi.fn().mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'application/pdf' } }));
    const result = await client(fetcher).read('/employees/{id}/statements/{year}-{month}.pdf', { path: { id: 1, year: 2025, month: 10 } });
    expect(result.data).toEqual({ contentType: 'application/pdf', encoding: 'base64', dataBase64: Buffer.from(bytes).toString('base64') });
    expect(result.meta.complete).toBe(true);
  });
});

describe('pagination completeness', () => {
  it('follows safe links, keeps original filters and merges data without treating count as a total', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(paged([{ id: 1 }], `${TENANT}/api/v1/chile/employees?page=2`, 2)))
      .mockResolvedValueOnce(json(paged([{ id: 2 }], null, 2)));
    const result = await client(fetcher).read('/employees', { query: { status: 'activo', page_size: 25 }, paginate: true });
    expect(result.data).toMatchObject({ data: [{ id: 1 }, { id: 2 }], pagination: { count: 1 } });
    expect(result.meta).toMatchObject({ pages: 2, complete: true, totalPages: 2 });
    const second = new URL(fetcher.mock.calls[1][0]);
    expect(second.searchParams.get('status')).toBe('activo');
    expect(second.searchParams.get('page_size')).toBe('25');
  });

  it('supports named list envelopes such as applicants', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ pagination: { total_pages: 2, next: '?page=2' }, applicants: [{ id: 1 }] }))
      .mockResolvedValueOnce(json({ pagination: { total_pages: 2, next: null }, applicants: [{ id: 2 }] }));
    const result = await client(fetcher).read('/recruiting/applicants/', { paginate: true });
    expect(result.data).toMatchObject({ applicants: [{ id: 1 }, { id: 2 }] });
    expect(result.meta.complete).toBe(true);
  });

  it('accepts a stable server-inserted page_size without accepting changed caller filters', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(paged([{ id: 1 }], '?page=2&page_size=25', 3)))
      .mockResolvedValueOnce(json(paged([{ id: 2 }], '?page=3', 3)))
      .mockResolvedValueOnce(json(paged([{ id: 3 }], null, 3)));
    const result = await client(fetcher).read('/employees', { paginate: true });
    expect(result.meta.complete).toBe(true);
    expect(new URL(fetcher.mock.calls[2][0]).searchParams.get('page_size')).toBe('25');
    const changed = vi.fn().mockResolvedValue(json(paged([], '?page=2&page_size=100', 2)));
    const partial = await client(changed).read('/employees', { query: { page_size: 25 }, paginate: true });
    expect(partial.meta).toMatchObject({ complete: false, partialReason: 'pagination_filters_changed' });
    expect(changed).toHaveBeenCalledOnce();
  });

  it('detects changing page totals instead of presenting a shifting result as complete', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json(paged([{ id: 1 }], '?page=2', 3)))
      .mockResolvedValueOnce(json(paged([{ id: 2 }], null, 2)));
    expect((await client(fetcher).read('/employees', { paginate: true })).meta)
      .toMatchObject({ complete: false, partialReason: 'pagination_total_changed' });
  });

  it('stops a large multi-page result at the cumulative byte limit and keeps it explicitly partial', async () => {
    const filler = 'x'.repeat(17 * 1024 * 1024);
    let page = 0;
    const fetcher = vi.fn().mockImplementation(() => {
      page++;
      return Promise.resolve(json(paged([{ id: page, filler }], page < 3 ? `?page=${page + 1}` : null, 3)));
    });
    const result = await client(fetcher).read('/employees', { paginate: true });
    expect(result.meta).toMatchObject({ complete: false, pages: 2, partialReason: 'response_size_limit' });
    expect(result.meta.responseBytes).toBeLessThan(50 * 1024 * 1024);
    expect((result.data as { data: unknown[] }).data).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('synthesizes pages for current_page/total_pages metadata and merges company accounting rows', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ pagination: { current_page: 1, total_pages: 2 }, data: { 'company-a': [{ amount: 1 }] } }))
      .mockResolvedValueOnce(json({ pagination: { current_page: 2, total_pages: 2 }, data: { 'company-a': [{ amount: 2 }], 'company-b': [{ amount: 3 }] } }));
    const result = await client(fetcher).read('/accounting_structure/export', { query: { accounting_structure_assignment_id: 1, month: 10, year: 2025 }, paginate: true });
    expect(result.data).toMatchObject({ data: { 'company-a': [{ amount: 1 }, { amount: 2 }], 'company-b': [{ amount: 3 }] } });
    expect(result.meta.complete).toBe(true);
  });

  it('marks capped, manual and later-starting pages as partial', async () => {
    const capped = vi.fn().mockImplementation(() => Promise.resolve(json(paged([{ id: 1 }], '?page=2', 3))));
    expect((await client(capped, { maxPages: 1 }).read('/employees', { paginate: true })).meta).toMatchObject({ complete: false, pages: 1, partialReason: 'max_pages' });
    expect((await client(capped).read('/employees')).meta).toMatchObject({ complete: false, partialReason: 'pagination_not_requested' });
    const final = vi.fn().mockResolvedValue(json(paged([{ id: 2 }], null, 2)));
    expect((await client(final).read('/employees', { query: { page: 2 } })).meta).toMatchObject({ complete: false, partialReason: 'starting_page_after_first' });
  });

  it.each([
    ['https://evil.invalid/api/v1/chile/employees?page=2', 'unsafe_pagination_link'],
    [`${TENANT}/api/v1/chile/accounting?page=2`, 'unsafe_pagination_link'],
    [`${TENANT}/api/v1/peru/employees?page=2`, 'unsafe_pagination_link'],
    [`${TENANT}/api/v1/chile/employees?page=2&auth_token=bad`, 'pagination_filters_changed'],
    ['?page=1', 'non_advancing_pagination'],
    ['?page=3', 'non_sequential_pagination'],
    ['?page=2&page=3', 'non_advancing_pagination'],
  ])('does not follow unsafe/inconsistent next links', async (next, partialReason) => {
    const fetcher = vi.fn().mockResolvedValue(json(paged([{ id: 1 }], next, 2)));
    expect((await client(fetcher).read('/employees', { paginate: true })).meta).toMatchObject({ complete: false, partialReason });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('marks missing metadata or later-page errors incomplete without exposing response bodies', async () => {
    const missing = vi.fn().mockResolvedValue(json({ data: [{ id: 1 }] }));
    expect((await client(missing).read('/employees', { paginate: true })).meta).toMatchObject({ complete: false, partialReason: 'pagination_metadata_missing' });
    const fetcher = vi.fn().mockResolvedValueOnce(json(paged([{ id: 1 }], '?page=2', 2))).mockResolvedValueOnce(json({ message: KEY }, 403));
    const result = await client(fetcher).read('/employees', { paginate: true });
    expect(result.meta).toMatchObject({ complete: false, pages: 1, partialReason: 'page_fetch_failed', pageError: { code: 'PERMISSION_DENIED', status: 403 } });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe('network failures, rate limits and privacy', () => {
  it('retries GET 429 respecting a short Retry-After and succeeds', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({}, 429, { 'retry-after': '0' })).mockResolvedValueOnce(json({ data: { id: 1 } }));
    const result = await client(fetcher, { retries: 1 }).read('/employees/{id}', { path: { id: '1' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.meta.complete).toBe(true);
  });

  it('returns long rate limits without retrying earlier than instructed', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({}, 429, { 'retry-after': '120' }));
    await expect(client(fetcher, { retries: 2 }).read('/employees')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('aborts a stalled request and sanitizes network errors and upstream errors', async () => {
    const stalled = vi.fn().mockImplementation(() => new Promise(() => {}));
    await expect(client(stalled, { timeoutMs: 5 }).read('/employees')).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(stalled.mock.calls[0][1].signal.aborted).toBe(true);
    const failing = vi.fn().mockRejectedValue(new Error(`request with auth_token=${KEY} failed`));
    try { await client(failing).read('/employees'); expect.unreachable(); }
    catch (error) { expect(String(error)).not.toContain(KEY); expect(error).toMatchObject({ code: 'NETWORK_ERROR' }); }
    const denied = vi.fn().mockResolvedValue(json({ request: { auth_token: KEY }, payroll: 'private' }, 403));
    try { await client(denied).read('/employees'); expect.unreachable(); }
    catch (error) { expect(JSON.stringify(error)).not.toContain(KEY); expect(error).toMatchObject({ code: 'PERMISSION_DENIED' }); }
  });

  it('does not leak validation input values in error details', async () => {
    const fetcher = vi.fn();
    try { await client(fetcher).read('/employees', { query: { page_size: KEY } }); expect.unreachable(); }
    catch (error) { expect(JSON.stringify(error)).not.toContain(KEY); expect(error).toMatchObject({ code: 'INVALID_ARGUMENTS' }); }
  });

  it('rejects invalid JSON and oversized responses with explicit safe errors', async () => {
    const invalid = vi.fn().mockResolvedValue(new Response(KEY, { headers: { 'content-type': 'application/json' } }));
    await expect(client(invalid).read('/employees')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const huge = vi.fn().mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '999999999' } }));
    await expect(client(huge).read('/employees')).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
});
