import { describe, it, expect, vi } from 'vitest';
import { payrollCostBreakdown, recurringPayroll, salaryAllocationWeight, salaryHistory, searchEmployees, selectPeriodJob, teamPayroll } from '../src/analytics.js';

type Row = Record<string, unknown>;
const job = (changes: Row = {}) => ({ id: 1, start_date: '2024-01-01', end_date: null, area_id: 10, company_id: 1, base_wage: 1000, currency_code: 'CLP', periodicity: 'mensual', weekly_hours: 40, cost_center: 'TECH', ...changes });
const settlement = (changes: Row = {}) => ({
  liquidacion_id: 501, employee_id: 1, person_id: 100, month: '2', year: '2024', closed: true,
  income_gross: 1000, income_net: 800, total_income_taxable: 1000, total_income_notaxable: 0, total_legal_discounts: 200, total_other_discounts: 0,
  worked_days: 30, lines_settlement: [{ type: 'haber', name: 'Sueldo Base', amount: 1000, item_code: 'buk_wage', income_type: 'remuneracion_fija' }, { type: 'aporte', name: 'Employer insurance', amount: 100 }], ...changes,
});
const employee = (changes: Row = {}) => ({ id: 1, person_id: 100, full_name: 'Example Person', status: 'activo', current_job: job(), jobs: [job()], ...changes });

function mockClient(options: { employees?: Row[]; payroll?: Row[]; jobs?: Row[]; accounting?: Row[]; partial?: string; areas?: Row[]; fail?: string } = {}) {
  const read = vi.fn(async (route: string, args?: { path?: Row; query?: Row }) => {
    if (route === options.fail) throw new Error('upstream unavailable');
    let data: Row[] = [];
    if (route === '/employees' || route === '/employees/active') data = options.employees ?? [employee()];
    if (route === '/employees/{id}/jobs') data = options.jobs ?? [job()];
    if (route.includes('payroll_detail')) data = options.payroll ?? [settlement()];
    if (route === '/organization/areas/') data = options.areas ?? [{ id: 10, name: 'Tech', children_area: [], parent_area: { id: 9 } }, { id: 20, name: 'Sales', children_area: [] }];
    if (route === '/accounting') data = options.accounting ?? [];
    return { data: { data }, meta: { operationId: 'test', method: 'get', path: route, pages: 1, complete: route !== options.partial } };
  });
  return { read };
}

describe('payroll semantics', () => {
  it('computes standard Buk employer cost and subtracts family allowance once', () => {
    const cost = payrollCostBreakdown(settlement({ income_gross: 1010, lines_settlement: [
      { type: 'haber', amount: 1000, income_type: 'remuneracion_fija' },
      { type: 'haber', amount: 10, name: 'Asignación Familiar' },
      { type: 'aporte', amount: 100 }, { type: 'informativo', amount: 99999 },
    ] }));
    expect(cost.complete).toBe(true);
    expect(cost.employerCost?.toString()).toBe('1100');
    expect(cost.familyAllowance.toString()).toBe('10');
  });
  it('refuses to treat absent contribution lines as zero and checks gross reconciliation', () => {
    const noContributions = payrollCostBreakdown(settlement({ lines_settlement: [{ type: 'haber', amount: 1000 }] }));
    expect(noContributions.employerCost).toBeUndefined();
    expect(noContributions.reason).toContain('absent');
    expect(payrollCostBreakdown(settlement({ income_gross: 1200 })).complete).toBe(false);
  });
  it('requires explicit mapping for an unrecognized family allowance label', () => {
    const input = settlement({ income_gross: 1010, lines_settlement: [{ type: 'haber', amount: 1000 }, { type: 'haber', amount: 10, item_code: 'custom_family', name: 'Asignación Familiar Retroactiva' }, { type: 'aporte', amount: 100 }] });
    expect(payrollCostBreakdown(input).complete).toBe(false);
    expect(payrollCostBreakdown(input, ['custom_family']).employerCost?.toString()).toBe('1100');
  });
  it('selects historical membership, not the current team', () => {
    const jobs = [job({ area_id: 10, end_date: '2024-02-29' }), job({ area_id: 20, start_date: '2024-03-01' })];
    expect(selectPeriodJob(jobs, '2024-02-01', '2024-02-29').job?.area_id).toBe(10);
    expect(selectPeriodJob(jobs, '2024-03-01', '2024-03-31').job?.area_id).toBe(20);
  });
  it('flags intra-month team changes and overlapping jobs', () => {
    const change = selectPeriodJob([job({ end_date: '2024-02-14' }), job({ id: 2, start_date: '2024-02-15', area_id: 20 })], '2024-02-01', '2024-02-29');
    expect(change.team_changed).toBe(true);
    expect(change.job?.area_id).toBe(20);
    expect(selectPeriodJob([job(), job({ id: 2 })], '2024-02-01', '2024-02-29').overlapping_jobs).toBe(true);
  });
  it('validates cost-center weights', () => {
    expect(salaryAllocationWeight(job({ cost_centers: [{ cost_center: 'TECH', weight: 40 }, { cost_center: 'SALES', weight: 60 }] }), ['TECH']).weight?.toString()).toBe('0.4');
    expect(salaryAllocationWeight(job({ cost_centers: [{ cost_center: 'TECH', weight: 40 }] }), ['TECH']).weight).toBeUndefined();
    expect(salaryAllocationWeight(job({ cost_center: null }), ['TECH']).issue).toBeTruthy();
  });
});

