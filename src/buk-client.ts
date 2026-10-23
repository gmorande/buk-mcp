import { Ajv, type ValidateFunction } from 'ajv';
import { findOperation, findByRoute, type BukOperation, type SwaggerParameter } from './catalog.js';

export interface BukConfig {
  tenantUrl: string;
  apiKey: string;
  country?: string;
  allowWrites?: boolean;
  timeoutMs?: number;
  maxPages?: number;
  retries?: number;
}
export interface ApiResult {
  data: unknown;
  meta: {
    operationId: string;
    method: string;
    path: string;
    pages: number;
    complete: boolean;
    [key: string]: unknown;
  };
}
export interface ExecuteInput {
  operationId: string;
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  form?: Record<string, unknown>;
  paginate?: boolean;
}
export class BukApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: unknown;
  constructor(code: string, message: string, status?: number, details?: unknown) {
    super(message); this.name = 'BukApiError'; this.code = code; this.status = status; this.details = details;
  }
}

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_RESPONSE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const COUNTRY_BY_SUFFIX: Record<string, string> = { cl: 'chile', pe: 'peru', co: 'colombia', mx: 'mexico', 'com.br': 'brasil' };
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false, coerceTypes: false });
const validators = new Map<string, ValidateFunction>();
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const safeInteger = (value: unknown): number | undefined => {
  if (typeof value === 'string' && !/^\d+$/.test(value)) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const n = Number(value); return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};

/** Strict tenant origins keep credentials away from arbitrary URLs and redirect targets. */
export function validateTenantUrl(value: string): { tenantUrl: string; country: string } {
  if (typeof value !== 'string') throw new BukApiError('INVALID_CONFIG', 'A Buk tenant HTTPS origin is required.');
  const match = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.buk\.(cl|pe|co|mx|com\.br)\/?$/i.exec(value);
  if (!match) throw new BukApiError('INVALID_CONFIG', 'tenantUrl must be one tenant name under buk.cl, buk.pe, buk.co, buk.mx or buk.com.br, using HTTPS without credentials, ports, paths or query strings.');
  return { tenantUrl: value.toLowerCase().replace(/\/$/, ''), country: COUNTRY_BY_SUFFIX[match[2].toLowerCase()] };
}

function boundedConfig(value: number | undefined, defaultValue: number, min: number, max: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new BukApiError('INVALID_CONFIG', 'A numeric client setting is outside its allowed range.');
  return value;
}

function validateInput(op: BukOperation, input: ExecuteInput): void {
  let validate = validators.get(op.id);
  if (!validate) { validate = ajv.compile(op.inputSchema); validators.set(op.id, validate); }
  // Undefined optional values are not JSON properties. Do not mutate caller data.
  const clean = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  if (!validate(clean)) throw new BukApiError('INVALID_ARGUMENTS', 'Arguments do not match the documented Buk operation.', undefined,
    validate.errors?.slice(0, 20).map(error => ({ path: error.instancePath.slice(0, 200), rule: error.keyword, message: error.message })));
}

function resolvePath(op: BukOperation, params: Record<string, unknown> = {}): string {
  return op.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (typeof value !== 'string' && typeof value !== 'number') throw new BukApiError('INVALID_ARGUMENTS', 'Every route placeholder requires a scalar value.');
    const string = String(value);
    if (!string || string === '.' || string === '..' || /[\/\\?#%\u0000-\u001f\u007f]/.test(string)) {
      throw new BukApiError('INVALID_ARGUMENTS', 'Path parameters cannot contain URL delimiters, dot segments, escapes or control characters.');
    }
    return encodeURIComponent(string);
  });
}

function appendNested(target: URLSearchParams | FormData, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) appendNested(target, `${key}[]`, item);
  } else if (isRecord(value)) {
    for (const [name, item] of Object.entries(value)) appendNested(target, `${key}[${name}]`, item);
  } else if (value !== undefined && value !== null) target.append(key, String(value));
}

