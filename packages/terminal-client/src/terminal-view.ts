import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { type ITheme, Terminal } from '@xterm/xterm'
// xterm renders its rows, cursor, selection overlay and the hidden char-measure /
// helper-textarea elements relative to styles in this sheet. Without it the measure
// element renders visibly (a stray row of `$`/`-`), the selection overlay detaches
// from the grid, the helper textarea sits in the layout (breaking focus + paste), and
// FitAddon cannot measure a cell. Importing it here keeps the component self-contained.
import '@xterm/xterm/css/xterm.css'

export interface TerminalViewOptions {
  cols?: number
  rows?: number
  fontSize?: number
  fontFamily?: string
  theme?: ITheme
}

// A terminal in a proportional font is unreadable and misaligns box-drawing. Pin a
// monospace stack that resolves to a real mono font on every platform.
const MONO_STACK =
  "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Fira Code', Menlo, 'Cascadia Code', 'DejaVu Sans Mono', Consolas, monospace"

// Palette aligned with the app's design tokens (see apps/web styles.css).
const DEFAULT_THEME: ITheme = {
  background: '#0e0e12',
  foreground: '#d7d7e0',
  cursor: '#f59e0b',
  cursorAccent: '#0e0e12',
  selectionBackground: 'rgba(245, 158, 11, 0.30)',
  selectionForeground: '#f3f3f8',
  black: '#16161c',
  brightBlack: '#3a3a46',
  red: '#f87171',
  brightRed: '#fca5a5',
  green: '#34d399',
  brightGreen: '#6ee7b7',
  yellow: '#fbbf24',
  brightYellow: '#fcd34d',
  blue: '#60a5fa',
  brightBlue: '#93c5fd',
  magenta: '#c084fc',
  brightMagenta: '#d8b4fe',
  cyan: '#22d3ee',
  brightCyan: '#67e8f9',
  white: '#d7d7e0',
  brightWhite: '#f3f3f8',
}

export class TerminalView {
  private readonly term: Terminal
  private readonly fitAddon: FitAddon
  private readonly cleanup: Array<() => void> = []
  private disposed = false
  private host: HTMLElement | null = null

