// Small multiples of step charts with one shared time axis (no dual axes):
// one panel per series, hover shows a crosshair and the values at that time.

import type { SeriesData } from '../analysis/series.ts';
import { esc, timestamp } from './format.ts';

export const PLOT_LEFT = 64;
const PLOT_RIGHT = 16;
const PANEL_H = 56;
const PAD_Y = 6;

export interface ChartLayout {
  width: number;
  t0: number;
  t1: number;
}

export function chartLayout(series: readonly SeriesData[], width: number): ChartLayout {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const s of series) {
    for (const p of s.points) t0 = Math.min(t0, p.t);
    t1 = Math.max(t1, s.end);
  }
  if (!Number.isFinite(t0)) t0 = t1 = Date.now();
  if (t1 - t0 < 10_000) t1 = t0 + 10_000;
  return { width: Math.max(320, width), t0, t1 };
}

export function xFor(layout: ChartLayout, t: number): number {
  const w = layout.width - PLOT_LEFT - PLOT_RIGHT;
  return PLOT_LEFT + ((t - layout.t0) / (layout.t1 - layout.t0)) * w;
}

export function tFor(layout: ChartLayout, x: number): number {
  const w = layout.width - PLOT_LEFT - PLOT_RIGHT;
  return layout.t0 + ((x - PLOT_LEFT) / w) * (layout.t1 - layout.t0);
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 0.01)) return v.toExponential(2);
  return String(Math.round(v * 1000) / 1000);
}

function panel(s: SeriesData, layout: ChartLayout): string {
  const values = s.points.map((p) => p.v).filter((v): v is number => v !== undefined);
  let lo = values.length ? Math.min(...values) : 0;
  let hi = values.length ? Math.max(...values) : 1;
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const y = (v: number) => PAD_Y + (1 - (v - lo) / (hi - lo)) * (PANEL_H - 2 * PAD_Y);
  // step line: hold each value until the next point (or the end)
  let d = '';
  s.points.forEach((p, i) => {
    if (p.v === undefined) return;
    const x0 = xFor(layout, p.t);
    const next = s.points[i + 1];
    const x1 = xFor(layout, next ? next.t : s.end);
    const yy = y(p.v);
    const prev = s.points[i - 1];
    d += prev?.v !== undefined ? `L${x0.toFixed(1)},${yy.toFixed(1)}` : `M${x0.toFixed(1)},${yy.toFixed(1)}`;
    d += `H${x1.toFixed(1)}`;
  });
  const last = [...s.points].reverse().find((p) => p.v !== undefined);
  const right = layout.width - PLOT_RIGHT;
  return `
    <div class="chart-panel" data-series="${esc(s.id)}">
      <div class="chart-head">
        <span class="chart-label" title="${esc(s.label)}">${esc(s.label)}</span>
        <span class="chart-latest">${last ? `${esc(last.text)}${s.unit ? ` ${esc(s.unit)}` : ''}` : '–'}</span>
        <button type="button" class="icon small" data-action="remove-series" data-series="${esc(s.id)}" aria-label="Remove chart" title="Remove">×</button>
      </div>
      <svg width="${layout.width}" height="${PANEL_H}" role="img" aria-label="${esc(s.label)} over time">
        <line x1="${PLOT_LEFT}" x2="${right}" y1="${y(hi)}" y2="${y(hi)}" class="grid"/>
        <line x1="${PLOT_LEFT}" x2="${right}" y1="${y(lo)}" y2="${y(lo)}" class="grid"/>
        <text x="${PLOT_LEFT - 8}" y="${y(hi) + 4}" class="tick" text-anchor="end">${esc(fmt(hi))}</text>
        <text x="${PLOT_LEFT - 8}" y="${y(lo) + 4}" class="tick" text-anchor="end">${esc(fmt(lo))}</text>
        <path d="${d}" class="line"/>
      </svg>
    </div>`;
}

function timeTicks(layout: ChartLayout): { ticks: number[]; step: number } {
  const span = layout.t1 - layout.t0;
  const steps = [10e3, 30e3, 60e3, 300e3, 600e3, 1800e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3];
  const step = steps.find((s) => span / s <= 6) ?? 86400e3;
  // align to local time (hours/days) by offsetting with the timezone
  const tz = new Date(layout.t0).getTimezoneOffset() * 60e3;
  const first = Math.ceil((layout.t0 - tz) / step) * step + tz;
  const ticks: number[] = [];
  for (let t = first; t <= layout.t1; t += step) ticks.push(t);
  return { ticks, step };
}

export function renderChart(series: readonly SeriesData[], layout: ChartLayout): string {
  if (!series.length) return '';
  const { ticks, step } = timeTicks(layout);
  const multiDay = layout.t1 - layout.t0 > 86400e3;
  const seconds = step < 60e3;
  const axis = `
    <svg width="${layout.width}" height="22" class="chart-axis" aria-hidden="true">
      ${ticks
        .map((t) => {
          const x = xFor(layout, t);
          const d = new Date(t);
          const label = multiDay ? `${d.getDate()}.${d.getMonth() + 1}. ${timestamp(t).slice(0, 5)}` : seconds ? timestamp(t) : timestamp(t).slice(0, 5);
          return `<line x1="${x}" x2="${x}" y1="0" y2="5" class="grid"/><text x="${x}" y="17" class="tick" text-anchor="middle">${label}</text>`;
        })
        .join('')}
    </svg>`;
  return `${series.map((s) => panel(s, layout)).join('')}${axis}<div class="crosshair" hidden></div><div class="chart-tip" hidden></div>`;
}