describe('team payroll integration', () => {
  it('returns reconciled gross/net, standard employer cost and historical team data', async () => {
    const client = mockClient({ employees: [employee({ current_job: job({ area_id: 20 }), jobs: [job({ end_date: '2024-02-29' }), job({ start_date: '2024-03-01', area_id: 20 })] })] });
    const result = await teamPayroll(client, { month: '2024-02', team: 'Tech' }) as any;
    expect(result.coverage.complete).toBe(true);
    expect(result.totals_by_currency[0].gross_pay).toBe('1000.00');
    expect(result.employer_cost.values[0].amount).toBe('1100.00');
    expect(result.employee_breakdown[0].area_id).toBe(10);
    expect(client.read.mock.calls.some(([route]) => route === '/employees/{id}/jobs')).toBe(false);
  });
  it('does not double multiply already-allocated accounting lines', async () => {
    const client = mockClient({ employees: [employee({ jobs: [job({ cost_centers: [{ cost_center: 'TECH', weight: 40 }, { cost_center: 'SALES', weight: 60 }] })] })], accounting: [{ id: 501, items: [
      { account: 'EXPENSE', cost_center: 'TECH', entry_type: 'debit', amount: 440 },
      { account: 'EXPENSE', cost_center: 'SALES', entry_type: 'debit', amount: 660 },
      { account: 'LIABILITY', cost_center: 'TECH', entry_type: 'credit', amount: 440 },
    ] }] });
    const result = await teamPayroll(client, { month: '2024-02', cost_centers: ['TECH'], expense_accounts: ['EXPENSE'] }) as any;
    expect(result.totals_by_currency[0].gross_pay).toBe('400.00');
    expect(result.employer_cost.values[0].amount).toBe('440.00');
  });
  it('keeps currencies separate and counts fichas separately from people', async () => {
    const client = mockClient({ employees: [employee(), employee({ id: 2 })], payroll: [settlement(), settlement({ liquidacion_id: 502, employee_id: 2, person_id: 100, currency: 'USD' })] });
    const result = await teamPayroll(client, { month: '2024-02' }) as any;
    expect(result.totals_by_currency).toHaveLength(2);
    expect(result.people).toBe(1);
    expect(result.employee_breakdown).toHaveLength(2);
  });
  it('excludes open payroll by default and marks incompleteness', async () => {
    const client = mockClient({ payroll: [settlement({ closed: false })] });
    const closed = await teamPayroll(client, { month: '2024-02' }) as any;
    expect(closed.coverage.complete).toBe(false);
    expect(closed.coverage.excluded_open_or_unknown_close_status).toBe(1);
    expect(closed.employer_cost.values).toBeNull();
    const provisional = await teamPayroll(client, { month: '2024-02', include_open: true }) as any;
    expect(provisional.employer_cost.status).toBe('partial_or_provisional');
    expect(provisional.employer_cost.values[0].amount).toBe('1100.00');
  });
  it('does not mark truncated pagination complete', async () => {
    const result = await teamPayroll(mockClient({ partial: '/payroll_detail/month' }), { month: '2024-02' }) as any;
    expect(result.coverage.complete).toBe(false);
    expect(result.employer_cost.status).toBe('partial_or_provisional');
  });
  it('deduplicates liquidation IDs and flags conflicting duplicates', async () => {
    const result = await teamPayroll(mockClient({ payroll: [settlement(), settlement(), settlement({ income_net: 700 })] }), { month: '2024-02' }) as any;
    expect(result.totals_by_currency[0].gross_pay).toBe('1000.00');
    expect(result.coverage.issues.some((issue: any) => issue.code === 'conflicting_duplicate')).toBe(true);
  });
  it('returns candidate areas before aggregating an ambiguous team', async () => {
    const client = mockClient({ areas: [{ id: 1, name: 'Tech' }, { id: 2, name: 'Tech' }] });
    const result = await teamPayroll(client, { month: '2024-02', team: 'Tech' }) as any;
    expect(result.status).toBe('needs_team_selection');
    expect(client.read.mock.calls).toHaveLength(1);
  });
  it('compares total employer cost, not only gross pay, across months', async () => {
    const client = mockClient();
    const original = client.read.getMockImplementation()!;
    client.read.mockImplementation(async (route, args) => {
      if (route === '/payroll_detail/month' && args?.query?.date === '01-01-2024') return {
        data: { data: [settlement({ month: '1', income_gross: 800, lines_settlement: [{ type: 'haber', amount: 800 }, { type: 'aporte', amount: 80 }] })] },
        meta: { operationId: 'test', method: 'get', path: route, pages: 1, complete: true },
      };
      return original(route, args);
    });
    const result = await teamPayroll(client, { month: '2024-02', compare_previous: true }) as any;
    expect(result.changes[0].gross_change).toBe('200.00');
    expect(result.changes[0].employer_cost_change).toBe('220.00');
    expect(result.changes[0].employer_cost_change_percent).toBe('25.000000');
    expect(result.changes[0].employer_cost_comparison_complete).toBe(true);
  });
  it('flags the origin team when a ficha moved out during the month', async () => {
    const client = mockClient({ employees: [employee({ jobs: [job({ end_date: '2024-02-14' }), job({ id: 2, start_date: '2024-02-15', area_id: 20 })] })] });
    const result = await teamPayroll(client, { month: '2024-02', team: 'Tech' }) as any;
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.issues.some((issue: any) => issue.code === 'within_month_team_change')).toBe(true);
  });
});

