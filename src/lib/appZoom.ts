// The app renders at a global CSS zoom (`html { zoom: var(--app-zoom) }`, globals.css) — currently
// 90%. getBoundingClientRect() returns VISUAL pixels (already scaled by the zoom), but any
// fixed/absolute positioning inside the zoomed document consumes LAYOUT pixels, so anchoring a
// portalled overlay directly to a measured rect lands it at zoom × the intended position (drifting
// toward the top-left). Divide by the element's measured visual↔layout ratio instead of hardcoding
// the zoom value — this stays correct if --app-zoom changes and folds in browser zoom quirks.

/** A rect in LAYOUT pixels — safe to feed into fixed/absolute positioning inside the zoomed page. */
export function layoutRect(el: HTMLElement): { top: number; left: number; width: number; height: number } {
  const r = el.getBoundingClientRect();
  const scale = el.offsetWidth > 0 ? (r.width / el.offsetWidth) || 1 : 1;
  return { top: r.top / scale, left: r.left / scale, width: r.width / scale, height: r.height / scale };
}
