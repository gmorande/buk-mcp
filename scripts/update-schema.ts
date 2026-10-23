import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Ajv } from 'ajv';
import { buildCatalog, SCHEMA_SOURCE, type BukOperation, type SwaggerDocument } from '../src/catalog.js';

const schemaFile = new URL('../schema/buk-chile.json', import.meta.url);
const coverageFile = new URL('../docs/API_COVERAGE.md', import.meta.url);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function renderCoverage(document: SwaggerDocument, source: string): string {
  const operations = buildCatalog(document);
  const methodCounts = new Map<string, number>();
  for (const op of operations) methodCounts.set(op.method, (methodCounts.get(op.method) ?? 0) + 1);
  return `# Official Buk API coverage

Generated from the pinned [official Buk Chile Swagger contract](${SCHEMA_SOURCE}).
Run \`npm run schema:update -- --local\` after intentional local contract changes,
or \`npm run schema:update\` to fetch the current public contract and regenerate this file.
No API key is needed or sent by the update script.

- **${Object.keys(document.paths).length} paths / ${operations.length} operations:** ${[...methodCounts].sort().map(([method, count]) => `${count} ${method}`).join(', ')}.
- **Contract SHA-256:** \`${hash(source)}\`.
- **Schema country:** Chile. Other supported Buk tenant domains select the correct
  API URL prefix, but their country-specific request and response schemas have not
  been certified against this Chile snapshot.
- **Coverage means discoverable, schema-described and callable:** it does not mean
  every module is licensed, every token has access, or every mutation has been
  executed in a real tenant. Writes are disabled by default.

## Transport and validation

Every listed operation is reached through \`buk_read\` or opt-in \`buk_write\` after
\`buk_describe_operation\`. Stable IDs derive from the method and exact route.
Only declared routes, query keys, path keys and body/form envelopes are accepted.
The complete upstream description, including documented permissions, is exposed
with each operation. Permissions and the tenant's company scope remain enforced
by Buk; this connector never expands them.

The original Swagger file is retained without edits. Its nonstandard
\`decimal\`/\`float\` types become numbers, \`date\`/\`citext\` become strings,
property-level \`required:true\` moves to the parent, \`minimun\` becomes
\`minimum\`, missing object types are inferred from properties, and nullable
values become explicit JSON Schema alternatives. Every route placeholder is
required. Paginated responses receive the omitted \`page\` query parameter.
Each operation reports its applied normalizations. The missing upstream
\`CuentaContable\` response definition remains unspecified; no fields are invented.
Date formats are retained as documentation because Buk uses different date
conventions and some upstream format annotations are inconsistent. Values are
not coerced. Conditional business rules described only in prose remain Buk's
validation responsibility.

Document uploads accept \`form.file={filename,mimeType?,dataBase64}\` or the
official \`form.file_base64={filename,content}\`, exactly one of the two. Files
are limited to 10 MiB. Multipart boundaries are generated automatically; nested
form objects use Rails bracket field names. JSON bodies are sent as JSON.
Binary responses return \`{contentType,encoding:"base64",dataBase64}\`; text
responses return \`{contentType,text}\`. Document contents may contain personal
data and are returned only to the connected MCP caller.

## Pagination, errors and boundaries

JSON responses retain their Buk envelope. Pagination merges top-level lists,
including \`data\`, \`applicants\`, \`applications\` and \`participants\`;
the accounting structure export merges company-to-rows dictionaries. Buk's
\`pagination.count\` is not assumed to be a total record count. Completion uses
\`next\`, \`total_pages\` and, where supplied, \`current_page\`.
The aggregate envelope retains the **last page's pagination metadata**; this
metadata is not an aggregate count. Use \`meta.pages\` and \`meta.complete\`.

Only same-origin, same-endpoint next links with unchanged filters are followed.
Omitted filters are retained. Missing pagination metadata, unsafe links, later
page errors, a noninitial starting page, the default 50-page cap and unmergeable
response shapes yield \`meta.complete:false\` with a reason. A skipped page or
changing total-page count is also reported as incomplete. Never present totals
from such a response as complete. Successful pages remain available for diagnosis.
Responses have a 20 MiB per-page limit and a 50 MiB cumulative response limit.
A later page exceeding the cumulative limit is not merged; earlier pages remain
available with \`partialReason:"response_size_limit"\` and \`meta.complete:false\`.
\`meta.responseBytes\` reports accepted response bytes before JSON decoding.

The default timeout is 30 seconds per attempt. Only GET retries transient network
errors, timeouts, HTTP 408/429/500/502/503/504, up to two retries by default.
Short \`Retry-After\` values are honored; a server-requested wait above 10 seconds
returns the error instead of retrying prematurely. Mutations are never retried.
HTTPS tenant origins must be a single tenant label under buk.cl, buk.pe, buk.co,
buk.mx or buk.com.br. Redirects, arbitrary URLs, credential-bearing URLs,
different pagination paths and path injection are blocked. Upstream error bodies,
request headers and credentials are never included in connector errors or logs.

## All operations

| Operation ID | Method | Exact route | Official summary |
| --- | --- | --- | --- |
${operations.map((op: BukOperation) => `| \`${op.id}\` | ${op.method} | \`${cell(op.path)}\` | ${cell(op.summary)} |`).join('\n')}
`;
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  if ([...flags].some(flag => !['--check', '--local'].includes(flag))) throw new Error('Supported options: --check, --local.');
  const previous = await readFile(schemaFile, 'utf8');
  let next = previous;
  if (!flags.has('--local')) {
    const response = await fetch(SCHEMA_SOURCE, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`The public Buk contract returned HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw new Error('Public contract exceeds the 8 MiB limit.');
    next = await response.text();
    if (Buffer.byteLength(next) > 8 * 1024 * 1024) throw new Error('Public contract exceeds the 8 MiB limit.');
  }
  const document = JSON.parse(next) as SwaggerDocument;
  const catalog = buildCatalog(document);
  if (!catalog.length) throw new Error('The public contract contains no operations.');
  const ajv = new Ajv({ strict: false, validateFormats: false });
  for (const op of catalog) ajv.compile(op.inputSchema);
  const oldCatalog = buildCatalog(JSON.parse(previous) as SwaggerDocument);
  const removed = oldCatalog.filter(old => !catalog.some(op => op.id === old.id));
  if (removed.length) throw new Error(`The new contract removes ${removed.length} operations. Review the upstream change manually before replacing the pinned schema.`);
  const coverage = renderCoverage(document, next);
  if (flags.has('--check')) {
    const currentCoverage = await readFile(coverageFile, 'utf8').catch(() => '');
    if (previous !== next || currentCoverage !== coverage) { process.exitCode = 1; console.log('Contract or coverage documentation differs; review and run schema:update.'); return; }
    console.log(`Contract and coverage are current: ${catalog.length} operations, SHA-256 ${hash(next)}.`);
    return;
  }
  await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
  if (next !== previous) {
    const temporary = new URL('../schema/buk-chile.json.tmp', import.meta.url);
    await writeFile(temporary, next); await rename(temporary, schemaFile);
  }
  await writeFile(coverageFile, coverage);
  console.log(`Validated ${catalog.length} operations; wrote coverage. Contract SHA-256 ${hash(next)}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Schema update failed. The existing contract was retained unless validation and the atomic replacement had already succeeded. Check public network access and upstream schema compatibility.'); process.exitCode = 1; });
}