describe('salary history and projections', () => {
  it('uses ficha ID and DD-MM-YYYY payroll date bounds; keeps base pay separate', async () => {
    const client = mockClient({ jobs: [job({ end_date: '2024-01-31' }), job({ id: 2, start_date: '2024-02-01', base_wage: 1200 })] });
    const result = await salaryHistory(client, { employee_id: '1', start_month: '2024-01', end_month: '2024-02' });
    expect(result.contractual_base_wage_history[1]?.change_percent).toBe('20.000000');
    expect(result.actual_payroll_history[0]?.gross_pay).toBe('1000.00');
    const payrollCall = client.read.mock.calls.find(([route]) => route === '/employees/{employee_id}/payroll_detail');
    expect(payrollCall?.[1]?.query).toEqual({ start: '01-01-2024', end: '29-02-2024', page_size: 100 });
    await expect(salaryHistory(client, { employee_id: '1-9', start_month: '2024-01', end_month: '2024-02' })).rejects.toThrow('ficha ID');
  });
  it('returns limitations for unavailable payroll history without inventing values', async () => {
    const result = await salaryHistory(mockClient({ fail: '/employees/{employee_id}/payroll_detail' }), { employee_id: '1', start_month: '2024-01', end_month: '2024-02' });
    expect(result.coverage.complete).toBe(false);
    expect(result.actual_payroll_history).toEqual([]);
  });
  it('reports gaps month by month instead of treating sparse payroll as a complete history', async () => {
    const result = await salaryHistory(mockClient(), { employee_id: '1', start_month: '2024-01', end_month: '2024-03' });
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.missing_payroll_months).toEqual(['2024-01', '2024-03']);
    expect(result.coverage.months_with_payroll).toEqual(['2024-02']);
  });
  it('simulates base salary increase with explicit effective date and currency', async () => {
    const result = await recurringPayroll(mockClient(), { as_of: '2024-02-20', team: 'Tech', increase_percent: 5 }) as any;
    expect(result.totals_by_currency[0].monthly_base_wages).toBe('1000.00');
    expect(result.totals_by_currency[0].scenario_monthly_base_wages).toBe('1050.00');
    expect(result.metric).toContain('excludes');
    expect(result.coverage.complete).toBe(true);
  });
  it('returns only minimized directory fields and preserves ambiguity', async () => {
    const result = await searchEmployees(mockClient({ employees: [employee({ bank: 'private-bank' }), employee({ id: 2 })] }), { query: 'example' });
    expect(result.needs_disambiguation).toBe(true);
    expect(result.matches[0]).not.toHaveProperty('bank');
    expect(result.matches[0]).not.toHaveProperty('base_wage');
  });
});