function appendQuery(target: URLSearchParams, parameter: SwaggerParameter, value: unknown): void {
  if (Array.isArray(value)) {
    if (value.some(isRecord)) { appendNested(target, parameter.name, value); return; }
    if (value.some(item => item !== null && !['string', 'number', 'boolean'].includes(typeof item))) {
      throw new BukApiError('INVALID_ARGUMENTS', 'Query arrays must contain scalar values or documented objects.');
    }
    if (parameter.collectionFormat === 'multi' || parameter.name.endsWith('[]')) {
      for (const item of value) if (item !== null) target.append(parameter.name, String(item));
    } else {
      const delimiter = ({ csv: ',', ssv: ' ', tsv: '\t', pipes: '|' } as Record<string, string>)[parameter.collectionFormat ?? 'csv'];
      if (!delimiter) throw new BukApiError('INVALID_ARGUMENTS', 'Unsupported query collection format.');
      target.append(parameter.name, value.join(delimiter));
    }
  } else if (isRecord(value)) appendNested(target, parameter.name, value);
  else if (value !== undefined && value !== null) target.append(parameter.name, String(value));
}

function decodeFile(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new BukApiError('INVALID_ARGUMENTS', 'File content must be standard base64 and at most 10 MiB.');
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function validateFilename(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 255 || /[\/\\\u0000-\u001f\u007f]/.test(value) || value === '.' || value === '..') {
    throw new BukApiError('INVALID_ARGUMENTS', 'A file requires a plain filename without paths or control characters.');
  }
}

function createForm(op: BukOperation, fields: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const parameter of op.parameters.filter(p => p.in === 'formData')) {
    const value = fields[parameter.name];
    if (value === undefined) continue;
    if (parameter.type === 'file') {
      if (!isRecord(value)) throw new BukApiError('INVALID_ARGUMENTS', 'Files require filename, dataBase64 and an optional mimeType.');
      validateFilename(value.filename);
      const bytes = decodeFile(value.dataBase64);
      const mimeType = value.mimeType ?? 'application/octet-stream';
      if (typeof mimeType !== 'string' || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mimeType)) throw new BukApiError('INVALID_ARGUMENTS', 'The file mimeType is invalid.');
      form.append(parameter.name, new Blob([bytes as BlobPart], { type: mimeType }), value.filename);
    } else {
      if (parameter.name === 'file_base64') {
        if (!isRecord(value)) throw new BukApiError('INVALID_ARGUMENTS', 'file_base64 requires content and filename.');
        validateFilename(value.filename); decodeFile(value.content);
      }
      appendNested(form, parameter.name, value);
    }
  }
  if (op.path === '/employees/{id}/docs' && op.method === 'POST' && (!fields.file && !fields.file_base64 || fields.file && fields.file_base64)) {
    throw new BukApiError('INVALID_ARGUMENTS', 'Provide exactly one document field: file or file_base64.');
  }
  return form;
}

async function readLimited(response: Response): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new BukApiError('RESPONSE_TOO_LARGE', 'Buk response exceeds the 20 MiB per-page limit. Use smaller pages or narrower filters.');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new BukApiError('RESPONSE_TOO_LARGE', 'Buk response exceeds the 20 MiB per-page limit. Use smaller pages or narrower filters.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function responseError(status: number): BukApiError {
  if (status === 401) return new BukApiError('AUTHENTICATION_FAILED', 'Buk rejected the API credential.', status);
  if (status === 403) return new BukApiError('PERMISSION_DENIED', 'Buk denied access. Check API key permissions, sensitive-data access, company scope and contracted modules.', status);
  if (status === 404) return new BukApiError('NOT_FOUND', 'Buk could not find the requested resource or endpoint in this tenant.', status);
  if (status === 429) return new BukApiError('RATE_LIMITED', 'Buk rate-limited the request. Try again later or use narrower queries.', status);
  if (status >= 500) return new BukApiError('UPSTREAM_UNAVAILABLE', 'Buk could not complete the request.', status);
  return new BukApiError('BUK_REQUEST_REJECTED', 'Buk rejected the request. Consult the operation schema, permissions and tenant configuration.', status);
}

function retryDelay(response: Response | undefined, attempt: number): number | undefined {
  const value = response?.headers.get('retry-after');
  if (value) {
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    // Do not retry sooner than Buk requests. Long backoffs return control to the caller.
    if (Number.isFinite(delay)) return delay > 10_000 ? undefined : Math.max(delay, 0);
  }
  return Math.min(250 * 2 ** attempt, 2000);
}

