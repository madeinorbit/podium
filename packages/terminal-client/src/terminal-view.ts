import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'

export interface TerminalViewOptions {
  cols?: number
  rows?: number
}

export class TerminalView {
  private readonly term: Terminal
  private readonly fitAddon: FitAddon

  constructor(opts: TerminalViewOptions = {}) {
    this.term = new Terminal({
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      scrollback: 1000,
      convertEol: false,
    })
    this.fitAddon = new FitAddon()
    this.term.loadAddon(this.fitAddon)
  }

  mount(el: HTMLElement): void {
    this.term.open(el)
  }

  write(text: string): void {
    this.term.write(text)
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows)
  }

  fit(): { cols: number; rows: number } {
    this.fitAddon.fit()
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

  dispose(): void {
    this.term.dispose()
  }
}
