import { readFileSync } from 'node:fs';

/** The upstream contract is retained verbatim; normalizations are applied in memory. */
export const SCHEMA_SOURCE = 'https://demo.buk.cl/api/chile/es/api_docs';
export type JsonSchema = Record<string, unknown>;
export interface SwaggerParameter extends Record<string, unknown> {
  name: string;
  in: string;
  required?: boolean;
  type?: string;
  schema?: JsonSchema;
  collectionFormat?: string;
}
interface SwaggerOperation extends Record<string, unknown> {
  parameters?: SwaggerParameter[];
  responses?: Record<string, { description?: string; schema?: JsonSchema }>;
}
export interface SwaggerDocument extends Record<string, unknown> {
  swagger: string;
  paths: Record<string, Record<string, unknown>>;
  definitions?: Record<string, JsonSchema>;
  consumes?: string[];
  produces?: string[];
}
export interface BukOperation {
  id: string;
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  write: boolean;
  consumes: string[];
  produces: string[];
  parameters: SwaggerParameter[];
  inputSchema: JsonSchema;
  responses: Record<string, unknown>;
  expectsPagination: boolean;
  normalizations: string[];
}

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const fileSchema: JsonSchema = {
  type: 'object',
  properties: {
    filename: { type: 'string', minLength: 1, maxLength: 255 },
    mimeType: { type: 'string', minLength: 1, maxLength: 127 },
    dataBase64: { type: 'string', description: 'File bytes encoded as standard base64, without a data URI prefix.' },
  },
  required: ['filename', 'dataBase64'],
  additionalProperties: false,
};
const SCALAR_KEYS = new Set([
  '$ref', '$comment', 'title', 'description', 'default', 'enum', 'const', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems',
  'minProperties', 'maxProperties', 'readOnly', 'writeOnly', 'examples',
]);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Convert Swagger 2's extensions and upstream typos to JSON Schema draft 7. */
export function normalizeSchema(source: unknown, notes: Set<string> = new Set()): JsonSchema {
  if (!isRecord(source)) return {};
  const result: JsonSchema = {};
  for (const [key, value] of Object.entries(source)) {
    if (SCALAR_KEYS.has(key)) {
      if (['description', 'title', '$ref', 'format', 'pattern'].includes(key) && typeof value !== 'string') {
        notes.add('Ignored malformed non-string schema metadata.');
        continue;
      }
      result[key] = value;
    }
  }
  let type = source.type;
  if (type === 'decimal' || type === 'float') {
    type = 'number'; notes.add('Converted nonstandard decimal/float types to number.');
  }
  if (type === 'date' || type === 'citext') {
    if (type === 'date') result.format = 'date';
    type = 'string'; notes.add('Converted nonstandard date/citext types to string.');
  }
  if (type === 'file') return structuredClone(fileSchema);
  if (typeof type === 'string' && ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)) result.type = type;
  if (Array.isArray(type)) result.type = type;
  const required = new Set(Array.isArray(source.required) ? source.required.filter((v): v is string => typeof v === 'string') : []);
  if (isRecord(source.properties)) {
    result.type ??= 'object';
    const properties: Record<string, JsonSchema> = {};
    for (const [name, value] of Object.entries(source.properties)) {
      properties[name] = normalizeSchema(value, notes);
      if (isRecord(value) && value.required === true) {
        required.add(name); notes.add('Moved property-level required:true to the parent required list.');
      }
    }
    result.properties = properties;
  }
  if (required.size) result.required = [...required];
  if (source.minimun !== undefined && result.minimum === undefined) {
    result.minimum = source.minimun; notes.add('Corrected minimun to minimum.');
  }
  if (source.items !== undefined) {
    result.items = Array.isArray(source.items) ? source.items.map(v => normalizeSchema(v, notes)) : normalizeSchema(source.items, notes);
  } else if (result.type === 'array') {
    result.items = {};
    notes.add('Preserved unconstrained array items where the upstream schema omits items.');
  }
  if (source.additionalProperties !== undefined) {
    result.additionalProperties = typeof source.additionalProperties === 'boolean'
      ? source.additionalProperties : normalizeSchema(source.additionalProperties, notes);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (Array.isArray(source[key])) result[key] = source[key].map(v => normalizeSchema(v, notes));
  }
  for (const key of ['not', 'if', 'then', 'else', 'contains'] as const) {
    if (isRecord(source[key])) result[key] = normalizeSchema(source[key], notes);
  }
  if (source.nullable === true || source['x-nullable'] === true) {
    notes.add('Converted nullable to a JSON Schema null alternative.');
    return { anyOf: [result, { type: 'null' }] };
  }
  return result;
}

