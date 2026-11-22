// Draggable separator between the telegram list and the detail panel (UI-6).
// The width of the panel is kept in localStorage.

export const DEFAULT_DETAIL_WIDTH = 420;
export const MIN_DETAIL_WIDTH = 280;
/** Space the telegram list keeps at least. */
export const MIN_LIST_WIDTH = 320;
const STORAGE_KEY = 'ebus-analyzer.detail-width';
const KEY_STEP = 20;

/** Limits a panel width to what fits next to the list. */
export function clampWidth(width: number, available: number): number {
  const max = Math.max(MIN_DETAIL_WIDTH, available - MIN_LIST_WIDTH);
  return Math.round(Math.min(max, Math.max(MIN_DETAIL_WIDTH, width)));
}

function load(): number {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_DETAIL_WIDTH;
  } catch {
    return DEFAULT_DETAIL_WIDTH;
  }
}

function save(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // storage unavailable: width is kept for this session only
  }
}

/**
 * Makes `handle` resize `panel` (to the right of the handle) within `layout`.
 * Drag with mouse, pen or touch; arrow keys, Home/End when focused;
 * double-click restores the default width.
 */
export function initSplitter(layout: HTMLElement, handle: HTMLElement, panel: HTMLElement): void {
  let width = load();
  const available = () => layout.clientWidth - handle.offsetWidth;
  const apply = (w: number, persist = false) => {
    width = clampWidth(w, available());
    layout.style.setProperty('--detail-width', `${width}px`);
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute('aria-valuemin', String(MIN_DETAIL_WIDTH));
    handle.setAttribute('aria-valuemax', String(clampWidth(Infinity, available())));
    if (persist) save(width);
  };
  apply(width);

  handle.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    const startX = ev.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    const move = (e: PointerEvent) => apply(startWidth + (startX - e.clientX));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      save(width);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => apply(DEFAULT_DETAIL_WIDTH, true));
  handle.addEventListener('keydown', (ev) => {
    const steps: Record<string, number> = { ArrowLeft: KEY_STEP, ArrowRight: -KEY_STEP, Home: Infinity, End: -Infinity };
    const d = steps[ev.key];
    if (d === undefined) return;
    ev.preventDefault();
    apply(Number.isFinite(d) ? width + d : d > 0 ? Infinity : MIN_DETAIL_WIDTH, true);
  });
  // keep the panel within bounds when the window shrinks
  window.addEventListener('resize', () => apply(load()));
}
