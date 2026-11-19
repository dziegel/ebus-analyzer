// Rendering for the TypeSpec project dialog (M4).

import type { TspDiagnostic } from '../tsp/protocol.ts';
import { esc } from './format.ts';

export function renderFiles(paths: readonly string[], changed: ReadonlySet<string>, open: string | undefined, filter: string, diags: readonly TspDiagnostic[]): string {
  if (!paths.length) return '<div class="tsp-empty">Open a folder with .tsp files, e.g. the <code>src</code> folder of ebusd-configuration.</div>';
  const f = filter.trim().toLowerCase();
  const errors = new Map<string, number>();
  for (const d of diags) if (d.file && d.severity === 'error') errors.set(d.file, (errors.get(d.file) ?? 0) + 1);
  return paths
    .filter((p) => !f || p.toLowerCase().includes(f))
    .map((p) => {
      const cls = [p === open ? 'open' : '', changed.has(p) ? 'changed' : ''].filter(Boolean).join(' ');
      const n = errors.get(p);
      return `<button type="button" data-file="${esc(p)}" class="${cls}">${esc(p)}${n ? `<span class="count">${n} error${n === 1 ? '' : 's'}</span>` : ''}</button>`;
    })
    .join('');
}

export function renderDiagnostics(diags: readonly TspDiagnostic[], limit = 200): string {
  if (!diags.length) return '';
  const sorted = [...diags].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return sorted
    .slice(0, limit)
    .map((d, i) => {
      const loc = d.file ? `${d.file}${d.line ? `:${d.line}:${d.column ?? 1}` : ''}` : '';
      return (
        `<button type="button" class="tsp-diag ${d.severity}" data-diag="${i}" title="${esc(d.code)}">` +
        `<span class="sev">${d.severity}</span> ${loc ? `<span class="loc">${esc(loc)}</span> ` : ''}${esc(d.message)}</button>`
      );
    })
    .join('') + (diags.length > limit ? `<div class="muted small">… ${diags.length - limit} more</div>` : '');
}

/** Sorts diagnostics like renderDiagnostics (errors first) so indexes match. */
export function sortedDiagnostics(diags: readonly TspDiagnostic[]): TspDiagnostic[] {
  return [...diags].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/** Character offset of a 1-based line/column in a text. */
export function offsetOf(text: string, line: number, column = 1): number {
  let pos = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf('\n', pos);
    if (next < 0) return text.length;
    pos = next + 1;
  }
  return Math.min(text.length, pos + column - 1);
}

/** 1-based line/column of a character offset. */
export function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - before.lastIndexOf('\n') };
}
