import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { type ITheme, Terminal } from '@xterm/xterm'
import { type FileLinkConfig, makeFileLinkProvider } from './file-link-provider'
import { makeUrlLinkProvider } from './url-link-provider'
// xterm renders its rows, cursor, selection overlay and the hidden char-measure /
// helper-textarea elements relative to styles in this sheet. Without it the measure
// element renders visibly (a stray row of `$`/`-`), the selection overlay detaches
// from the grid, the helper textarea sits in the layout (breaking focus + paste), and
// FitAddon cannot measure a cell. Importing it here keeps the component self-contained.
import '@xterm/xterm/css/xterm.css'

/** The user-tunable rendering options — settable at construction and at runtime
 *  via {@link TerminalView.setAppearance} (no remount, no PTY restart). */
export interface TerminalAppearance {
  fontSize?: number
  fontFamily?: string
  /** Multiplier on the cell height (xterm semantics, >= 1). Values much above
   *  ~1.2 open visible gaps in box-drawing borders (agent TUI frames). */
  lineHeight?: number
  theme?: ITheme
}

export interface TerminalViewOptions extends TerminalAppearance {
  cols?: number
  rows?: number
}

export const DEFAULT_FONT_SIZE = 13
export const DEFAULT_LINE_HEIGHT = 1.15

// A terminal in a proportional font is unreadable and misaligns box-drawing. Pin a
// monospace stack that resolves to a real mono font on every platform.
const MONO_STACK =
  "'Geist Mono Variable', ui-monospace, 'SF Mono', 'JetBrains Mono', 'Fira Code', Menlo, 'Cascadia Code', 'DejaVu Sans Mono', Consolas, monospace"

