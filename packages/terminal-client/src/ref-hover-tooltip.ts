/**
 * Hover tooltip for ref tokens in the terminal (#517): a small floating hint
 * teaching the click semantics — plain click previews (miniview), Cmd/Ctrl-click
 * opens the full view. The modifier differs per platform, so the text does too.
 */

/** True on macOS / iOS, where the "direct open" modifier is ⌘ instead of Ctrl. */
export function isMacPlatform(
  nav: { platform?: string; userAgent?: string } | undefined = typeof navigator !== 'undefined'
    ? navigator
    : undefined,
): boolean {
  return /mac|iphone|ipad|ipod/i.test(`${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`)
}

/** The tooltip line for a ref token, keyed by platform. */
export function refTooltipText(mac: boolean): string {
  return mac ? 'Click to preview · ⌘-click to open' : 'Click to preview · Ctrl-click to open'
}

/**
 * One floating tooltip element, created lazily and reused across hovers.
 * `pointer-events: none` + a fixed position near the cursor keeps it from ever
 * intercepting the click it explains. Theme-aware via the app's CSS variables,
 * with dark fallbacks matching the default terminal palette.
 */
export class RefHoverTooltip {
  private el: HTMLDivElement | null = null

  show(event: MouseEvent): void {
    if (typeof document === 'undefined') return
    const doc = (event.target as Node | null)?.ownerDocument ?? document
    if (!doc.body) return
    if (!this.el) {
      const el = doc.createElement('div')
      el.style.cssText =
        'position:fixed;z-index:2147483646;pointer-events:none;white-space:nowrap;' +
        'padding:3px 8px;border-radius:6px;font:11px ui-sans-serif,system-ui,sans-serif;' +
        'background:var(--popover, #16161c);color:var(--popover-foreground, #d7d7e0);' +
        'border:1px solid var(--border, #3a3a46);box-shadow:0 4px 12px rgba(0,0,0,0.35)'
      this.el = el
    }
    this.el.textContent = refTooltipText(isMacPlatform())
    if (!this.el.isConnected) doc.body.appendChild(this.el)
    // Below-right of the pointer, clamped into the viewport (measure first).
    const margin = 8
    const w = this.el.offsetWidth
    const h = this.el.offsetHeight
    const vw = doc.defaultView?.innerWidth ?? 0
    const vh = doc.defaultView?.innerHeight ?? 0
    const x = event.clientX + 12
    const y = event.clientY + 16
    this.el.style.left = `${Math.max(margin, vw > 0 ? Math.min(x, vw - w - margin) : x)}px`
    this.el.style.top = `${Math.max(margin, vh > 0 ? Math.min(y, vh - h - margin) : y)}px`
  }

  hide(): void {
    this.el?.remove()
  }
}
