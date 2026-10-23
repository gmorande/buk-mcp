/** Authorized, read-only integration suite. Reports never contain HR data or credentials. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Decimal } from 'decimal.js';
import { findByRoute, operations } from '../src/catalog.js';

type Row = Record<string, any>;
type Check = { id: string; question: string; tool: string; status: string; checks: string[]; limitation_codes?: string[]; error?: string };
const externalConfig = process.env.BUK_LIVE_CONFIG ? JSON.parse(readFileSync(process.env.BUK_LIVE_CONFIG, 'utf8')) : {};
const tenantUrl = process.env.BUK_TENANT_URL ?? externalConfig.tenantUrl;
const apiKey = process.env.BUK_API_KEY ?? externalConfig.apiKey;
if (!tenantUrl || !apiKey) {
  process.stderr.write('Set BUK_TENANT_URL and BUK_API_KEY, or BUK_LIVE_CONFIG to a private JSON credential file outside the repo.\n');
  process.exit(2);
}
const now = new Date();
const month = process.env.BUK_LIVE_MONTH ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
assert.match(month, /^\d{4}-(0[1-9]|1[0-2])$/, 'BUK_LIVE_MONTH must use YYYY-MM.');
const [year, mm] = month.split('-').map(Number);
const endDate = new Date(Date.UTC(year, mm, 0)).toISOString().slice(0, 10);
const apiDate = `01-${String(mm).padStart(2, '0')}-${year}`;
const team = process.env.BUK_LIVE_TEAM ?? 'Tech';
const env: Record<string, string> = {};
for (const name of ['PATH', 'SYSTEMROOT', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY']) {
  if (process.env[name]) env[name] = process.env[name]!;
}
Object.assign(env, { BUK_TENANT_URL: tenantUrl, BUK_API_KEY: apiKey, BUK_COUNTRY: 'chile', BUK_ALLOW_WRITES: 'false', BUK_MAX_PAGES: '100' });
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/index.js'), 'stdio'], env, stderr: 'pipe' });
const client = new Client({ name: 'buk-mcp-live-readonly-verification', version: '1.0.0' });
const checks: Check[] = [];
const rows = (v: any): Row[] => Array.isArray(v) ? v : Array.isArray(v?.data) ? v.data : [];
const result = async (name: string, args: Row): Promise<Row> => {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  if (response.isError) {
    const part = (response.content as any[])?.find(value => value.type === 'text');
    let code = 'TOOL_ERROR';
    try { const parsed = JSON.parse(part?.text ?? '{}'); if (/^[A-Z_]+$/.test(parsed.error)) code = parsed.error; } catch { /* no raw errors */ }
    throw new Error(code);
  }
  const structured = response.structuredContent as Row | undefined;
  if (structured && 'result' in structured) return structured.result;
  return JSON.parse((response.content as any[]).find(part => part.type === 'text')?.text ?? '{}');
};
const read = (route: string, args: Row = {}) => result('buk_read', { operationId: findByRoute('GET', route)!.id, ...args });
const safeIssues = (value: Row) => [...new Set((value?.coverage?.issues ?? []).map((issue: Row) => String(issue.code)).filter((code: string) => /^[a-z_]+$/.test(code)))] as string[];
async function check(id: string, question: string, tool: string, names: string[], run: () => Promise<Row | void>) {
  try {
    const value = await run();
    const incomplete = value?.coverage?.complete === false || value?.meta?.complete === false;
    checks.push({ id, question, tool, status: incomplete ? 'partial' : 'passed', checks: names, ...(incomplete ? { limitation_codes: safeIssues(value ?? {}) } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Verification failed.';
    checks.push({ id, question, tool, status: 'failed', checks: names, error: message.length < 150 ? message : 'Verification assertion failed.' });
  }
  process.stdout.write(`${id}: ${checks.at(-1)!.status}\n`);
}

try {
  await client.connect(transport);
  const available = await client.listTools();
  assert(!available.tools.some(t => t.name === 'buk_write'), 'The live suite must never expose writes.');
  const sampleResponse = await read('/employees', { query: { status: 'activo', page_size: 25 }, paginate: false });
  const candidates = rows(sampleResponse.data).filter(employee => {
    const jobs = rows(employee.jobs);
    return jobs.some(job => job.currency_code === 'CLP' && Number(job.base_wage) > 0 && job.start_date <= endDate && (!job.end_date || job.end_date >= endDate));
  });
  let employee = process.env.BUK_LIVE_EMPLOYEE_ID ? candidates.find(e => String(e.id) === process.env.BUK_LIVE_EMPLOYEE_ID) : candidates.find(e => rows(e.jobs).length > 1) ?? candidates[0];
  if (!employee && process.env.BUK_LIVE_EMPLOYEE_ID) {
    const response = await read('/employees/{id}', { path: { id: process.env.BUK_LIVE_EMPLOYEE_ID } });
    employee = response.data?.data ?? response.data;
  }
  assert(employee?.id, 'No suitable employee found; set BUK_LIVE_EMPLOYEE_ID.');
  const employeeId = String(employee.id);
  const ordered = rows(employee.jobs).filter(job => job.currency_code === 'CLP' && Number(job.base_wage) > 0).sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
  const startMonth = process.env.BUK_LIVE_START_MONTH ?? ordered[0]?.start_date?.slice(0, 7) ?? `${year - 1}-${String(mm).padStart(2, '0')}`;
  let monthly: Row | undefined;
  let history: Row | undefined;

  await check('Q01', 'Busca a X y distingue sus fichas.', 'buk_search_employees', ['Employee identity resolved by ficha ID; no guessed match.'], async () => {
    const value = await result('buk_search_employees', { query: employee.full_name ?? String(employee.id), limit: 100 });
    assert(value.matches.some((r: Row) => r.employee_id === employeeId), 'The known ficha was not returned.'); return value;
  });
  await check('Q02', 'Muéstrame las áreas y subáreas de la organización.', 'buk_read', ['All pages returned; area hierarchy available.'], async () => {
    const value = await read('/organization/areas/', { query: { page_size: 100, status: 'both' } });
    assert(rows(value.data).length > 0, 'No areas returned.'); assert(rows(value.data).some(r => 'parent_area' in r), 'Area hierarchy missing.'); return value;
  });
  await check('Q03', '¿Cuánto costó el equipo Tech el último mes cerrado?', 'buk_team_payroll', ['Nonempty historical team; standard Buk employer cost; component sum reconciles.'], async () => {
    monthly = await result('buk_team_payroll', { month, team });
    assert(monthly.employee_breakdown?.length > 0, 'No team payroll records returned.');
    assert(Array.isArray(monthly.employer_cost?.values) && monthly.employer_cost.values.length > 0, 'Employer cost could not be computed.');
    for (const total of monthly.employer_cost.values) {
      const detail = monthly.employee_breakdown.filter((r: Row) => r.currency === total.currency);
      assert(detail.every((r: Row) => r.employer_cost !== null), 'Employer cost has missing components.');
      const sum = detail.reduce((sum: Decimal, r: Row) => sum.add(r.employer_cost), new Decimal(0));
      assert(sum.eq(total.amount), 'Employer cost differs from its employee breakdown.');
      const aggregate = monthly.totals_by_currency.find((r: Row) => r.currency === total.currency);
      assert(aggregate && new Decimal(aggregate.gross_pay).add(aggregate.employer_contributions).minus(aggregate.family_allowance).eq(total.amount), 'Gross plus employer contributions minus family allowance does not reconcile.');
    }
    return monthly;
  });
  await check('Q04', 'Separa haberes fijos, ocasionales y aportes del empleador de Tech.', 'buk_team_payroll', ['Earnings categories sum to gross; contributions exposed separately.'], async () => {
    assert(monthly, 'Monthly payroll prerequisite missing.');
    for (const total of monthly.totals_by_currency) {
      const classified = new Decimal(total.fixed_earnings).add(total.occasional_earnings).add(total.other_earnings);
      assert(classified.eq(total.gross_pay), 'Classified earnings differ from gross pay.');
      assert(new Decimal(total.employer_contributions).gte(0), 'Employer contributions are unavailable.');
    }
    return monthly;
  });
  await check('Q05', '¿Cómo cambió el costo y la dotación de Tech frente al mes anterior?', 'buk_team_payroll', ['Separate historical membership for each month; delta arithmetic.'], async () => {
    const value = await result('buk_team_payroll', { month, team, compare_previous: true });
    assert(value.previous_period?.employee_breakdown?.length > 0, 'Previous month has no team payroll.');
    assert(value.changes?.length > 0, 'No period comparison returned.');
    for (const change of value.changes) {
      const current = value.totals_by_currency.find((t: Row) => t.currency === change.currency);
      const prior = value.previous_period.totals_by_currency.find((t: Row) => t.currency === change.currency);
      assert(prior && new Decimal(current.gross_pay).minus(prior.gross_pay).eq(change.gross_change), 'Period delta does not reconcile.');
      const currentCost = value.employer_cost?.values?.find((r: Row) => r.currency === change.currency);
      const priorCost = value.previous_period.employer_cost?.values?.find((r: Row) => r.currency === change.currency);
      assert(currentCost && priorCost && new Decimal(currentCost.amount).minus(priorCost.amount).eq(change.employer_cost_change), 'Employer cost delta does not reconcile.');
    }
    if (value.previous_period.coverage?.complete === false) value.coverage.complete = false;
    return value;
  });
  await check('Q06', '¿Quiénes integraban Tech a una fecha y cuánto sumaban sus sueldos base?', 'buk_recurring_payroll', ['Dated active employees; base wages sum per currency.'], async () => {
    const value = await result('buk_recurring_payroll', { as_of: endDate, team });
    assert(value.employees?.length > 0, 'No recurring team wages returned.');
    for (const total of value.totals_by_currency) {
      const sum = value.employees.filter((r: Row) => r.currency === total.currency).reduce((sum: Decimal, r: Row) => sum.add(r.base_wage), new Decimal(0));
      assert(sum.eq(total.monthly_base_wages), 'Base wages do not reconcile.');
    }
    return value;
  });
  await check('Q07', 'Si subo 5% los sueldos base de Tech, ¿cuál es el incremento mensual?', 'buk_recurring_payroll', ['Read-only scenario; exact 5% increase per currency.'], async () => {
    const value = await result('buk_recurring_payroll', { as_of: endDate, team, increase_percent: 5 });
    assert(value.totals_by_currency?.length > 0, 'No base wages for scenario.');
    for (const total of value.totals_by_currency) assert(new Decimal(total.monthly_base_wages).mul('0.05').toFixed(2) === total.scenario_increment, 'Scenario increment is incorrect.');
    return value;
  });
  await check('Q08', 'Dame el historial salarial de X con fechas y aumentos.', 'buk_salary_history', ['Historical contractual wages and payroll returned for a unique ficha.'], async () => {
    history = await result('buk_salary_history', { employee_id: employeeId, start_month: startMonth, end_month: month });
    assert(history.contractual_base_wage_history?.length > 0, 'No contractual wage history.');
    assert(history.actual_payroll_history?.length > 0, 'No historical payroll.');
    const wages = history.contractual_base_wage_history;
    for (let index = 1; index < wages.length; index++) {
      const previous = wages[index - 1], current = wages[index];
      if (current.currency === previous.currency && current.change_amount !== null) {
        assert(new Decimal(current.base_wage).minus(previous.base_wage).toFixed(2) === current.change_amount, 'A salary increase amount does not reconcile.');
        if (Number(previous.base_wage) > 0) assert(new Decimal(current.base_wage).div(previous.base_wage).minus(1).mul(100).toFixed(6) === current.change_percent, 'A salary increase percentage does not reconcile.');
      }
    }
    return history;
  });
  await check('Q09', 'Compara la evolución del sueldo base de X con el IPC y su poder adquisitivo.', 'buk_salary_history', ['Official INE indices; real change uses wage ratio divided by CPI ratio.'], async () => {
    const value = await result('buk_salary_history', { employee_id: employeeId, start_month: startMonth, end_month: month, compare_cpi: true });
    const cpi = value.cpi_comparison;
    assert(cpi && cpi.real_change_percent !== undefined, 'CPI comparison is unavailable for this employee/window.');
    const real = new Decimal(cpi.final_salary).div(cpi.initial_salary).div(new Decimal(cpi.final_cpi_index).div(cpi.initial_cpi_index)).minus(1).mul(100).toFixed(6);
    assert(real === cpi.real_change_percent, 'Real salary calculation does not reconcile.');
    assert(String(cpi.source?.url ?? cpi.source_url ?? '').includes('ine.gob.cl'), 'Official INE provenance missing.');
    return value;
  });
  await check('Q10', '¿Cuáles fueron el bruto, descuentos y líquido de X en un mes?', 'buk_read', ['Requested ficha and period; gross less deductions equals net.'], async () => {
    const value = await read('/employees/{employee_id}/payroll_detail', { path: { employee_id: employeeId }, query: { start: apiDate, end: endDate.split('-').reverse().join('-'), page_size: 100 } });
    const settlements = rows(value.data);
    assert(settlements.length > 0, 'No employee payroll for requested month.');
    for (const settlement of settlements) {
      assert(String(settlement.employee_id) === employeeId, 'Payroll belongs to a different ficha.');
      assert(Number(settlement.month) === mm && Number(settlement.year) === year, 'Payroll belongs to a different month.');
      assert(new Decimal(settlement.income_gross).minus(settlement.total_legal_discounts).minus(settlement.total_other_discounts).eq(settlement.income_net), 'Gross less deductions does not equal net.');
    }
    return value;
  });
  await check('Q11', '¿Cuántos días de vacaciones tiene X a una fecha determinada?', 'buk_read', ['Explicit calculation date and future-vacation discount choice.'], async () => {
    const value = await read('/employees/{id}/vacations_available', { path: { id: employeeId }, query: { date: endDate.split('-').reverse().join('-'), discount: true } });
    assert(value.data !== null && typeof value.data === 'object', 'Vacation response unavailable.'); return value;
  });
  await check('Q12', '¿Qué empresas o razones sociales puede consultar esta conexión?', 'buk_read', ['Company endpoint succeeds and all pages are consumed.'], async () => {
    const value = await read('/companies', { query: { page_size: 100 } });
    assert(rows(value.data).length > 0, 'No accessible companies returned.'); return value;
  });
} catch (error) {
  process.stderr.write('Live verification could not complete its prerequisites. Check tenant, key permissions, employee selection and network access.\n');
  checks.push({ id: 'SETUP', question: 'Read-only live prerequisites', tool: 'MCP initialize + Buk', status: 'failed', checks: [], error: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SETUP_FAILED' });
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}

const report = {
  generated_at: new Date().toISOString(),
  verification: 'Real Buk read-only requests through an MCP stdio client. HR values and credentials excluded.',
  scope: { schema_country: 'chile', schema_operations: operations.length, schema_reads: operations.filter(op => !op.write).length, schema_writes: operations.filter(op => op.write).length, writes_executed: 0, customers_tested: 1 },
  summary: { passed: checks.filter(c => c.status === 'passed').length, partial: checks.filter(c => c.status === 'partial').length, failed: checks.filter(c => c.status === 'failed').length },
  checks,
  limitations: ['This suite verifies the listed question workflows, not every endpoint against live production data.', 'No production mutation is performed.', 'MCP-level execution is tested; natural-language model behavior is not a deterministic test.', 'Passing with one tenant does not guarantee another tenant has the same licensed modules or key permissions.'],
};
const reportFile = process.env.BUK_LIVE_REPORT;
if (reportFile) { mkdirSync(dirname(reportFile), { recursive: true }); writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n'); }
process.stdout.write(JSON.stringify({ summary: report.summary, report_written: Boolean(reportFile), writes_executed: 0 }) + '\n');
if (report.summary.failed > 0 || report.summary.partial > 0) process.exitCode = 1;