interface PageInfo { next?: URL; complete: boolean; reason?: string; totalPages?: number; }
function getPageInfo(data: unknown, url: URL, original: URL, op: BukOperation): PageInfo {
  if (!isRecord(data) || !isRecord(data.pagination)) {
    return op.expectsPagination ? { complete: false, reason: 'pagination_metadata_missing' } : { complete: true };
  }
  const pagination = data.pagination;
  const totalPages = safeInteger(pagination.total_pages);
  const requestedPage = safeInteger(url.searchParams.get('page')) ?? 1;
  const reportedPage = safeInteger(pagination.current_page);
  if (pagination.total_pages !== undefined && pagination.total_pages !== null && totalPages === undefined ||
      pagination.current_page !== undefined && pagination.current_page !== null && (!reportedPage || reportedPage !== requestedPage)) {
    return { complete: false, reason: 'invalid_pagination_metadata', totalPages };
  }
  const currentPage = reportedPage ?? requestedPage;
  const next = pagination.next;
  if (typeof next === 'string' && next.trim()) {
    let candidate: URL;
    try { candidate = new URL(next, url); }
    catch { return { complete: false, reason: 'invalid_pagination_link', totalPages }; }
    // No redirects, different hosts, endpoint changes, credential-bearing URLs or hash fragments.
    if (candidate.origin !== original.origin || candidate.pathname !== original.pathname || candidate.username || candidate.password || candidate.hash) {
      return { complete: false, reason: 'unsafe_pagination_link', totalPages };
    }
    const nextPage = safeInteger(candidate.searchParams.get('page'));
    if (candidate.searchParams.getAll('page').length !== 1 || !nextPage || nextPage <= currentPage) return { complete: false, reason: 'non_advancing_pagination', totalPages };
    if (nextPage !== currentPage + 1) return { complete: false, reason: 'non_sequential_pagination', totalPages };
    for (const key of new Set(candidate.searchParams.keys())) {
      if (key === 'page') continue;
      const actual = candidate.searchParams.getAll(key), expected = original.searchParams.getAll(key);
      if (key === 'page_size' && !expected.length && op.parameters.some(p => p.in === 'query' && p.name === 'page_size')) {
        const prior = url.searchParams.getAll(key);
        if (actual.length !== 1 || !safeInteger(actual[0]) || prior.length && JSON.stringify(actual) !== JSON.stringify(prior)) {
          return { complete: false, reason: 'pagination_filters_changed', totalPages };
        }
        continue;
      }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) return { complete: false, reason: 'pagination_filters_changed', totalPages };
    }
    // Some Buk next links omit filters; retain the exact original filter values.
    for (const key of new Set(original.searchParams.keys())) {
      if (key !== 'page' && !candidate.searchParams.has(key)) for (const value of original.searchParams.getAll(key)) candidate.searchParams.append(key, value);
    }
    if (!candidate.searchParams.has('page_size') && url.searchParams.has('page_size')) candidate.searchParams.set('page_size', url.searchParams.get('page_size')!);
    return { next: candidate, complete: false, totalPages };
  }
  if (next !== undefined && next !== null && next !== '') return { complete: false, reason: 'invalid_pagination_link', totalPages };
  if (totalPages !== undefined && currentPage < totalPages) {
    const candidate = new URL(url); candidate.searchParams.set('page', String(currentPage + 1));
    return { next: candidate, complete: false, totalPages };
  }
  if (totalPages !== undefined || Object.hasOwn(pagination, 'next')) return { complete: true, totalPages };
  return { complete: false, reason: 'pagination_metadata_incomplete' };
}

