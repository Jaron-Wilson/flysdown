/**
 * Drag handles that widen or narrow the two side panels.
 *
 * A panel's width is the --panel-w-left / --panel-w-right custom property the
 * layout grid already uses, so a handle only rewrites that one value. Widths
 * persist per browser, are clamped so the map always keeps room, and the
 * handles also answer to the arrow keys (and Home to reset), because a
 * separator nobody can reach without a mouse is not one. Phone layouts stack
 * the panels full width, so the handles are hidden there by CSS.
 */

const KEY = 'flysdown.panelWidths.v1';
export const LIMITS = { min: 240, max: 760, mapMin: 360, step: 24 };

/** The width a panel may take, given the window and the other panel. */
export function clampWidth(width, { viewport, other, limits = LIMITS }) {
  const room = viewport - other - limits.mapMin;
  return Math.round(Math.max(limits.min, Math.min(limits.max, room, width)));
}

function readSaved() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function save(widths) {
  try {
    localStorage.setItem(KEY, JSON.stringify(widths));
  } catch {
    // Storage denied: the width still applies for this visit.
  }
}

export function initPanelResize({ onResize } = {}) {
  const root = document.documentElement;
  const layout = document.querySelector('.layout');
  if (!layout) return;
  const defaults = {
    left: parseFloat(getComputedStyle(root).getPropertyValue('--panel-w-left')) || 332,
    right: parseFloat(getComputedStyle(root).getPropertyValue('--panel-w-right')) || 360,
  };
  const saved = readSaved();
  const widths = { left: saved.left ?? null, right: saved.right ?? null };

  const current = (side) => widths[side] ?? defaults[side];
  const apply = (side, width, { remember = true } = {}) => {
    const other = current(side === 'left' ? 'right' : 'left');
    const next = clampWidth(width, { viewport: window.innerWidth, other });
    widths[side] = next;
    root.style.setProperty(`--panel-w-${side}`, `${next}px`);
    handles[side].setAttribute('aria-valuenow', String(next));
    if (remember) save(widths);
    onResize?.();
  };
  const reset = (side) => {
    widths[side] = null;
    root.style.removeProperty(`--panel-w-${side}`);
    handles[side].setAttribute('aria-valuenow', String(defaults[side]));
    save(widths);
    onResize?.();
  };

  const handles = {};
  for (const side of ['left', 'right']) {
    const handle = document.createElement('div');
    handle.className = `panel-resizer panel-resizer-${side}`;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', `Resize the ${side} panel (arrow keys, Home to reset)`);
    handle.setAttribute('aria-valuemin', String(LIMITS.min));
    handle.setAttribute('aria-valuemax', String(LIMITS.max));
    handle.setAttribute('aria-valuenow', String(current(side)));
    handle.title = 'Drag to resize. Double-click to reset.';
    handle.tabIndex = 0;
    layout.appendChild(handle);
    handles[side] = handle;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add('is-resizing');
      const startX = event.clientX;
      const startWidth = current(side);
      const move = (e) => {
        const delta = e.clientX - startX;
        apply(side, side === 'left' ? startWidth + delta : startWidth - delta, { remember: false });
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        document.body.classList.remove('is-resizing');
        save(widths);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });

    handle.addEventListener('dblclick', () => reset(side));
    handle.addEventListener('keydown', (event) => {
      const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
      const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
      if (event.key === grow) apply(side, current(side) + LIMITS.step);
      else if (event.key === shrink) apply(side, current(side) - LIMITS.step);
      else if (event.key === 'Home') reset(side);
      else return;
      event.preventDefault();
    });
  }

  // Restore saved widths, re-clamped to this window.
  for (const side of ['left', 'right']) {
    if (widths[side] !== null) apply(side, widths[side], { remember: false });
  }
  window.addEventListener('resize', () => {
    for (const side of ['left', 'right']) {
      if (widths[side] !== null) apply(side, widths[side], { remember: false });
    }
  });
}
