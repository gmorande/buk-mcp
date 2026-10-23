import { describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { operations, sourceSchema, findByRoute, findOperation, describeOperation, normalizeSchema, buildCatalog } from '../src/catalog.js';

describe('official Buk operation catalog', () => {
  it('covers every official method/path exactly once with stable IDs', () => {
    const official = Object.entries(sourceSchema.paths).flatMap(([path, item]) =>
      Object.keys(item).filter(method => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method))
        .map(method => `${method.toUpperCase()} ${path}`));
    expect(operations).toHaveLength(206);
    expect(new Set(operations.map(op => op.id)).size).toBe(206);
    expect(operations.map(op => `${op.method} ${op.path}`).sort()).toEqual(official.sort());
    expect(operations.filter(op => !op.write)).toHaveLength(119);
    expect(findOperation('get_employees_id_jobs')).toBe(findByRoute('GET', '/employees/{id}/jobs'));
    expect(findByRoute('GET', '/employees/123/jobs')).toBeUndefined();
    expect(findOperation('https://outside.invalid')).toBeUndefined();
  });

  it('compiles every request and documented response schema without external references', () => {
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    for (const op of operations) {
      expect(() => ajv.compile(op.inputSchema), op.id).not.toThrow();
      for (const response of Object.values(op.responses)) {
        const schema = (response as { schema?: object }).schema;
        if (schema) expect(() => ajv.compile(schema), `${op.id} response`).not.toThrow();
      }
    }
  });

  it('requires every path placeholder and rejects undeclared parameter names', () => {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    for (const op of operations) {
      const validate = ajv.compile(op.inputSchema);
      if (op.path.includes('{')) expect(validate({ operationId: op.id }), op.id).toBe(false);
      expect(validate({ operationId: op.id, credentials: 'must-not-be-an-input' }), op.id).toBe(false);
    }
    const accounting = findByRoute('GET', '/accounting')!;
    const validate = ajv.compile(accounting.inputSchema);
    expect(validate({ operationId: accounting.id, query: { month: 1, year: 2025, page: 2 } })).toBe(true);
    expect(validate({ operationId: accounting.id, query: { auth_token: 'never' } })).toBe(false);
    expect(validate({ operationId: accounting.id, query: { month: '1' } })).toBe(false);
  });

  it('normalizes upstream schema extensions without inventing absent response fields', () => {
    const notes = new Set<string>();
    const normalized = normalizeSchema({ properties: {
      salary: { type: 'decimal', required: true, minimun: 0 },
      value: { type: 'citext', nullable: true },
      type: { type: 'string' },
    } }, notes);
    expect(normalized).toMatchObject({ type: 'object', required: ['salary'], properties: {
      salary: { type: 'number', minimum: 0 }, type: { type: 'string' },
      value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    } });
    const ledger = describeOperation('get_ledger_account');
    expect(ledger).toBeDefined();
    expect(JSON.stringify(ledger)).toContain('missing definition CuentaContable');
  });

  it('preserves official permissions, Chile provenance and request/response documentation', () => {
    const detail = describeOperation('get_employees_employee_id_payroll_detail')!;
    expect(detail.schemaCountry).toBe('chile');
    expect(detail.description).toContain('sensible');
    expect(detail.inputSchema).toBeTruthy();
    expect(detail.responses).toBeTruthy();
    expect(detail.source).toBe('https://demo.buk.cl/api/chile/es/api_docs');
  });

  it('rejects unsafe route and external-schema changes during contract updates', () => {
    expect(() => buildCatalog({ swagger: '2.0', paths: { 'https://evil.invalid': { get: {} } } })).toThrow('invalid route');
    expect(() => buildCatalog({ swagger: '2.0', paths: { '/x': { post: { parameters: [{ name: 'x', in: 'body', schema: { $ref: 'https://evil.invalid/schema' } }] } } } })).toThrow('external schema');
  });

  it('keeps a valid operation usable when the upstream omits a response schema', () => {
    const added = buildCatalog({ swagger: '2.0', paths: { '/x': { get: { summary: 'Undocumented response shape' } } } });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ id: 'get_x', responses: {}, expectsPagination: false });
  });
});