function mergePages(first: unknown, next: unknown, op: BukOperation): unknown | undefined {
  if (Array.isArray(first) && Array.isArray(next)) return [...first, ...next];
  if (isRecord(first) && isRecord(next)) {
    const keys = Object.keys(first).filter(key => Array.isArray(first[key]));
    const nextKeys = Object.keys(next).filter(key => Array.isArray(next[key]));
    if (keys.length && keys.length === nextKeys.length && keys.every(key => nextKeys.includes(key))) {
      const result: Record<string, unknown> = { ...first, pagination: next.pagination };
      for (const key of keys) result[key] = [...first[key] as unknown[], ...next[key] as unknown[]];
      return result;
    }
    // This official export uses a company-ID -> rows dictionary, rather than a flat list.
    if (op.path === '/accounting_structure/export' && isRecord(first.data) && isRecord(next.data) &&
        [...Object.values(first.data), ...Object.values(next.data)].every(Array.isArray)) {
      const data = { ...first.data };
      for (const [key, value] of Object.entries(next.data)) data[key] = [...(data[key] as unknown[] ?? []), ...value as unknown[]];
      return { ...first, data, pagination: next.pagination };
    }
  }
  return undefined;
}

export class BukClient {
  readonly tenantUrl: string;
  readonly country: string;
  readonly allowWrites: boolean;
  #apiKey: string;
  #fetch: typeof fetch;
  #timeoutMs: number;
  #maxPages: number;
  #retries: number;

  constructor(config: BukConfig, fetcher: typeof fetch = globalThis.fetch) {
    const origin = validateTenantUrl(config.tenantUrl);
    if (typeof config.apiKey !== 'string' || !config.apiKey.trim() || config.apiKey.length > 4096 || /[\u0000-\u0020\u007f]/.test(config.apiKey)) {
      throw new BukApiError('INVALID_CONFIG', 'A nonempty Buk API key without whitespace or control characters is required.');
    }
    this.tenantUrl = origin.tenantUrl;
    this.country = config.country ?? origin.country;
    if (!Object.values(COUNTRY_BY_SUFFIX).includes(this.country)) throw new BukApiError('INVALID_CONFIG', 'Unsupported Buk country prefix.');
    this.allowWrites = config.allowWrites === true;
    this.#apiKey = config.apiKey;
    this.#fetch = fetcher;
    this.#timeoutMs = boundedConfig(config.timeoutMs, 30_000, 1, 120_000);
    this.#maxPages = boundedConfig(config.maxPages, 50, 1, 1000);
    this.#retries = boundedConfig(config.retries, 2, 0, 5);
  }

  async read(route: string, args: { path?: Record<string, unknown>; query?: Record<string, unknown>; paginate?: boolean } = {}): Promise<ApiResult> {
    const op = findByRoute('GET', route);
    if (!op) throw new BukApiError('UNKNOWN_OPERATION', 'Use an exact GET route template from the Buk operation catalog.');
    return this.execute({ operationId: op.id, ...args });
  }