// Palette aligned with the app's design tokens (see apps/web styles.css).
// Exported so callers overriding a single slot (e.g. the background) can merge
// over the full default palette instead of re-declaring it.
export const DEFAULT_THEME: ITheme = {
  background: '#0e0e12',
  foreground: '#d7d7e0',
  cursor: '#D97757',
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

/** Open an external URL in a new tab / the system browser. In installed PWAs,
 *  `window.open(..., '_blank')` is the most reliable handoff to the browser app
 *  (iOS Safari in particular); fall back to an anchor click only if it is blocked. */
function openExternalUrl(uri: string): void {
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    const opened = window.open(uri, '_blank')
    if (opened) {
      try {
        opened.opener = null
      } catch {
        // Some browser WindowProxy implementations reject opener writes.
      }
      return
    }
  }
  if (typeof document === 'undefined') return
  const a = document.createElement('a')
  a.href = uri
  a.target = '_blank'
  a.rel = 'noopener noreferrer external'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export class TerminalView {
  private readonly term: Terminal
  private readonly fitAddon: FitAddon
  private readonly cleanup: Array<() => void> = []
  private disposed = false
  private host: HTMLElement | null = null
  // The live onData sink, kept so synthetic input (e.g. the Shift+Enter newline
  // we substitute below) flows through the exact same path as real keystrokes.
  private dataSink: ((data: string) => void) | undefined
  private fileLinkConfig: FileLinkConfig | null = null
  // The live WebGL renderer addon (undefined when GPU is off, WebGL is unavailable, or
  // after a context loss dropped us to the DOM renderer). Kept so reloadWebgl() can
  // recreate it to recover a discarded canvas.
  private webgl: WebglAddon | undefined

  constructor(opts: TerminalViewOptions = {}) {
    this.term = new Terminal({
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      scrollback: 5000,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: opts.fontSize ?? DEFAULT_FONT_SIZE,
      fontFamily: opts.fontFamily ?? MONO_STACK,
      fontWeight: 400,
      fontWeightBold: 600,
      lineHeight: opts.lineHeight ?? DEFAULT_LINE_HEIGHT,
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
    // Clickable URLs across single-line, SOFT (reflow) and HARD (agent hang-indent)
    // wraps — replaces WebLinksAddon, which only stitched soft wraps so a Claude-wrapped
    // URL was clickable on its first row only. Opens with window.open('_blank') from the
    // click gesture so installed PWAs hand off to the browser instead of replacing Podium.
    this.term.registerLinkProvider(
      makeUrlLinkProvider(
        () => this.term.buffer.active as unknown as import('./buffer-line').BufferLike,
        () => ({ onOpen: openExternalUrl }),
      ),
    )
    // File-path link provider: styled, path-like runs that resolve to a known
    // transcript path or a cwd-relative path become clickable. Caller configures
    // this by calling setFileLinks(); until then the provider is a no-op.
    this.term.registerLinkProvider(
      makeFileLinkProvider(
        () => this.term.buffer.active as unknown as import('./buffer-line').BufferLike,
        () => this.fileLinkConfig,
      ),
    )
  }

  /** Configure (or clear) clickable file-path links. Highlighted, path-like runs
   *  that resolve to a known path or a path under cwd become clickable. */
  setFileLinks(cfg: FileLinkConfig | null): void {
    this.fileLinkConfig = cfg
  }

  /**
   * Apply appearance changes to the live terminal. xterm applies option writes
   * immediately; a font-metric change (size/family/lineHeight) alters the cell
   * size, so the CALLER must re-fit afterwards (mountSession's setAppearance
   * does) — otherwise the grid no longer matches the container. Undefined
   * fields reset to the defaults, so passing a partial object is a full
   * "set the appearance to exactly this" operation, not a merge.
   */
  setAppearance(a: TerminalAppearance): void {
    if (this.disposed) return
    this.term.options.fontSize = a.fontSize ?? DEFAULT_FONT_SIZE
    this.term.options.fontFamily = a.fontFamily ?? MONO_STACK
    this.term.options.lineHeight = a.lineHeight ?? DEFAULT_LINE_HEIGHT
    this.term.options.theme = a.theme ?? DEFAULT_THEME
    this.forceRepaint()
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
      webgl.onContextLoss(() => {
        webgl.dispose() // drop back to the DOM renderer
        if (this.webgl === webgl) this.webgl = undefined
        // The lost GL canvas is blank. The DOM renderer that takes over is damage-based
        // and won't repaint cells it considers clean, so without forcing a full repaint
        // the screen stays black (showing only cells that change next) until new output.
        this.forceRepaint()
      })
      this.term.loadAddon(webgl)
      this.webgl = webgl
    } catch {
      // WebGL unavailable; the DOM renderer stays active
      this.webgl = undefined
    }
  }

  /**
   * Recover the screen after the panel was hidden with `display:none`: the browser
   * frees the WebGL canvas's backing store, so on reveal only damage-painted cells show
   * and the rest is black. A plain refresh can't repaint a discarded GL surface — recreate
   * the renderer instead. Disposing + reloading the WebGL addon gives a fresh GL context +
   * glyph atlas and a full render of xterm's buffer. Call this AFTER the panel is visible
   * and laid out (e.g. on the next animation frame) so the new renderer measures the real
   * canvas size. Falls back to a plain repaint when GPU rendering is off / unavailable.
   */
  reloadWebgl(): void {
    if (this.disposed) return
    if (!gpuEnabled()) {
      this.forceRepaint()
      return
    }
    try {
      this.webgl?.dispose()
    } catch {
      // already disposed / mid-teardown
    }
    this.webgl = undefined
    this.tryLoadWebgl() // creates + loads a fresh WebglAddon (or stays DOM if unavailable)
    this.forceRepaint() // ensure a full redraw via whichever renderer is now active
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

  /**
   * Force a full repaint of the visible buffer. xterm's WebGL and DOM renderers are
   * damage-based: they only redraw cells that changed since the last frame. After the
   * canvas is hidden then revealed (a tab/panel switch), resized/reflowed, or a WebGL
   * context is lost, the GPU backing store can be blank while xterm still considers the
   * unchanged cells "clean" — so they render black until something overwrites them (the
   * "only the animated parts / only my typed text shows, rest is black" symptom). This
   * marks every visible row dirty so the next frame repaints the whole screen from the
   * local buffer, with no agent round-trip.
   */
  forceRepaint(): void {
    if (this.disposed) return
    try {
      this.term.refresh(0, this.term.rows - 1)
    } catch {
      // renderer not ready; the next frame will paint
    }
  }

  /**
   * Attempt to fit the terminal to the container. Returns the new grid on
   * success, or `undefined` when the container isn't measurable yet (hidden,
   * zero-size, or the FitAddon cell measure failed). The caller should retry
   * across rAFs rather than silently keeping a stale grid.
   */
  fit(): { cols: number; rows: number } | undefined {
    // proposeDimensions() returns undefined when the container clientWidth/Height
    // are zero or the cell-size helper element hasn't been measured yet.
    let dims: { cols: number; rows: number } | undefined
    try {
      dims = this.fitAddon.proposeDimensions()
    } catch {
      // FitAddon threw — container not ready
      return undefined
    }
    if (!dims || dims.cols < 2 || dims.rows < 2) return undefined
    try {
      this.fitAddon.fit()
    } catch {
      return undefined
    }
    return { cols: this.term.cols, rows: this.term.rows }
  }

  /**
   * True when the container element has non-zero layout dimensions — the
   * precondition for a successful `fit()`. Can be used as an early-out
   * before attempting a fit (and as an isolated unit-testable guard).
   */
  isFittable(): boolean {
    if (!this.host) return false
    return this.host.clientWidth > 0 && this.host.clientHeight > 0
  }

  cols(): number {
    return this.term.cols
  }

  rows(): number {
    return this.term.rows
  }

  /**
   * The visible screen as text. With `dropDim`, cells rendered dim (SGR 2 —
   * placeholder/hint text, e.g. Codex's greyed-out composer suggestions) are
   * blanked, so a caller scraping the prompt can't mistake a suggestion for
   * typed input. Default keeps the fast translateToString path.
   */
  screenText(opts?: { dropDim?: boolean }): string {
    const buf = this.term.buffer.active
    let text = ''
    for (let i = 0; i < buf.length; i += 1) {
      const line = buf.getLine(i)
      if (!opts?.dropDim || !line) {
        text += `${line?.translateToString(true) ?? ''}\n`
        continue
      }
      let row = ''
      for (let x = 0; x < line.length; x += 1) {
        const cell = line.getCell(x)
        if (!cell) continue
        if (cell.getWidth() === 0) continue // spacer half of a wide glyph
        const chars = cell.getChars() || ' '
        row += cell.isDim() ? ' '.repeat(chars.length) : chars
      }
      text += `${row.replace(/\s+$/, '')}\n`
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
    this.dataSink = cb
    const sub = this.term.onData((d) => this.dataSink?.(d))
    return () => {
      sub.dispose()
      this.dataSink = undefined
    }
  }

  focus(): void {
    this.term.focus()
  }

  /** Subscribe to viewport scroll changes — fires when the user scrolls back and
   *  when fresh output advances the tail. Returns an unsubscribe. */
  onScroll(cb: () => void): () => void {
    const sub = this.term.onScroll(() => cb())
    return () => sub.dispose()
  }

  /** True when the viewport is pinned to the latest output (nothing below the fold). */
  atBottom(): boolean {
    const buf = this.term.buffer.active
    return buf.viewportY >= buf.baseY
  }

  scrollToBottom(): void {
    this.term.scrollToBottom()
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
      // Shift+Enter must insert a newline, not submit. A browser sends a bare CR
      // for it (identical to Enter), which Claude Code reads as "send". Substitute
      // the Option+Enter sequence (ESC CR) — Claude Code's newline. Plain Enter
      // still submits; Cmd/Ctrl+Enter are left to the app.
      const shiftEnter =
        ev.key === 'Enter' && ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey
      // Cmd+Backspace must clear the line (macOS "delete to line start"). Substitute
      // Ctrl+U (0x15), the kill-line byte stock terminals send, which Claude Code
      // and readline both honor. Alt+Backspace (delete word) already works via
      // xterm's Meta handling.
      const cmdBackspace =
        ev.key === 'Backspace' && ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey
      if (shiftEnter || cmdBackspace) {
        // preventDefault is load-bearing: returning false only skips xterm's OWN
        // handling of THIS event. Without it the browser still runs the default
        // action — Shift+Enter fires a keypress and inserts a newline into xterm's
        // helper textarea, and xterm's keypress path emits a bare CR, which Claude
        // Code reads as submit right after our newline (the "shift-enter submits
        // anyway" bug; happy-dom fires no default actions, so only a real browser
        // shows it). Swallow keypress/keyup echoes of the chord too.
        if (ev.type === 'keydown') {
          ev.preventDefault()
          this.dataSink?.(shiftEnter ? '\x1b\r' : '\x15')
        }
        return false
      }
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
   *
   * Where the async Clipboard API exists (secure context + Chromium/WebKit), it IS
   * the paste path: the browser shows its one "allow paste" prompt, then the text
   * drops straight into the terminal. We deliberately do NOT also open the capture
   * field here — stacking a permission prompt and then a mini input was confusing
   * (and fired even when the read just came back empty). An empty clipboard or a
   * declined prompt simply pastes nothing; tap again.
   *
   * The capture field is only for browsers with no async clipboard read at all
   * (e.g. Firefox, or a plain-http origin): it reads the `paste` event's
   * clipboardData, which needs no permission — and since there's no prompt before
   * it, the two never stack.
   */
  async requestPaste(): Promise<void> {
    // Touch devices (iOS Safari especially) handle the async Clipboard API badly:
    // readText() forces a permission grant, dismisses the keyboard, then shows
    // iOS's own "Paste" button — so one tap can take three tries. Use the capture
    // field there instead: it reads the plain `paste` event, so iOS shows its
    // native paste callout on a real field directly, with NO clipboard-read
    // permission. Desktop keeps the one-shot Clipboard API (and Cmd+V is handled
    // natively by xterm anyway). typeof, not truthiness: the DOM lib types
    // readText as always-present, but it's undefined at runtime on Firefox / http.
    const coarsePointer =
      typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true
    if (!coarsePointer && typeof navigator.clipboard?.readText === 'function') {
      this.pasteText(await readClipboard())
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
    hint.textContent = 'Long-press the box → Paste'
    hint.style.cssText = 'font:13px ui-sans-serif,system-ui,sans-serif;color:#9a9aa6'

    const ta = doc.createElement('textarea')
    ta.setAttribute('aria-label', 'Paste target')
    ta.placeholder = 'Paste here…'
    // No virtual keyboard — this field exists only to receive a paste, so the
    // soft keyboard popping up would just be in the way. The long-press → Paste
    // callout still works on a focused editable field.
    ta.inputMode = 'none'
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
