import { readFileSync } from 'node:fs';
import { Decimal } from 'decimal.js';

export const CPI_SOURCE_URL = 'https://www.ine.gob.cl/docs/default-source/%C3%ADndice-de-precios-al-consumidor/cuadros-estadisticos/series-empalmadas-y-antecedentes-historicos/series-empalmadas-diciembre-2009-a-la-fecha/serie-hist%C3%B3rica-empalmada-ipc-diciembre-2009-a-la-fecha-csv.csv';
export interface CpiObservation { month: string; index: string }
export interface CpiSeries {
  source: string;
  series: string;
  source_url: string;
  retrieved_at: string;
  observations: CpiObservation[];
  fallback?: boolean;
  warning?: string;
}

export function validateMonth(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Use months in YYYY-MM format.');
  return month;
}

function validateObservations(observations: CpiObservation[]): CpiObservation[] {
  if (observations.length < 2) throw new Error('INE CPI response did not contain a monthly series.');
  const sorted = observations.sort((a, b) => a.month.localeCompare(b.month));
  let previous = -1;
  for (const row of sorted) {
    validateMonth(row.month);
    if (!/^\d+(\.\d+)?$/.test(row.index) || !new Decimal(row.index).gt(0)) throw new Error('Invalid CPI index.');
    const ordinal = Number(row.month.slice(0, 4)) * 12 + Number(row.month.slice(5)) - 1;
    if (previous >= 0 && ordinal !== previous + 1) throw new Error('CPI series has a duplicate or missing month.');
    previous = ordinal;
  }
  return sorted;
}

/** The INE file is semicolon-separated Latin-1, with comma decimal separators. */
export function parseIneCsv(csv: string, retrievedAt = new Date().toISOString()): CpiSeries {
  const observations: CpiObservation[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const cells = line.replace(/^\uFEFF/, '').split(';').map(value => value.trim().replace(/^"|"$/g, ''));
    if (!/^\d{4}$/.test(cells[0] ?? '')) continue;
    if (!/^\d{1,2}$/.test(cells[1] ?? '')) throw new Error('Invalid CPI month.');
    observations.push({ month: `${cells[0]}-${cells[1]!.padStart(2, '0')}`, index: (cells[2] ?? '').replace(',', '.') });
  }
  return {
    source: 'Instituto Nacional de Estadísticas de Chile',
    series: 'IPC general empalmado, base anual 2023=100',
    source_url: CPI_SOURCE_URL,
    retrieved_at: retrievedAt,
    observations: validateObservations(observations),
    fallback: false,
  };
}

export function bundledCpi(): CpiSeries {
  const result = JSON.parse(readFileSync(new URL('../data/chile-cpi.json', import.meta.url), 'utf8')) as CpiSeries;
  validateObservations(result.observations);
  return result;
}

let cached: { series: CpiSeries; until: number } | undefined;
/** Only public CPI data are cached. No names, salary values, or Buk credentials leave for INE. */
export async function loadCpiSeries(options: { fetcher?: typeof fetch; refresh?: boolean; offline?: boolean } = {}): Promise<CpiSeries> {
  if (options.offline) return { ...bundledCpi(), fallback: true, warning: 'Using the bundled, dated INE snapshot; newer months are not inferred.' };
  if (!options.fetcher && !options.refresh && cached && cached.until > Date.now()) return cached.series;
  try {
    const response = await (options.fetcher ?? fetch)(CPI_SOURCE_URL, {
      signal: AbortSignal.timeout(12_000), redirect: 'error', headers: { accept: 'text/csv' },
    });
    if (!response.ok) throw new Error('INE CPI is unavailable.');
    if (Number(response.headers.get('content-length')) > 1_000_000) throw new Error('INE response exceeded the expected size.');
    const body = await response.arrayBuffer();
    if (body.byteLength > 1_000_000) throw new Error('INE response exceeded the expected size.');
    const series = parseIneCsv(new TextDecoder('windows-1252').decode(body));
    if (!options.fetcher) cached = { series, until: Date.now() + 6 * 60 * 60 * 1000 };
    return series;
  } catch {
    const series = { ...bundledCpi(), fallback: true, warning: 'INE could not be refreshed. Using the bundled snapshot with its original publication coverage.' };
    if (!options.fetcher) cached = { series, until: Date.now() + 60_000 };
    return series;
  }
}

export function compareWagesToCpi(input: {
  initialSalary: Decimal.Value; finalSalary: Decimal.Value; startMonth: string; endMonth: string; currency?: string;
}, series: CpiSeries) {
  const start = validateMonth(input.startMonth);
  const end = validateMonth(input.endMonth);
  if (end < start) throw new Error('end_month must be on or after start_month.');
  if ((input.currency ?? 'CLP').toUpperCase() !== 'CLP') throw new Error('Chile CPI salary comparison requires CLP. Convert currencies explicitly before comparing.');
  const initial = new Decimal(input.initialSalary);
  const final = new Decimal(input.finalSalary);
  if (!initial.isFinite() || !initial.gt(0) || !final.isFinite() || final.isNegative()) throw new Error('Initial salary must be positive and final salary must be non-negative.');
  const first = series.observations.find(row => row.month === start);
  const last = series.observations.find(row => row.month === end);
  if (!first || !last) {
    throw new Error(`CPI is unavailable for the exact requested months. Available range: ${series.observations[0]?.month} through ${series.observations.at(-1)?.month}. No unpublished value is extrapolated.`);
  }
  const factor = new Decimal(last.index).div(first.index);
  const salaryFactor = final.div(initial);
  const indexed = initial.mul(factor);
  return {
    currency: 'CLP', start_month: start, end_month: end,
    initial_salary: initial.toFixed(2), final_salary: final.toFixed(2),
    initial_cpi_index: first.index, final_cpi_index: last.index,
    nominal_change_percent: salaryFactor.minus(1).mul(100).toFixed(6),
    cpi_change_percent: factor.minus(1).mul(100).toFixed(6),
    real_change_percent: salaryFactor.div(factor).minus(1).mul(100).toFixed(6),
    salary_to_preserve_purchasing_power: indexed.toFixed(2),
    difference_vs_cpi_adjusted_salary: final.minus(indexed).toFixed(2),
    formula: '(final_salary / initial_salary) / (final_cpi_index / initial_cpi_index) - 1',
    source: { name: series.source, url: series.source_url, retrieved_at: series.retrieved_at, series: series.series, latest_month: series.observations.at(-1)?.month, fallback: Boolean(series.fallback) },
    precision_note: 'Uses the published INE linked index levels (two decimal places), not rounded monthly percentage sums. Small differences from the official calculator using internal precision can occur.',
    ...(series.warning ? { warning: series.warning } : {}),
  };
}