function collectReferences(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) { for (const item of value) collectReferences(item, refs); return; }
  if (!isRecord(value)) return;
  if (typeof value.$ref === 'string') {
    if (!value.$ref.startsWith('#/definitions/')) throw new Error('The Buk contract contains an unsupported external schema reference.');
    refs.add(value.$ref.slice('#/definitions/'.length).replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  for (const [key, item] of Object.entries(value)) if (key !== '$ref') collectReferences(item, refs);
}

function attachDefinitions(schema: JsonSchema, definitions: Record<string, JsonSchema>, notes: Set<string>, responseOnly = false): JsonSchema {
  const names = new Set<string>();
  collectReferences(schema, names);
  const selected: Record<string, JsonSchema> = {};
  for (const name of names) {
    if (!Object.hasOwn(definitions, name)) {
      if (!responseOnly) throw new Error('The Buk contract contains an unresolved request schema reference.');
      selected[name] = { description: 'This response definition is referenced but absent from the official Buk contract; its fields are not inferred.' };
      notes.add(`The upstream response references missing definition ${name}; its response shape remains unspecified.`);
      continue;
    }
    selected[name] = normalizeSchema(definitions[name], notes);
    collectReferences(selected[name], names);
  }
  return names.size ? { ...schema, definitions: selected } : schema;
}

function responseUsesPagination(responses: SwaggerOperation['responses'], definitions: Record<string, JsonSchema>): boolean {
  const refs = new Set<string>();
  collectReferences(responses, refs);
  for (const name of refs) {
    if (name === 'Pagination') return true;
    if (definitions[name]) collectReferences(definitions[name], refs);
  }
  return (JSON.stringify(responses) ?? '').includes('"pagination"');
}

function parameterSchema(parameter: SwaggerParameter, notes: Set<string>): JsonSchema {
  const schema = normalizeSchema(parameter.schema ?? parameter, notes);
  // The upstream uses several date conventions and even labels period_type as a date.
  // Retain the format as documentation; Ajv runs with validateFormats:false.
  return schema;
}

export function buildCatalog(document: SwaggerDocument): BukOperation[] {
  if (document.swagger !== '2.0' || !isRecord(document.paths)) throw new Error('Expected the official Swagger 2 Buk contract.');
  const definitions = document.definitions ?? {};
  const result: BukOperation[] = [];
  const ids = new Set<string>();
  for (const [route, pathItem] of Object.entries(document.paths)) {
    if (!route.startsWith('/') || /[?#\\]/.test(route)) throw new Error('The Buk contract contains an invalid route.');
    for (const [method, value] of Object.entries(pathItem)) {
      if (!METHODS.has(method) || !isRecord(value)) continue;
      const raw = value as SwaggerOperation;
      const id = `${method}_${route.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase()}`;
      if (ids.has(id)) throw new Error('Generated operation identifiers collide.');
      ids.add(id);
      const notes = new Set<string>();
      const inherited = Array.isArray(pathItem.parameters) ? pathItem.parameters as SwaggerParameter[] : [];
      const parameterMap = new Map(inherited.map(p => [`${p.in}:${p.name}`, p]));
      for (const parameter of raw.parameters ?? []) parameterMap.set(`${parameter.in}:${parameter.name}`, parameter);
      const parameters = [...parameterMap.values()].map(p => structuredClone(p));
      const expectsPagination = method === 'get' && (parameters.some(p => p.in === 'query' && ['page', 'page_size'].includes(p.name)) || responseUsesPagination(raw.responses, definitions));
      if (expectsPagination && !parameters.some(p => p.in === 'query' && p.name === 'page')) {
        parameters.push({ name: 'page', in: 'query', type: 'integer', minimum: 1, description: 'Pagination cursor used by Buk next links (upstream omission normalized by this connector).' });
        notes.add('Added the page query parameter for a documented paginated response.');
      }
      const properties: Record<string, unknown> = {
        operationId: { type: 'string', const: id },
        paginate: { type: 'boolean', description: 'Follow safe same-endpoint pagination. GET only; inspect meta.complete.' },
      };
      const required = ['operationId'];
      for (const [location, envelope] of [['path', 'path'], ['query', 'query'], ['formData', 'form']] as const) {
        const fields: Record<string, JsonSchema> = {};
        const requiredFields: string[] = [];
        for (const parameter of parameters.filter(p => p.in === location)) {
          fields[parameter.name] = parameterSchema(parameter, notes);
          if (parameter.required || location === 'path') requiredFields.push(parameter.name);
          if (location === 'path' && !parameter.required) notes.add('Required every route placeholder even when required is omitted upstream.');
        }
        if (location === 'path') {
          for (const match of route.matchAll(/\{([^}]+)\}/g)) {
            if (!fields[match[1]]) { fields[match[1]] = { type: 'string' }; requiredFields.push(match[1]); notes.add('Added a missing route-placeholder parameter.'); }
          }
        }
        if (Object.keys(fields).length) {
          properties[envelope] = { type: 'object', properties: fields, additionalProperties: false, ...(requiredFields.length ? { required: requiredFields } : {}) };
          if (requiredFields.length) required.push(envelope);
        }
      }
      const body = parameters.find(p => p.in === 'body');
      if (body) {
        properties.body = parameterSchema(body, notes);
        if (body.required) required.push('body');
      }
      const inputSchema = attachDefinitions({ type: 'object', properties, required, additionalProperties: false }, definitions, notes);
      const responses: Record<string, unknown> = {};
      for (const [status, response] of Object.entries(raw.responses ?? {})) {
        responses[status] = { description: typeof response.description === 'string' ? response.description : '',
          ...(response.schema ? { schema: attachDefinitions(normalizeSchema(response.schema, notes), definitions, notes, true) } : {}) };
      }
      result.push({
        id, operationId: id, method: method.toUpperCase(), path: route,
        summary: typeof raw.summary === 'string' ? raw.summary : '',
        description: typeof raw.description === 'string' ? raw.description : '',
        tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        write: method !== 'get' && method !== 'head',
        consumes: Array.isArray(raw.consumes) ? raw.consumes as string[] : document.consumes ?? ['application/json'],
        produces: Array.isArray(raw.produces) ? raw.produces as string[] : document.produces ?? ['application/json'],
        parameters, inputSchema, responses, expectsPagination, normalizations: [...notes].sort(),
      });
    }
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export const sourceSchema = JSON.parse(readFileSync(new URL('../schema/buk-chile.json', import.meta.url), 'utf8')) as SwaggerDocument;
export const operations = buildCatalog(sourceSchema);
const byId = new Map(operations.map(op => [op.id, op]));
const byRoute = new Map(operations.map(op => [`${op.method} ${op.path}`, op]));

export function findOperation(id: string): BukOperation | undefined { return byId.get(id); }
export function findByRoute(method: string, path: string): BukOperation | undefined { return byRoute.get(`${method.toUpperCase()} ${path}`); }
export function describeOperation(operation: string | BukOperation): Record<string, unknown> | undefined {
  const op = typeof operation === 'string' ? findOperation(operation) : operation;
  if (!op) return undefined;
  return {
    operationId: op.id, method: op.method, path: op.path, summary: op.summary,
    description: op.description, tags: op.tags, write: op.write,
    consumes: op.consumes, produces: op.produces, inputSchema: op.inputSchema,
    responses: op.responses, normalizations: op.normalizations,
    schemaCountry: 'chile', source: SCHEMA_SOURCE,
    validationNotes: 'Only declared parameter names are accepted. Swagger extensions are normalized as listed. Date formats remain endpoint-specific and are documented rather than coerced. Country-specific fields outside Chile have not been verified.',
  };
}
