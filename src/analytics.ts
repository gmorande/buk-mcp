import { Decimal } from 'decimal.js';
import type { BukClient } from './buk-client.js';
import { compareWagesToCpi, loadCpiSeries, validateMonth } from './cpi.js';

type Row = Record<string, unknown>;
type Args = Record<string, unknown>;
type Reader = Pick<BukClient, 'read'>;
type Issue = { code: string; employee_id?: string; detail: string };
export interface AnalysisTool {
  name: string; description: string; inputSchema: Record<string, unknown>;
  handler: (client: Reader, args: Args) => Promise<unknown>;
}

const MONEY = Decimal.clone({ precision: 32, rounding: Decimal.ROUND_HALF_UP });
const row = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown) => value === null || value === undefined ? '' : String(value);
const normalized = (value: unknown) => text(value).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
const unique = <T>(items: T[]) => [...new Set(items)];
const monthPattern = '^\\d{4}-(0[1-9]|1[0-2])$';
const numericId = (value: unknown): string => {
  if (!/^\d+$/.test(text(value))) throw new Error('employee_id must be the numeric Buk ficha ID, not a RUT or a name.');
  return text(value);
};

export function unwrapRows(value: unknown): Row[] {
  if (Array.isArray(value)) return value.map(row);
  const valueRow = row(value);
  if (Array.isArray(valueRow.data)) return valueRow.data.map(row);
  return [];
}

function amount(value: unknown): Decimal | undefined {
  if (value === undefined || value === null || value === '' || typeof value === 'boolean') return undefined;
  try { const valueDecimal = new MONEY(text(value)); return valueDecimal.isFinite() ? valueDecimal : undefined; } catch { return undefined; }
}

function pct(now: Decimal, before: Decimal): string | null {
  return before.isZero() ? null : now.div(before).minus(1).mul(100).toFixed(6);
}