  constructor(opts: TerminalViewOptions = {}) {
    this.term = new Terminal({
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      scrollback: 5000,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: opts.fontSize ?? 13,
      fontFamily: opts.fontFamily ?? MONO_STACK,
      fontWeight: 400,
      fontWeightBold: 600,
      lineHeight: 1.15,
      letterSpacing: 0,
      drawBoldTextInBrightColors: true,
      // Option must stay a "third-level shift" (compose), NOT Meta. On non-US Mac
      // layouts (Swiss, German, French, …) the bracket/brace/pipe/at/hash keys are
      // ALL typed via Option (e.g. Swiss `[`=⌥5, `]`=⌥6, `{`=⌥8, `}`=⌥9). With
      // macOptionIsMeta:true xterm intercepts Option+<key> and sends ESC+<key>
      // (Meta) instead of letting the OS compose the character, so those users can
      // type no brackets at all — coding is impossible. false lets the OS compose;
      // special keys below keyCode 48 (Option+Enter=ESC CR, Option+arrows) still
      // send their Meta sequences, so Claude Code's Option+Enter newline is kept.
      macOptionIsMeta: false,
      scrollSensitivity: 3,
      theme: opts.theme ?? DEFAULT_THEME,
    })
    this.fitAddon = new FitAddon()
    this.term.loadAddon(this.fitAddon)
    // Make URLs in output clickable; open in a new tab with no referrer/opener.
    this.term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        window.open(uri, '_blank', 'noopener,noreferrer')
      }),
    )
  }

  mount(el: HTMLElement): void {
    this.host = el
    this.term.open(el)
    // The WebGL renderer must be attached after open(). It is GPU-backed and far
    // cheaper for the high-throughput output agents produce, but can fail (headless,
    // blocklisted GPU) or lose its context (browsers cap live WebGL contexts, which
    // split panes + many tabs can exhaust). Both cases fall back to the DOM renderer.
    this.tryLoadWebgl()
    this.wireClipboard(el)
  }

  private tryLoadWebgl(): void {
    // GPU rendering is on by default, but some GPUs/drivers paint xterm's WebGL glyph
    // atlas without color — output renders monochrome even though the data and theme
    // carry color. The DOM renderer always colors correctly, so offer an escape hatch:
    // `?gpu=off` (or localStorage['podium:gpu']='off') skips WebGL and keeps DOM.
    if (!gpuEnabled()) return
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose()) // drop back to the DOM renderer
      this.term.loadAddon(webgl)
    } catch {
      // WebGL unavailable; the DOM renderer stays active
    }
  }

  write(text: string): void {
    if (this.disposed) return
    this.term.write(text)
  }

  clear(): void {
    if (this.disposed) return
    this.term.clear()
  }

  resize(cols: number, rows: number): void {
    // A resize that lands before the renderer has measured a cell can throw on an
    // undefined dimension; ignore it rather than break the caller's state handler.
    try {
      this.term.resize(cols, rows)
    } catch {
      // renderer not ready; the next fit/resize will reconcile geometry
    }
  }

  fit(): { cols: number; rows: number } {
    // Before the container has layout (or a cell can be measured) FitAddon throws on
    // an undefined render dimension. Treat that as "keep current grid" rather than
    // letting it crash the whole mount.
    try {
      this.fitAddon.fit()
    } catch {
      // dimensions not ready yet; caller keeps the current grid
    }
    return { cols: this.term.cols, rows: this.term.rows }
  }

  cols(): number {
    return this.term.cols
  }

  rows(): number {
    return this.term.rows
  }

  screenText(): string {
    const buf = this.term.buffer.active
    let text = ''
    for (let i = 0; i < buf.length; i += 1) {
      text += `${buf.getLine(i)?.translateToString(true) ?? ''}\n`
    }
    return text
  }

  screenHash(): string {
    const text = this.screenText()
    let h = 0x811c9dc5
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(16)
  }

  onData(cb: (data: string) => void): () => void {
    const sub = this.term.onData(cb)
    return () => sub.dispose()
  }

  focus(): void {
    this.term.focus()
  }

  hasSelection(): boolean {
    return this.term.hasSelection()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const off of this.cleanup.splice(0)) off()
    // term.open() schedules a deferred Viewport.syncScrollArea via setTimeout(0).
    // Disposing synchronously before that timer fires (rapid mount→unmount: a fast
    // tab switch, or React StrictMode's double-invoke) makes it read `dimensions`
    // on a torn-down renderer and throw an *uncaught* TypeError that wedges React's
    // effect flushing — the remounted pane then renders black and live updates
    // (e.g. the title stream) stop. Deferring our dispose by a macrotask lets
    // xterm's earlier-scheduled timer run first (timers are FIFO), so it always
    // sees a live terminal.
    const term = this.term
    setTimeout(() => term.dispose(), 0)
  }

  /**
   * Only COPY needs explicit wiring. A selection in the xterm grid is canvas
   * state, not a DOM selection, so the browser's Cmd+C can't see it — we read it
   * off the terminal and write it to the clipboard ourselves.
   *
   * PASTE is deliberately NOT handled here. xterm's helper textarea already
   * receives the browser `paste` event and inserts the data itself (bracketed
   * when the app enabled mode 2004), needing no clipboard-read permission. If we
   * also intercept Cmd+V/Ctrl+Shift+V and call `readText()`, two pastes fire: the
   * native one, then a second permission-prompted one on top — a visible
   * double-paste (only unmasked once the origin became https; on http `readText`
   * silently returned '' so the bug hid). So paste keys and middle-click fall
   * through to xterm. Mobile tap-to-paste has no native paste event and goes
   * through requestPaste() instead.
   *
   *  - select with the mouse → copy (Linux PRIMARY-style), so "select then paste
   *    elsewhere" just works;
   *  - Cmd+C / Ctrl+Shift+C copies the current selection.
   * Plain Ctrl+C is left alone so it still sends SIGINT to the agent.
   */
  private wireClipboard(el: HTMLElement): void {
    const copySelection = (): void => {
      const text = this.term.getSelection()
      if (text) void writeClipboard(text)
    }

    const onMouseUp = (): void => {
      if (this.term.hasSelection()) copySelection()
    }
    el.addEventListener('mouseup', onMouseUp)
    this.cleanup.push(() => el.removeEventListener('mouseup', onMouseUp))

    this.term.attachCustomKeyEventHandler((ev): boolean => {
      if (ev.type !== 'keydown') return true
      const mod = ev.metaKey || ev.ctrlKey
      const key = ev.key.toLowerCase()
      // Copy: Cmd+C (mac) or Ctrl/Cmd+Shift+C, only when there is a selection.
      if (mod && key === 'c' && (ev.metaKey || ev.shiftKey) && this.term.hasSelection()) {
        copySelection()
        return false
      }
      // Paste and everything else are left to xterm / the browser (see above).
      return true
    })
  }

  /** Insert text at the prompt as if pasted — honors the app's bracketed-paste
   *  mode (xterm only wraps in ESC[200~…ESC[201~ when the app enabled it), so a
   *  multi-line paste lands as one block in a shell and one message in an agent. */
  pasteText(text: string): void {
    if (text) this.term.paste(text)
  }

  /**
   * Paste invoked by a tap (the mobile key-bar) rather than a keyboard shortcut.
   * Preferred path is the async Clipboard API, which needs a secure context
   * (https) plus a user gesture — both hold when the key-bar button is tapped
   * over the https origin. On a non-secure origin (the plain-http fallback port)
   * or when the read is blocked, fall back to a focused capture field: the
   * browser still delivers the clipboard via the `paste` event's clipboardData
   * there, which the async API cannot reach.
   */
  async requestPaste(): Promise<void> {
    const text = await readClipboard()
    if (text) {
      this.pasteText(text)
      return
    }
    this.openPasteCapture()
  }

  /** Fallback paste UI: a focused overlay textarea the user long-presses → Paste
   *  into. Reads from the `paste` event (works without the async Clipboard API),
   *  forwards to the terminal, and dismisses. Escape / backdrop / blur cancels. */
  private openPasteCapture(): void {
    const doc = this.host?.ownerDocument ?? (typeof document !== 'undefined' ? document : null)
    if (!doc?.body) return

    const backdrop = doc.createElement('div')
    backdrop.setAttribute('role', 'dialog')
    backdrop.setAttribute('aria-label', 'Paste into the terminal')
    backdrop.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' +
      'justify-content:center;padding:24px;background:rgba(0,0,0,0.55)'

    const box = doc.createElement('div')
    box.style.cssText =
      'display:flex;flex-direction:column;gap:8px;width:100%;max-width:520px;' +
      'padding:14px;border-radius:12px;background:#16161c;border:1px solid #3a3a46;' +
      'box-shadow:0 12px 40px rgba(0,0,0,0.5)'

    const hint = doc.createElement('div')
    hint.textContent = 'Long-press the box, tap Paste (or type, then Enter)'
    hint.style.cssText = 'font:13px ui-sans-serif,system-ui,sans-serif;color:#9a9aa6'

    const ta = doc.createElement('textarea')
    ta.setAttribute('aria-label', 'Paste target')
    ta.placeholder = 'Paste here…'
    ta.rows = 3
    ta.style.cssText =
      'width:100%;resize:none;padding:10px;border-radius:8px;border:1px solid #3a3a46;' +
      'background:#0e0e12;color:#d7d7e0;font:13px ui-monospace,monospace'

    let done = false
    const close = (): void => {
      if (done) return
      done = true
      backdrop.remove()
      this.focus()
    }
    const commit = (text: string): void => {
      if (text) this.pasteText(text)
      close()
    }
    ta.addEventListener('paste', (e) => {
      const text = (e as ClipboardEvent).clipboardData?.getData('text') ?? ''
      if (text) {
        e.preventDefault()
        commit(text)
      }
    })
    ta.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent
      if (ke.key === 'Escape') close()
      // Enter (no shift) commits typed/IME-inserted text when no clean paste event fired.
      if (ke.key === 'Enter' && !ke.shiftKey) {
        e.preventDefault()
        commit(ta.value)
      }
    })
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close()
    })

    box.append(hint, ta)
    backdrop.append(box)
    doc.body.append(backdrop)
    ta.focus()
  }
}

