import { FitAddon } from '@xterm/addon-fit'
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
      macOptionIsMeta: true,
      scrollSensitivity: 3,
      theme: opts.theme ?? DEFAULT_THEME,
    })
    this.fitAddon = new FitAddon()
    this.term.loadAddon(this.fitAddon)
  }

  mount(el: HTMLElement): void {
    this.term.open(el)
    this.wireClipboard(el)
  }

  write(text: string): void {
    this.term.write(text)
  }

  clear(): void {
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
    for (const off of this.cleanup.splice(0)) off()
    this.term.dispose()
  }

  /**
   * xterm captures the keyboard, so the browser's native copy/paste never reaches a
   * selection inside the grid. Wire it explicitly:
   *  - select with the mouse → copy (Linux PRIMARY-style, the behaviour a terminal
   *    user expects), so "select then paste elsewhere" just works;
   *  - Cmd+C / Ctrl+Shift+C copies the current selection;
   *  - Cmd+V / Ctrl+V / Ctrl+Shift+V and middle-click paste from the clipboard.
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

    // Middle-click paste (X11 convention).
    const onAuxClick = (ev: MouseEvent): void => {
      if (ev.button === 1) {
        ev.preventDefault()
        void this.paste()
      }
    }
    el.addEventListener('auxclick', onAuxClick)
    this.cleanup.push(() => el.removeEventListener('auxclick', onAuxClick))

    this.term.attachCustomKeyEventHandler((ev): boolean => {
      if (ev.type !== 'keydown') return true
      const mod = ev.metaKey || ev.ctrlKey
      const key = ev.key.toLowerCase()
      // Copy: Cmd+C (mac) or Ctrl/Cmd+Shift+C, only when there is a selection.
      if (mod && key === 'c' && (ev.metaKey || ev.shiftKey) && this.term.hasSelection()) {
        copySelection()
        return false
      }
      // Paste: Cmd+V or Ctrl/Cmd+Shift+V (plain Ctrl+V falls through to native paste).
      if (mod && key === 'v' && (ev.metaKey || ev.shiftKey)) {
        void this.paste()
        return false
      }
      return true
    })
  }

  private async paste(): Promise<void> {
    const text = await readClipboard()
    if (text) this.term.paste(text)
  }
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