  async execute(input: ExecuteInput): Promise<ApiResult> {
    const op = findOperation(input.operationId);
    if (!op) throw new BukApiError('UNKNOWN_OPERATION', 'Unknown Buk operation. Discover an operation using the catalog first.');
    if (op.write && !this.allowWrites) throw new BukApiError('WRITES_DISABLED', 'Buk writes are disabled. The server administrator must explicitly enable them.');
    validateInput(op, input);
    if (input.paginate && op.method !== 'GET') throw new BukApiError('INVALID_ARGUMENTS', 'Only GET operations support pagination.');
    if (input.query?.page !== undefined && !safeInteger(input.query.page)) throw new BukApiError('INVALID_ARGUMENTS', 'Pagination page must be a positive integer.');
    const route = resolvePath(op, input.path);
    const original = new URL(`${this.tenantUrl}/api/v1/${this.country}${route}`);
    for (const parameter of op.parameters.filter(p => p.in === 'query')) appendQuery(original.searchParams, parameter, input.query?.[parameter.name]);
    const headers: Record<string, string> = { auth_token: this.#apiKey, accept: op.produces.join(', ') };
    let body: BodyInit | undefined;
    if (op.consumes.includes('multipart/form-data')) body = createForm(op, input.form ?? {});
    else if (input.body !== undefined) {
      headers['content-type'] = 'application/json';
      try { body = JSON.stringify(input.body); }
      catch { throw new BukApiError('INVALID_ARGUMENTS', 'The JSON body could not be serialized.'); }
    }
    const request: RequestInit = { method: op.method, headers, body, redirect: 'manual' };
    let url = original, data: unknown, pages = 0, complete = false, partialReason: string | undefined;
    let totalPages: number | undefined, pageError: { code: string; status?: number } | undefined, responseBytes = 0;
    const seen = new Set<string>();
    do {
      if (seen.has(url.href)) { partialReason = 'repeated_pagination_link'; break; }
      seen.add(url.href);
      let page: unknown;
      try {
        const fetched = await this.#request(url, request, op.method === 'GET');
        if (responseBytes + fetched.bytes > MAX_TOTAL_RESPONSE_BYTES) { partialReason = 'response_size_limit'; break; }
        responseBytes += fetched.bytes;
        page = fetched.data;
      }
      catch (error) {
        if (pages === 0) throw error;
        partialReason = 'page_fetch_failed';
        pageError = error instanceof BukApiError ? { code: error.code, status: error.status } : { code: 'REQUEST_FAILED' };
        break;
      }
      if (pages === 0) data = page;
      else {
        const combined = mergePages(data, page, op);
        if (combined === undefined) { partialReason = 'unmergeable_pagination_response'; break; }
        data = combined;
      }
      pages++;
      if (op.method !== 'GET') { complete = true; break; }
      const info = getPageInfo(page, url, original, op);
      if (totalPages !== undefined && info.totalPages !== undefined && totalPages !== info.totalPages) {
        partialReason = 'pagination_total_changed'; break;
      }
      totalPages = info.totalPages ?? totalPages;
      complete = info.complete;
      if (complete) break;
      if (info.reason) { partialReason = info.reason; break; }
      if (!input.paginate) { partialReason = 'pagination_not_requested'; break; }
      if (pages >= this.#maxPages) { partialReason = 'max_pages'; break; }
      if (!info.next) { partialReason = 'pagination_metadata_incomplete'; break; }
      url = info.next;
    } while (true);
    const startPage = safeInteger(original.searchParams.get('page')) ?? 1;
    if (complete && startPage > 1) { complete = false; partialReason = 'starting_page_after_first'; }
    return { data, meta: {
      operationId: op.id, method: op.method, path: route, pages, complete, responseBytes,
      ...(partialReason ? { partialReason } : {}), ...(totalPages !== undefined ? { totalPages } : {}),
      ...(pageError ? { pageError } : {}), schemaCountry: 'chile', country: this.country,
    } };
  }

  async #request(url: URL, request: RequestInit, retryable: boolean): Promise<{ data: unknown; bytes: number }> {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController(); let response: Response | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new BukApiError('TIMEOUT', 'The Buk request timed out.')); }, this.#timeoutMs);
      });
      try {
        const run = async () => {
          response = await this.#fetch(url.href, { ...request, signal: controller.signal });
          if (response.redirected || response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            throw new BukApiError('REDIRECT_BLOCKED', 'Buk returned a redirect. Credentials are never forwarded to redirected destinations.', response.status);
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw responseError(response.status);
          }
          const bytes = await readLimited(response);
          if (!bytes.length) return { data: null, bytes: 0 };
          const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? 'application/octet-stream';
          if (contentType === 'application/json' || contentType.endsWith('+json')) {
            try { return { data: JSON.parse(new TextDecoder().decode(bytes)) as unknown, bytes: bytes.length }; }
            catch { throw new BukApiError('INVALID_RESPONSE', 'Buk returned invalid JSON.'); }
          }
          if (contentType.startsWith('text/')) return { data: { contentType, text: new TextDecoder().decode(bytes) }, bytes: bytes.length };
          return { data: { contentType, encoding: 'base64', dataBase64: Buffer.from(bytes).toString('base64') }, bytes: bytes.length };
        };
        return await Promise.race([run(), timeout]);
      } catch (error) {
        const safe = error instanceof BukApiError ? error : new BukApiError('NETWORK_ERROR', 'The request to Buk failed before a valid response was received.');
        const transient = ['NETWORK_ERROR', 'TIMEOUT', 'RATE_LIMITED'].includes(safe.code) || [408, 500, 502, 503, 504].includes(safe.status ?? 0);
        if (!retryable || !transient || attempt >= this.#retries) throw safe;
        const delay = retryDelay(response, attempt);
        if (delay === undefined) throw safe;
        if (timer) clearTimeout(timer);
        await pause(delay);
      } finally { if (timer) clearTimeout(timer); }
    }
  }
}