/** WebGL (GPU) rendering is on by default. Disable it with `?gpu=off` in the URL or
 *  `localStorage['podium:gpu'] = 'off'` when a GPU/driver renders the WebGL atlas without
 *  color. Guarded so it is a safe no-op (returns true) outside a browser, e.g. in tests. */
function gpuEnabled(): boolean {
  try {
    const loc = (globalThis as { location?: { search?: string } }).location
    if (loc?.search && new URLSearchParams(loc.search).get('gpu') === 'off') return false
    if ((globalThis as { localStorage?: Storage }).localStorage?.getItem('podium:gpu') === 'off') {
      return false
    }
  } catch {
    // no DOM (tests / SSR) — leave GPU rendering enabled
  }
  return true
}

async function writeClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // fall through to the execCommand path (e.g. non-secure context / no permission)
  }
  legacyCopy(text)
}

async function readClipboard(): Promise<string> {
  try {
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText()
  } catch {
    // clipboard read unavailable (non-secure context); caller relies on native paste
  }
  return ''
}

/** Clipboard API needs a secure context; over plain http (e.g. a Tailscale host) it is
 *  absent, so fall back to a throwaway textarea + execCommand inside the user gesture. */
function legacyCopy(text: string): void {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  } catch {
    // nothing else we can do
  }
}
