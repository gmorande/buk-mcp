import { describe, it, expect, vi } from 'vitest';
import { bundledCpi, compareWagesToCpi, loadCpiSeries, parseIneCsv } from '../src/cpi.js';

const series = parseIneCsv('"Año";"Mes";"Índice"\n2024;1;100\n2024;2;112', '2024-03-01');

describe('official CPI and real salary calculations', () => {
  it('uses a ratio rather than subtracting inflation percentages', () => {
    const comparison = compareWagesToCpi({ initialSalary: 1500, finalSalary: 1800, startMonth: '2024-01', endMonth: '2024-02' }, series);
    expect(comparison.nominal_change_percent).toBe('20.000000');
    expect(comparison.cpi_change_percent).toBe('12.000000');
    expect(comparison.real_change_percent).toBe('7.142857');
    expect(comparison.salary_to_preserve_purchasing_power).toBe('1680.00');
    expect(comparison.difference_vs_cpi_adjusted_salary).toBe('120.00');
  });
  it('handles zero final salaries and decimal amounts without binary floating point drift', () => {
    expect(compareWagesToCpi({ initialSalary: '0.10', finalSalary: 0, startMonth: '2024-01', endMonth: '2024-02' }, series).real_change_percent).toBe('-100.000000');
  });
  it('rejects zero initial salary, currency mixing and reverse periods', () => {
    expect(() => compareWagesToCpi({ initialSalary: 0, finalSalary: 1, startMonth: '2024-01', endMonth: '2024-02' }, series)).toThrow();
    expect(() => compareWagesToCpi({ initialSalary: 1, finalSalary: 1, startMonth: '2024-01', endMonth: '2024-02', currency: 'USD' }, series)).toThrow('CLP');
    expect(() => compareWagesToCpi({ initialSalary: 1, finalSalary: 1, startMonth: '2024-02', endMonth: '2024-01' }, series)).toThrow();
  });
  it('never substitutes a published month for a missing or future month', () => {
    expect(() => compareWagesToCpi({ initialSalary: 1, finalSalary: 2, startMonth: '2024-01', endMonth: '2024-03' }, series)).toThrow('exact requested months');
  });
  it('parses official semicolon/comma format and rejects missing/duplicate rows', () => {
    expect(parseIneCsv('Año;Mes;Índice\n2024;1;100,25\n2024;2;101,05').observations[0]?.index).toBe('100.25');
    expect(() => parseIneCsv('Año;Mes;Índice\n2024;1;100\n2024;3;101')).toThrow('missing month');
    expect(() => parseIneCsv('Año;Mes;Índice\n2024;1;100\n2024;1;101')).toThrow('duplicate');
    expect(() => parseIneCsv('<html>temporarily unavailable</html>')).toThrow();
  });
  it('bundles a dated continuous public official series', () => {
    const snapshot = bundledCpi();
    expect(snapshot.observations[0]?.month).toBe('2009-12');
    expect(snapshot.observations.at(-1)?.month).toBe('2026-09');
    expect(snapshot.source_url).toContain('www.ine.gob.cl');
    expect(snapshot.retrieved_at).toBe('2026-10-23');
  });
  it('fetches only the public fixed INE URL, without any salary or identity', async () => {
    const fetcher = vi.fn(async () => new Response('Año;Mes;Índice\n2024;1;100\n2024;2;112'));
    const loaded = await loadCpiSeries({ fetcher: fetcher as typeof fetch });
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).hostname).toBe('www.ine.gob.cl');
    expect(new URL(url).search).toBe('');
    expect(options.redirect).toBe('error');
    expect(loaded.fallback).toBe(false);
  });
  it('marks network failure as a dated fallback, never as refreshed current data', async () => {
    const result = await loadCpiSeries({ fetcher: vi.fn(async () => { throw new Error('network'); }) as typeof fetch });
    expect(result.fallback).toBe(true);
    expect(result.retrieved_at).toBe('2026-10-23');
    expect(result.warning).toContain('snapshot');
  });
});