export function monthBounds(month: string) {
  validateMonth(month);
  const [year, mm] = month.split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${lastDay}`, year, month: mm, apiDate: `01-${String(mm).padStart(2, '0')}-${year}` };
}

function previousMonth(month: string): string {
  const { year, month: mm } = monthBounds(month);
  const date = new Date(Date.UTC(year, mm - 2, 1));
  return date.toISOString().slice(0, 7);
}

function monthsBetween(start: string, end: string): string[] {
  const result: string[] = [];
  let current = start;
  while (current <= end) {
    if (result.length >= 600) throw new Error('Salary history supports at most 600 months per request.');
    result.push(current);
    const bounds = monthBounds(current);
    current = new Date(Date.UTC(bounds.year, bounds.month, 1)).toISOString().slice(0, 7);
  }
  return result;
}

function dateOnly(value: unknown): string | undefined {
  const candidate = text(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return undefined;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate ? candidate : undefined;
}

function employeeName(employee: Row) {
  return text(employee.full_name) || [employee.first_name, employee.surname, employee.second_surname].filter(Boolean).join(' ');
}

function jobCurrency(job: Row): string | undefined {
  const currency = text(job.currency_code).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : undefined;
}

function issue(issues: Issue[], code: string, detail: string, employeeId?: string) {
  issues.push({ code, detail, ...(employeeId ? { employee_id: employeeId } : {}) });
}

async function readList(client: Reader, route: string, args: { path?: Args; query?: Args } = {}, issues?: Issue[]): Promise<Row[]> {
  const response = await client.read(route, { ...args, paginate: true });
  if (!response.meta.complete && issues) issue(issues, 'incomplete_pagination', `${route}: ${text(response.meta.partialReason) || 'Not all pages were returned.'}`);
  return unwrapRows(response.data);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await fn(items[index]!); }
  }));
  return results;
}

function employeeSummary(employee: Row) {
  const currentJob = row(employee.current_job);
  return {
    employee_id: text(employee.id), person_id: employee.person_id ?? null, name: employeeName(employee),
    email: employee.email ?? null, status: employee.status ?? null, code_sheet: employee.code_sheet ?? null,
    current_area_id: currentJob.area_id ?? null, company_id: currentJob.company_id ?? null,
  };
}

export async function searchEmployees(client: Reader, args: Args) {
  const issues: Issue[] = [];
  const query = normalized(args.query);
  const apiQuery: Args = { page_size: 100 };
  if (args.status) apiQuery.status = args.status;
  const employees = await readList(client, '/employees', { query: apiQuery }, issues);
  const matching = employees.filter(employee => !query || [employeeName(employee), employee.email, employee.id, employee.rut, employee.code_sheet].some(value => normalized(value).includes(query)));
  const limit = Math.max(1, Math.min(Number(args.limit ?? 25), 100));
  return {
    matches: matching.slice(0, limit).map(employeeSummary), total_matches: matching.length,
    needs_disambiguation: Boolean(query) && matching.length > 1,
    coverage: { complete: issues.length === 0, returned: Math.min(limit, matching.length), omitted_by_limit: Math.max(0, matching.length - limit), issues },
    guidance: 'Use employee_id (the ficha ID) for payroll/history. Multiple fichas can belong to the same person; do not merge their payroll records by name.',
    source: 'GET /employees',
  };
}

/** Select the latest effective job intersecting a period, preserving ambiguity signals. */
export function selectPeriodJob(jobs: Row[], start: string, end: string) {
  const candidates = jobs.filter(job => {
    const from = dateOnly(job.start_date);
    const to = dateOnly(job.end_date) ?? '9999-12-31';
    return Boolean(from && from <= end && to >= start);
  }).sort((a, b) => text(b.start_date).localeCompare(text(a.start_date)));
  const job = candidates[0];
  const relevantAreas = unique(candidates.map(value => `${text(value.company_id)}:${text(value.area_id)}`));
  const overlappingAtEnd = candidates.filter(value => (dateOnly(value.end_date) ?? '9999-12-31') >= end);
  return { job, candidates, team_changed: relevantAreas.length > 1, overlapping_jobs: overlappingAtEnd.length > 1 };
}

async function getJobs(client: Reader, employeeId: string, issues: Issue[], employee?: Row, start?: string, end?: string) {
  // Some tenant responses embed historical jobs. Reuse dated records that cover the
  // requested period; otherwise request the dedicated history endpoint.
  const embedded = Array.isArray(employee?.jobs) ? employee.jobs.map(row) : [];
  if (embedded.length && start && end && embedded.every(job => dateOnly(job.start_date) && job.area_id !== undefined) && selectPeriodJob(embedded, start, end).job) return embedded;
  try { return await readList(client, '/employees/{id}/jobs', { path: { id: employeeId } }, issues); }
  catch { issue(issues, 'job_history_unavailable', 'Cannot assign this ficha to its historical team or wage.', employeeId); return []; }
}

interface TeamSelection { ids?: Set<string>; areas: Row[]; description: string; ambiguous?: Row[] }
async function selectTeam(client: Reader, args: Args, issues: Issue[]): Promise<TeamSelection> {
  const explicit = Array.isArray(args.area_ids) ? args.area_ids.map(text) : [];
  if (!args.team && explicit.length === 0) return { areas: [], description: 'All accessible areas' };
  const areas = await readList(client, '/organization/areas/', { query: { page_size: 100, status: 'both' } }, issues);
  let ids = new Set(explicit);
  if (args.team) {
    const query = normalized(args.team);
    let matching = areas.filter(area => normalized(area.name) === query);
    if (matching.length === 0) matching = areas.filter(area => normalized(area.name).includes(query));
    if (matching.length !== 1) return { areas, description: text(args.team), ambiguous: matching.map(area => ({ id: area.id, name: area.name, parent_area: area.parent_area })) };
    ids = new Set([...ids, text(matching[0]!.id)]);
  }
  for (const id of ids) if (!areas.some(area => text(area.id) === id)) throw new Error(`Unknown area_id ${id}.`);
  if (args.include_descendants !== false) {
    for (let pass = 0; pass <= areas.length; pass++) {
      const size = ids.size;
      for (const area of areas) {
        const parent = row(area.parent_area);
        if (ids.has(text(parent.id ?? area.parent_id))) ids.add(text(area.id));
        if (ids.has(text(area.id)) && Array.isArray(area.children_area)) for (const child of area.children_area) ids.add(text(row(child).id));
      }
      if (ids.size === size) break;
    }
  }
  return { ids, areas: areas.filter(area => ids.has(text(area.id))).map(area => ({ id: area.id, name: area.name })), description: text(args.team) || explicit.join(', ') };
}

function matchesJob(job: Row, args: Args, selection: TeamSelection) {
  return (!selection.ids || selection.ids.has(text(job.area_id))) && (!args.company_id || text(job.company_id) === text(args.company_id));
}

/** Cost-center weights affect salary estimates only. Accounting lines are already allocated. */
export function salaryAllocationWeight(job: Row, wantedCenters: string[]): { weight?: Decimal; issue?: string } {
  if (wantedCenters.length === 0) return { weight: new MONEY(1) };
  const rawCenters = job.cost_centers;
  const centers = Array.isArray(rawCenters) ? rawCenters.map(row) : Object.keys(row(rawCenters)).length ? [row(rawCenters)] : [];
  if (centers.length > 0) {
    const weights = centers.map(center => amount(center.weight));
    if (weights.some(weight => !weight || weight.isNegative()) || !weights.reduce<Decimal>((sum, weight) => sum.add(weight ?? 0), new MONEY(0)).eq(100)) return { issue: 'Cost-center weights are missing, negative, or do not sum to 100.' };
    const selected = centers.reduce<Decimal>((sum, center, index) => wantedCenters.includes(text(center.cost_center)) ? sum.add(weights[index]!) : sum, new MONEY(0));
    return { weight: selected.div(100) };
  }
  if (!job.cost_center) return { issue: 'Historical cost-center assignment is missing.' };
  return { weight: new MONEY(wantedCenters.includes(text(job.cost_center)) ? 1 : 0) };
}

export function payrollCostBreakdown(settlement: Row, familyAllowanceCodes: string[] = []) {
  const gross = amount(settlement.income_gross);
  const lines = Array.isArray(settlement.lines_settlement) ? settlement.lines_settlement.map(row) : [];
  const contributions = lines.filter(line => normalized(line.type) === 'aporte');
  const earnings = lines.filter(line => normalized(line.type) === 'haber');
  const codes = new Set(['asignacion_familiar', 'buk_asignacion_familiar', 'reliquidacion_asignacion_familiar', ...familyAllowanceCodes]);
  const family = earnings.filter(line => codes.has(text(line.item_code)) || codes.has(text(line.code)) || normalized(line.name) === 'asignacion familiar');
  const unresolvedFamily = earnings.some(line => normalized(line.name).includes('asignacion familiar') && !family.includes(line));
  const missingAmount = [...earnings, ...contributions].some(line => !amount(line.amount));
  const sum = (items: Row[]) => items.reduce((total, line) => total.add(amount(line.amount) ?? 0), new MONEY(0));
  const totalEarnings = sum(earnings);
  const totalContributions = sum(contributions);
  const familyAllowance = sum(family);
  const reconciled = Boolean(gross && gross.minus(totalEarnings).abs().lte('0.01'));
  const complete = Boolean(gross && earnings.length && contributions.length && reconciled && !missingAmount && !unresolvedFamily);
  return {
    complete, gross, contributions: totalContributions, familyAllowance,
    employerCost: complete ? gross!.plus(totalContributions).minus(familyAllowance) : undefined,
    fixedEarnings: sum(earnings.filter(line => line.income_type === 'remuneracion_fija')),
    occasionalEarnings: sum(earnings.filter(line => line.income_type === 'remuneracion_ocasional')),
    otherEarnings: sum(earnings.filter(line => !['remuneracion_fija', 'remuneracion_ocasional'].includes(text(line.income_type)))),
    reason: complete ? undefined : !contributions.length ? 'Employer contribution lines are absent; zero is not assumed.' : unresolvedFamily ? 'A family-allowance concept requires an explicit family_allowance_codes mapping.' : !reconciled ? 'The sum of earning lines does not reconcile with gross pay.' : 'A salary or contribution amount is missing.',
  };
}

interface MoneyTotals { gross: Decimal; net: Decimal; taxable: Decimal; nontaxable: Decimal; legal_discounts: Decimal; other_discounts: Decimal; contributions: Decimal; family_allowance: Decimal; employer_cost: Decimal; fixed_earnings: Decimal; occasional_earnings: Decimal; other_earnings: Decimal; employer_cost_settlements: number; fichas: Set<string>; people: Set<string>; settlements: number }
function emptyTotals(): MoneyTotals { return { gross: new MONEY(0), net: new MONEY(0), taxable: new MONEY(0), nontaxable: new MONEY(0), legal_discounts: new MONEY(0), other_discounts: new MONEY(0), contributions: new MONEY(0), family_allowance: new MONEY(0), employer_cost: new MONEY(0), fixed_earnings: new MONEY(0), occasional_earnings: new MONEY(0), other_earnings: new MONEY(0), employer_cost_settlements: 0, fichas: new Set(), people: new Set(), settlements: 0 }; }
const monetaryFields = { gross: 'income_gross', net: 'income_net', taxable: 'total_income_taxable', nontaxable: 'total_income_notaxable', legal_discounts: 'total_legal_discounts', other_discounts: 'total_other_discounts' } as const;
function serializedTotals(totals: Map<string, MoneyTotals>) {
  return [...totals].map(([currency, total]) => ({
    currency, gross_pay: total.gross.toFixed(2), net_pay: total.net.toFixed(2), taxable_earnings: total.taxable.toFixed(2),
    nontaxable_earnings: total.nontaxable.toFixed(2), legal_discounts: total.legal_discounts.toFixed(2), other_discounts: total.other_discounts.toFixed(2),
    fixed_earnings: total.fixed_earnings.toFixed(2), occasional_earnings: total.occasional_earnings.toFixed(2), other_earnings: total.other_earnings.toFixed(2),
    employer_contributions: total.contributions.toFixed(2), family_allowance: total.family_allowance.toFixed(2),
    fichas: total.fichas.size, people: total.people.size, settlements: total.settlements,
  }));
}

async function teamPayrollSingle(client: Reader, args: Args) {
  const period = monthBounds(text(args.month));
  const issues: Issue[] = [];
  const selection = await selectTeam(client, args, issues);
  if (selection.ambiguous) return { status: 'needs_team_selection', candidates: selection.ambiguous, month: args.month, guidance: 'Choose an exact area name or area_ids; no salary aggregation was made.' };
  const [settlements, employees] = await Promise.all([
    readList(client, '/payroll_detail/month', { query: { date: period.apiDate, page_size: 100 } }, issues),
    readList(client, '/employees', { query: { page_size: 100 } }, issues),
  ]);
  const byEmployee = new Map(employees.map(employee => [text(employee.id), employee]));
  const ids = unique(settlements.map(settlement => text(settlement.employee_id)).filter(Boolean));
  const jobPairs = await mapLimit(ids, 4, async id => [id, await getJobs(client, id, issues, byEmployee.get(id), period.start, period.end)] as const);
  const jobsById = new Map(jobPairs);
  const totals = new Map<string, MoneyTotals>();
  const breakdown: Row[] = [];
  const selectedSettlements = new Map<string, { currency: string; employeeId: string }>();
  const seen = new Map<string, string>();
  let excludedOpen = 0;
  let includedOpen = 0;
  let excludedOtherTeam = 0;
  const wantedCenters = Array.isArray(args.cost_centers) ? args.cost_centers.map(text) : [];
  const currencyFallback = text(args.payroll_currency || 'CLP').toUpperCase();
  for (const settlement of settlements) {
    const employeeId = text(settlement.employee_id);
    const settlementId = text(settlement.liquidacion_id);
    if (!employeeId || !settlementId) { issue(issues, 'unidentified_settlement', 'A payroll record is missing employee_id or liquidacion_id and was excluded.'); continue; }
    const signature = JSON.stringify(settlement);
    if (seen.has(settlementId)) {
      if (seen.get(settlementId) !== signature) issue(issues, 'conflicting_duplicate', 'The same liquidation ID appeared with different values.', employeeId);
      continue;
    }
    seen.set(settlementId, signature);
    if (settlement.month !== undefined && settlement.year !== undefined && (Number(settlement.month) !== period.month || Number(settlement.year) !== period.year)) { issue(issues, 'wrong_period', 'A payroll record outside the requested month was excluded.', employeeId); continue; }
    const selected = selectPeriodJob(jobsById.get(employeeId) ?? [], period.start, period.end);
    if (!selected.job) { issue(issues, 'missing_period_job', 'No effective job for the requested payroll month; record excluded from team totals.', employeeId); continue; }
    if (!matchesJob(selected.job, args, selection)) {
      if (selected.team_changed && selected.candidates.some(candidate => matchesJob(candidate, args, selection))) issue(issues, 'within_month_team_change', 'This ficha belonged to the selected team for part of the month but the full payroll is assigned to its last team; exact allocation requires accounting cost centers.', employeeId);
      excludedOtherTeam++; continue;
    }
    if (selected.team_changed) issue(issues, 'within_month_team_change', 'Full payroll is assigned to the last effective team in the month; an exact intra-month allocation requires accounting cost centers.', employeeId);
    if (selected.overlapping_jobs) issue(issues, 'overlapping_jobs', 'More than one job was active at period end; latest start date selected provisionally.', employeeId);
    if (settlement.closed !== true) {
      if (args.include_open !== true) { excludedOpen++; continue; }
      includedOpen++;
    }
    const allocation = salaryAllocationWeight(selected.job, wantedCenters);
    if (!allocation.weight) { issue(issues, 'cost_center_allocation_missing', allocation.issue!, employeeId); continue; }
    if (allocation.weight.isZero()) continue;
    const currency = text(settlement.currency_code ?? settlement.currency ?? currencyFallback).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) { issue(issues, 'unknown_payroll_currency', 'Payroll currency cannot be determined.', employeeId); continue; }
    const total = totals.get(currency) ?? emptyTotals();
    const cost = payrollCostBreakdown(settlement, Array.isArray(args.family_allowance_codes) ? args.family_allowance_codes.map(text) : []);
    total.contributions = total.contributions.add(cost.contributions.mul(allocation.weight));
    total.family_allowance = total.family_allowance.add(cost.familyAllowance.mul(allocation.weight));
    total.fixed_earnings = total.fixed_earnings.add(cost.fixedEarnings.mul(allocation.weight));
    total.occasional_earnings = total.occasional_earnings.add(cost.occasionalEarnings.mul(allocation.weight));
    total.other_earnings = total.other_earnings.add(cost.otherEarnings.mul(allocation.weight));
    if (cost.employerCost) { total.employer_cost = total.employer_cost.add(cost.employerCost.mul(allocation.weight)); total.employer_cost_settlements++; }
    else if (!(Array.isArray(args.expense_accounts) && args.expense_accounts.length)) issue(issues, 'employer_cost_incomplete', cost.reason!, employeeId);
    const missing: string[] = [];
    for (const [key, sourceKey] of Object.entries(monetaryFields) as [keyof typeof monetaryFields, string][]) {
      const value = amount(settlement[sourceKey]);
      if (!value) missing.push(sourceKey); else total[key] = total[key].add(value.mul(allocation.weight));
    }
    if (missing.length) issue(issues, 'missing_payroll_amounts', `Missing monetary fields: ${missing.join(', ')}; subtotals contain only observed amounts.`, employeeId);
    total.fichas.add(employeeId);
    total.people.add(text(settlement.person_id) || `ficha:${employeeId}`);
    total.settlements++;
    totals.set(currency, total);
    selectedSettlements.set(settlementId, { currency, employeeId });
    const employee = byEmployee.get(employeeId) ?? {};
    breakdown.push({
      employee_id: employeeId, person_id: settlement.person_id ?? employee.person_id ?? null, name: employeeName(employee) || null, settlement_id: settlementId,
      area_id: selected.job.area_id, currency, closed: settlement.closed === true,
      salary_allocation_fraction: allocation.weight.toString(),
      gross_pay: amount(settlement.income_gross)?.mul(allocation.weight).toFixed(2) ?? null,
      net_pay: amount(settlement.income_net)?.mul(allocation.weight).toFixed(2) ?? null,
      employer_contributions: cost.contributions.mul(allocation.weight).toFixed(2), family_allowance: cost.familyAllowance.mul(allocation.weight).toFixed(2),
      employer_cost: cost.employerCost?.mul(allocation.weight).toFixed(2) ?? null,
      worked_days: settlement.worked_days ?? null,
      base_wage: amount(selected.job.base_wage)?.toString() ?? null, base_wage_currency: jobCurrency(selected.job) ?? null,
    });
  }
  const expenseAccounts = Array.isArray(args.expense_accounts) ? unique(args.expense_accounts.map(text)) : [];
  const accountingTotals = new Map<string, Decimal>();
  let accountingMatched = 0;
  let accountingAvailable = false;
  const accountSummary = new Map<string, { debit: Decimal; credit: Decimal; description: string }>();
  if (expenseAccounts.length || args.include_accounting === true) try {
    const groups = await readList(client, '/accounting', { query: { month: period.month, year: period.year, ...(args.company_id ? { company_id: text(args.company_id) } : {}), page_size: 100 } }, issues);
    accountingAvailable = true;
    const coveredSettlements = new Set<string>();
    for (const group of groups) {
      const selected = selectedSettlements.get(text(group.id));
      if (!selected) continue;
      coveredSettlements.add(text(group.id));
      for (const item of (Array.isArray(group.items) ? group.items : []).map(row)) {
        if (wantedCenters.length && !wantedCenters.includes(text(item.cost_center))) continue;
        const account = text(item.account);
        const value = amount(item.amount);
        if (!value || !['debit', 'credit'].includes(text(item.entry_type))) { issue(issues, 'invalid_accounting_item', 'An accounting amount or debit/credit direction is missing.', selected.employeeId); continue; }
        const subtotal = accountSummary.get(account) ?? { debit: new MONEY(0), credit: new MONEY(0), description: text(item.description) };
        if (item.entry_type === 'debit') subtotal.debit = subtotal.debit.add(value); else subtotal.credit = subtotal.credit.add(value);
        accountSummary.set(account, subtotal);
        if (expenseAccounts.includes(account)) {
          accountingTotals.set(selected.currency, (accountingTotals.get(selected.currency) ?? new MONEY(0)).add(item.entry_type === 'debit' ? value : value.negated()));
          accountingMatched++;
        }
      }
    }
    if (expenseAccounts.length && selectedSettlements.size > coveredSettlements.size) issue(issues, 'missing_accounting_groups', `${selectedSettlements.size - coveredSettlements.size} included liquidation(s) have no accounting group.`);
  } catch {
    if (expenseAccounts.length) issue(issues, 'accounting_unavailable', 'Accounting could not be read; employer cost cannot be calculated.');
  }
  const complete = issues.length === 0 && excludedOpen === 0 && includedOpen === 0;
  const payrollCostComplete = selectedSettlements.size > 0 && [...totals.values()].every(total => total.employer_cost_settlements === total.settlements);
  return {
    status: complete ? 'complete' : 'partial_or_provisional', month: args.month,
    team: { name: selection.description, areas: selection.areas },
    totals_by_currency: serializedTotals(totals), people: unique(breakdown.map(item => text(item.person_id) || `ficha:${text(item.employee_id)}`)).length,
    employer_cost: expenseAccounts.length && accountingAvailable && accountingMatched > 0 ? {
      status: complete ? 'calculated_from_configured_expense_accounts' : 'partial_or_provisional',
      values: [...accountingTotals].map(([currency, value]) => ({ currency, amount: value.toFixed(2) })),
      expense_accounts: expenseAccounts, formula: 'Sum of debit minus credit on the explicitly configured personnel-expense accounts.',
      mapping_requires_finance_validation: true,
    } : !expenseAccounts.length && payrollCostComplete ? {
      status: complete ? 'calculated_from_payroll_components' : 'partial_or_provisional',
      values: [...totals].map(([currency, total]) => ({ currency, amount: total.employer_cost.toFixed(2) })),
      formula: 'Total earnings (income_gross, reconciled to haber lines) + employer contributions (aporte lines) - family allowance.',
      source: 'https://supportcenter.buk.cl/hc/es-419/articles/36330030950427-Costo-empresa-en-Buk',
      reconciliation: 'Earning lines reconcile to gross for every included liquidation. Formula follows Buk standard cost; company-specific extra benefits/provisions require a separate accounting mapping.',
    } : { status: expenseAccounts.length ? 'unavailable_or_no_matching_entries' : 'payroll_components_incomplete', values: null, explanation: 'The full employer cost could not be established for every included record. Review coverage issues or provide Finance-approved personnel expense accounts. Gross/net pay remain separate observed subtotals.' },
    accounting_account_summary: [...accountSummary].map(([account, total]) => ({ account, description: total.description, debit: total.debit.toFixed(2), credit: total.credit.toFixed(2) })),
    employee_breakdown: breakdown,
    coverage: { complete, settlements_received: settlements.length, settlements_included: selectedSettlements.size, excluded_other_team: excludedOtherTeam, excluded_open_or_unknown_close_status: excludedOpen, included_open_or_unknown_close_status: includedOpen, accounting_available: accountingAvailable, issues },
    methodology: {
      team_assignment: 'Last effective job intersecting the payroll month; within-month team moves are flagged as provisional.',
      area_hierarchy: 'Current area hierarchy; historical job area IDs are used. For a historical reorganization, supply explicit area_ids and include_descendants=false.',
      currency: `Payroll records without a currency field use the explicit payroll_currency setting (${currencyFallback}); contractual base-wage currency is kept separate.`,
      cost_centers: 'Salary subtotals use historical job weights; accounting amounts are already allocated and are never multiplied by weights again.',
      net_pay: 'Amount shown on payroll, not confirmation of a bank payment.',
      exclusions: 'Contractors, external benefits, provisions and other costs outside the selected Buk accounting records are not invented.',
    },
    sources: ['GET /payroll_detail/month', 'GET /employees', 'GET /employees/{id}/jobs', ...(expenseAccounts.length || args.include_accounting ? ['GET /accounting'] : []), ...(selection.areas.length ? ['GET /organization/areas/'] : [])],
  };
}

export async function teamPayroll(client: Reader, args: Args): Promise<unknown> {
  const current = await teamPayrollSingle(client, args);
  if (!args.compare_previous || current.status === 'needs_team_selection') return current;
  const prior = await teamPayrollSingle(client, { ...args, month: previousMonth(text(args.month)), compare_previous: false });
  if (!('totals_by_currency' in current) || !('totals_by_currency' in prior)) return { ...current, previous_period: prior };
  const currencies = unique([...(current.totals_by_currency ?? []).map(total => total.currency), ...(prior.totals_by_currency ?? []).map(total => total.currency)]);
  const changes = currencies.map(currency => {
    const total = current.totals_by_currency?.find(value => value.currency === currency);
    const previous = prior.totals_by_currency?.find(value => value.currency === currency);
    const currentCost = current.employer_cost?.values?.find(value => value.currency === currency);
    const priorCost = prior.employer_cost?.values?.find(value => value.currency === currency);
    return {
      currency,
      gross_change: total && previous ? new MONEY(total.gross_pay).minus(previous.gross_pay).toFixed(2) : null,
      gross_change_percent: total && previous ? pct(new MONEY(total.gross_pay), new MONEY(previous.gross_pay)) : null,
      employer_cost_change: currentCost && priorCost ? new MONEY(currentCost.amount).minus(priorCost.amount).toFixed(2) : null,
      employer_cost_change_percent: currentCost && priorCost ? pct(new MONEY(currentCost.amount), new MONEY(priorCost.amount)) : null,
      employer_cost_comparison_complete: Boolean(currentCost && priorCost && current.coverage?.complete && prior.coverage?.complete),
      fichas_change: total && previous ? total.fichas - previous.fichas : null,
      ...(!total || !previous ? { limitation: 'This currency has no observed payroll subtotal in one month; a missing amount is not assumed to be zero.' } : {}),
    };
  });
  const comparisonComplete = Boolean(current.coverage?.complete && prior.coverage?.complete);
  return {
    ...current, status: comparisonComplete ? current.status : 'partial_or_provisional', previous_period: prior, changes,
    coverage: { ...current.coverage, complete: comparisonComplete, comparison_periods_complete: { current: Boolean(current.coverage?.complete), previous: Boolean(prior.coverage?.complete) }, issues: [...(current.coverage?.issues ?? []), ...(!prior.coverage?.complete ? [{ code: 'previous_period_incomplete', detail: 'The previous period has incomplete or provisional data; inspect previous_period.coverage.' }] : [])] },
    comparison_note: 'Each month uses its own historical job membership. Changes can include transfers, hires, terminations, bonuses, days worked, corrections, or wage changes; a cause is not inferred from a total alone.',
  };
}

export async function salaryHistory(client: Reader, args: Args) {
  const employeeId = numericId(args.employee_id);
  const start = monthBounds(text(args.start_month));
  const end = monthBounds(text(args.end_month));
  if (end.start < start.start) throw new Error('end_month must be on or after start_month.');
  const requestedMonths = monthsBetween(text(args.start_month), text(args.end_month));
  const issues: Issue[] = [];
  const jobs = (await getJobs(client, employeeId, issues)).sort((a, b) => text(a.start_date).localeCompare(text(b.start_date)));
  const relevant = jobs.filter(job => Boolean(dateOnly(job.start_date) && text(job.start_date) <= end.end && (dateOnly(job.end_date) ?? '9999-12-31') >= start.start));
  let previous: Row | undefined;
  const wages = relevant.map(job => {
    const wage = amount(job.base_wage);
    const prior = previous ? amount(previous.base_wage) : undefined;
    const currency = jobCurrency(job);
    const comparable = Boolean(wage && prior && currency && currency === jobCurrency(previous ?? {}));
    const changedHours = previous && text(previous.weekly_hours) !== text(job.weekly_hours);
    const output = {
      effective_from: dateOnly(job.start_date) ?? null, effective_until: dateOnly(job.end_date) ?? null,
      base_wage: wage?.toString() ?? null, currency: currency ?? null, weekly_hours: job.weekly_hours ?? null,
      area_id: job.area_id ?? null, company_id: job.company_id ?? null,
      change_amount: comparable ? wage!.minus(prior!).toFixed(2) : null,
      change_percent: comparable ? pct(wage!, prior!) : null,
      hours_changed: Boolean(changedHours),
    };
    if (!wage || !currency) issue(issues, 'missing_wage_or_currency', 'A historical job lacks its base wage or explicit currency.', employeeId);
    previous = job;
    return output;
  });
  const payroll: Row[] = [];
  const seenPayrollMonths = new Set<string>();
  let openPayrollRecords = 0;
  if (args.include_payroll !== false) {
    try {
      const details = await readList(client, '/employees/{employee_id}/payroll_detail', {
        path: { employee_id: employeeId }, query: { start: start.start.split('-').reverse().join('-'), end: end.end.split('-').reverse().join('-'), page_size: 100 },
      }, issues);
      const seen = new Set<string>();
      for (const detail of details) {
        const id = text(detail.liquidacion_id);
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const payrollMonth = `${detail.year}-${text(detail.month).padStart(2, '0')}`;
        if (!requestedMonths.includes(payrollMonth)) { issue(issues, 'invalid_payroll_period', 'A historical payroll record had a missing or out-of-range period and was excluded.', employeeId); continue; }
        if (detail.employee_id !== undefined && text(detail.employee_id) !== employeeId) { issue(issues, 'different_ficha_returned', 'A historical payroll record belonged to a different ficha and was excluded.', employeeId); continue; }
        if (detail.closed !== true) openPayrollRecords++;
        seenPayrollMonths.add(payrollMonth);
        payroll.push({ settlement_id: detail.liquidacion_id ?? null, month: payrollMonth, gross_pay: amount(detail.income_gross)?.toFixed(2) ?? null, net_pay: amount(detail.income_net)?.toFixed(2) ?? null, taxable_earnings: amount(detail.total_income_taxable)?.toFixed(2) ?? null, nontaxable_earnings: amount(detail.total_income_notaxable)?.toFixed(2) ?? null, worked_days: detail.worked_days ?? null, closed: detail.closed === true, lines: detail.lines_settlement ?? [] });
      }
    } catch { issue(issues, 'payroll_history_unavailable', 'Historical payroll could not be read. Employee/sensitive-data permissions or historical coverage may be missing.', employeeId); }
  }
  const missingPayrollMonths = args.include_payroll !== false ? requestedMonths.filter(month => !seenPayrollMonths.has(month)) : [];
  const missingJobMonths = requestedMonths.filter(month => { const bounds = monthBounds(month); return !selectPeriodJob(jobs, bounds.start, bounds.end).job; });
  if (missingPayrollMonths.length) issue(issues, 'missing_payroll_months', 'No payroll was returned for one or more requested months. Absence is not interpreted as a zero salary; inspect missing_payroll_months.', employeeId);
  if (missingJobMonths.length) issue(issues, 'missing_job_months', 'No effective job was returned for one or more requested months. Inspect missing_job_months.', employeeId);
  if (openPayrollRecords) issue(issues, 'open_payroll_records', 'Historical payroll includes open liquidations or records with unknown close status.', employeeId);
  let cpi: unknown = undefined;
  if (args.compare_cpi === true) {
    const first = selectPeriodJob(jobs, start.end, start.end);
    const last = selectPeriodJob(jobs, end.end, end.end);
    if (first.overlapping_jobs || last.overlapping_jobs || !first.job || !last.job) {
      cpi = { status: 'unavailable', reason: 'Unique effective base wages at both requested month ends are required.' };
    } else if (jobCurrency(first.job) !== 'CLP' || jobCurrency(last.job) !== 'CLP' || !amount(first.job.base_wage) || !amount(last.job.base_wage)) {
      cpi = { status: 'unavailable', reason: 'Both endpoint wages must have explicit CLP currency and valid amounts.' };
    } else {
      try {
        cpi = compareWagesToCpi({ initialSalary: text(first.job.base_wage), finalSalary: text(last.job.base_wage), startMonth: text(args.start_month), endMonth: text(args.end_month), currency: 'CLP' }, await loadCpiSeries());
      } catch (error) { cpi = { status: 'unavailable', reason: error instanceof Error ? error.message : 'CPI comparison unavailable.' }; }
    }
  }
  if (args.compare_cpi === true && row(cpi).real_change_percent === undefined) issue(issues, 'cpi_unavailable', 'The requested CPI comparison could not be completed; inspect cpi_comparison.reason.', employeeId);
  return {
    employee_id: employeeId, start_month: args.start_month, end_month: args.end_month,
    contractual_base_wage_history: wages, actual_payroll_history: payroll, ...(cpi ? { cpi_comparison: cpi } : {}),
    coverage: { complete: issues.length === 0 && relevant.length > 0, job_records: jobs.length, relevant_job_records: relevant.length, payroll_records: payroll.length, requested_months: requestedMonths.length, months_with_payroll: [...seenPayrollMonths].sort(), missing_payroll_months: missingPayrollMonths, missing_job_months: missingJobMonths, open_payroll_records: openPayrollRecords, issues },
    methodology: 'Contractual base wages are compared separately from payroll earnings. Job records can reflect promotions, currency or working-hours changes. The API does not guarantee an immutable history of every salary edit. Missing months and wages are not interpolated.',
    sources: ['GET /employees/{id}/jobs', ...(args.include_payroll !== false ? ['GET /employees/{employee_id}/payroll_detail'] : [])],
  };
}

export async function recurringPayroll(client: Reader, args: Args) {
  const asOf = dateOnly(args.as_of);
  if (!asOf || asOf !== args.as_of) throw new Error('as_of must be a valid date in YYYY-MM-DD format.');
  const issues: Issue[] = [];
  const selection = await selectTeam(client, args, issues);
  if (selection.ambiguous) return { status: 'needs_team_selection', candidates: selection.ambiguous };
  const [employees, directory] = await Promise.all([
    readList(client, '/employees/active', { query: { date: asOf, exclude_pending: true, page_size: 100 } }, issues),
    readList(client, '/employees', { query: { page_size: 100 } }, issues),
  ]);
  const directoryById = new Map(directory.map(employee => [text(employee.id), employee]));
  const totals = new Map<string, { value: Decimal; employees: number }>();
  const people: Row[] = [];
  await mapLimit(employees, 4, async employee => {
    const id = text(employee.id);
    const jobs = await getJobs(client, id, issues, { ...employee, jobs: directoryById.get(id)?.jobs ?? employee.jobs }, asOf, asOf);
    const selected = selectPeriodJob(jobs, asOf, asOf);
    if (!selected.job) { issue(issues, 'missing_period_job', 'No job effective on the requested date.', id); return; }
    if (selected.overlapping_jobs) { issue(issues, 'overlapping_jobs', 'More than one job is effective on the requested date.', id); return; }
    if (!matchesJob(selected.job, args, selection)) return;
    const value = amount(selected.job.base_wage);
    const currency = jobCurrency(selected.job);
    if (!value || !currency) { issue(issues, 'missing_wage_or_currency', 'Cannot include a base wage without its amount and currency.', id); return; }
    const frequency = normalized(selected.job.periodicity || selected.job.frequency || employee.payment_period);
    if (frequency && !['mensual', 'monthly', 'month'].includes(frequency)) { issue(issues, 'nonmonthly_wage', 'A nonmonthly or unrecognized wage periodicity was excluded from the monthly run-rate.', id); return; }
    if (!frequency) issue(issues, 'unknown_wage_periodicity', 'Wage periodicity is missing; monthly run-rate is provisional.', id);
    const existing = totals.get(currency) ?? { value: new MONEY(0), employees: 0 };
    existing.value = existing.value.add(value); existing.employees++;
    totals.set(currency, existing);
    people.push({ employee_id: id, name: employeeName(employee), base_wage: value.toString(), currency, weekly_hours: selected.job.weekly_hours ?? null, area_id: selected.job.area_id ?? null });
  });
  const increase = amount(args.increase_percent ?? 0);
  if (!increase || increase.lt(-100) || increase.gt(1000)) throw new Error('increase_percent must be between -100 and 1000.');
  return {
    as_of: asOf, team: selection.description, metric: 'Contractual monthly base-wage run-rate; excludes bonuses, statutory gratification, benefits, employer contributions and other items.',
    totals_by_currency: [...totals].map(([currency, total]) => ({ currency, monthly_base_wages: total.value.toFixed(2), fichas: total.employees, scenario_increase_percent: increase.toString(), scenario_monthly_base_wages: total.value.mul(increase.div(100).plus(1)).toFixed(2), scenario_increment: total.value.mul(increase.div(100)).toFixed(2) })),
    employees: people, coverage: { complete: issues.length === 0, issues },
    sources: ['GET /employees/active?date=as_of', 'GET /employees (embedded jobs)', 'GET /employees/{id}/jobs (when embedded history is unavailable)'],
  };
}

const teamProperties = {
  team: { type: 'string', minLength: 1, description: 'Exact area name. If ambiguous the tool returns candidate IDs.' },
  area_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, uniqueItems: true, minItems: 1 },
  include_descendants: { type: 'boolean', default: true }, company_id: { type: 'integer', minimum: 1 },
};
const schema = (properties: Row, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const analysisTools: AnalysisTool[] = [
  { name: 'buk_search_employees', description: 'Find Buk employees by name, email, ficha ID or document. Returns a minimized directory and flags multiple matches; never guesses which person is intended.', inputSchema: schema({ query: { type: 'string' }, status: { type: 'string', enum: ['activo', 'inactivo', 'pendiente'] }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }), handler: searchEmployees },
  { name: 'buk_team_payroll', description: 'Calculate a team’s monthly gross/net payroll, employee breakdown and prior-month change using historical jobs. Standard Buk employer cost is calculated from reconciled earning/contribution/family-allowance lines; custom Finance-approved expense accounts are also supported. Missing data remain explicit. Only closed payroll is included by default.', inputSchema: schema({ ...teamProperties, month: { type: 'string', pattern: monthPattern }, cost_centers: { type: 'array', items: { type: 'string' }, uniqueItems: true }, include_accounting: { type: 'boolean', default: false }, family_allowance_codes: { type: 'array', items: { type: 'string' }, uniqueItems: true, description: 'Explicit additional item_code/code values for statutory family allowance. Standard Asignación Familiar is detected automatically.' }, expense_accounts: { type: 'array', items: { type: 'string' }, uniqueItems: true, description: 'Finance-approved personnel EXPENSE account numbers. Do not include liabilities, bank or balancing accounts.' }, payroll_currency: { type: 'string', pattern: '^[A-Z]{3}$', default: 'CLP', description: 'Currency of payroll/accounting records where Buk omits a currency field; separate from contractual base-wage currency.' }, include_open: { type: 'boolean', default: false }, compare_previous: { type: 'boolean', default: false } }, ['month']), handler: teamPayroll },
  { name: 'buk_salary_history', description: 'Get contractual base-wage history, salary changes and historical payroll for one exact ficha, optionally compared with official Chile INE CPI for the same endpoint months. Does not infer missing salary history.', inputSchema: schema({ employee_id: { type: 'string', pattern: '^\\d+$' }, start_month: { type: 'string', pattern: monthPattern }, end_month: { type: 'string', pattern: monthPattern }, include_payroll: { type: 'boolean', default: true }, compare_cpi: { type: 'boolean', default: false } }, ['employee_id', 'start_month', 'end_month']), handler: salaryHistory },
  { name: 'buk_recurring_payroll', description: 'Sum a team’s contractual base wages as of an explicit date, by currency, and simulate a percentage change. This is a base-wage run-rate, not total employer cost.', inputSchema: schema({ ...teamProperties, as_of: { type: 'string', format: 'date' }, increase_percent: { type: 'number', minimum: -100, maximum: 1000, default: 0 } }, ['as_of']), handler: recurringPayroll },
  { name: 'buk_compare_salary_to_cpi', description: 'Compare two CLP salaries in exact months using official INE linked Chile CPI indices. Returns nominal change, real change, inflation-adjusted salary and monetary gap. No personal or salary data are transmitted to INE.', inputSchema: schema({ initial_salary: { anyOf: [{ type: 'number', exclusiveMinimum: 0 }, { type: 'string', pattern: '^\\d+(\\.\\d+)?$' }] }, final_salary: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'string', pattern: '^\\d+(\\.\\d+)?$' }] }, start_month: { type: 'string', pattern: monthPattern }, end_month: { type: 'string', pattern: monthPattern }, currency: { type: 'string', enum: ['CLP'], default: 'CLP' } }, ['initial_salary', 'final_salary', 'start_month', 'end_month']), handler: async (_client, args) => compareWagesToCpi({ initialSalary: text(args.initial_salary), finalSalary: text(args.final_salary), startMonth: text(args.start_month), endMonth: text(args.end_month), currency: text(args.currency || 'CLP') }, await loadCpiSeries()) },
];
