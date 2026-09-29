/**
 * The reopen snapshot is the FINAL picture a returning viewer sees until the
 * program writes again (POD-4723, design rev 3 "Repaint"), so it must be a
 * faithful copy of the model: characters, colours, attributes and cursor.
 * POD-4848: it used to be plain text encoded latin1, so a return showed the
 * screen white on black with every code point above U+00FF mangled.
 */

import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { snapshotFirstFrame, TerminalScreen } from './terminal-screen.js'

const COLS = 40
const ROWS = 8

/** A coloured TUI frame: Claude's ⏵⏵ footer, a box, a wide CJK glyph, an emoji. */
const FRAME = [
  '\x1b[H\x1b[2J',
  '\x1b[38;5;214m╭────── box ──────╮\x1b[0m\r\n',
  '\x1b[38;5;214m│\x1b[0m \x1b[1;32m漢字\x1b[0m and \x1b[33m😀\x1b[0m \x1b[38;5;214m│\x1b[0m\r\n',
  '\x1b[38;5;214m╰─────────────────╯\x1b[0m\r\n',
  '\x1b[48;2;30;30;60m\x1b[38;2;200;120;255m⏵⏵ auto mode on\x1b[0m',
  '\x1b[5;3H',
].join('')

interface Cell {
  chars: string
  width: number
  fg: number
  fgMode: number
  bg: number
  bgMode: number
  bold: number
}

function cells(term: Terminal): Cell[][] {
  const buf = term.buffer.active
  const out: Cell[][] = []
  for (let y = 0; y < term.rows; y += 1) {
    const line = buf.getLine(buf.baseY + y)
    const row: Cell[] = []
    for (let x = 0; x < term.cols; x += 1) {
      const c = line?.getCell(x)
      if (!c) continue
      row.push({
        chars: c.getChars(),
        width: c.getWidth(),
        fg: c.getFgColor(),
        fgMode: c.getFgColorMode(),
        bg: c.getBgColor(),
        bgMode: c.getBgColorMode(),
        bold: c.isBold(),
      })
    }
    out.push(row)
  }
  return out
}

function write(term: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data as string, () => resolve()))
}

async function replay(
  mode: 'normal' | 'alternate',
): Promise<{ source: Terminal; viewer: Terminal; bytes: Buffer }> {
  const enter = mode === 'alternate' ? '\x1b[?1049h' : ''
  // The source of truth: a plain headless terminal fed the same bytes.
  const source = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 0 })
  await write(source, enter + FRAME)
  const screen = new TerminalScreen({ cols: COLS, rows: ROWS })
  screen.push(Buffer.from(enter + FRAME, 'utf8'))
  await screen.flush()
  const bytes = screen.snapshotFirstFrame()
  screen.dispose()
  // A fresh viewer, as a browser xterm would be on a return.
  const viewer = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 0 })
  await write(viewer, new Uint8Array(bytes))
  return { source, viewer, bytes }
}

describe('reopen snapshot is a faithful picture of the model (POD-4848)', () => {
  for (const mode of ['alternate', 'normal'] as const) {
    it(`${mode}: replayed into a fresh terminal, every cell matches — chars, colours, bold`, async () => {
      const { source, viewer } = await replay(mode)
      expect(viewer.buffer.active.type).toBe(mode)
      const want = cells(source)
      // Arm the comparison: the frame really carries what we claim it does.
      expect(want[3]?.slice(0, 2).map((c) => c.chars)).toEqual(['⏵', '⏵'])
      expect(want[3]?.[0]?.fgMode).not.toBe(0)
      expect(want[1]?.some((c) => c.chars === '漢' && c.width === 2 && c.bold)).toBe(true)
      expect(want[1]?.some((c) => c.chars === '😀')).toBe(true)
      expect(want[0]?.[0]?.chars).toBe('╭')
      expect(cells(viewer)).toEqual(want)
      expect([viewer.buffer.active.cursorX, viewer.buffer.active.cursorY]).toEqual([
        source.buffer.active.cursorX,
        source.buffer.active.cursorY,
      ])
      source.dispose()
      viewer.dispose()
    })
  }

  it('the snapshot bytes are valid UTF-8 and carry the non-latin1 glyphs', async () => {
    const { source, viewer, bytes } = await replay('alternate')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    for (const glyph of ['⏵⏵ auto mode on', '╭', '漢字', '😀']) expect(text).toContain(glyph)
    source.dispose()
    viewer.dispose()
  })

  it('never carries a mode or buffer switch beyond its own framing', async () => {
    const screen = new TerminalScreen({ cols: COLS, rows: ROWS })
    // A program that turned on mouse tracking, bracketed paste and app cursor keys.
    screen.push(
      Buffer.from('\x1b[?1049h\x1b[?1000h\x1b[?2004h\x1b[?1h\x1b]0;title\x07hello', 'utf8'),
    )
    await screen.flush()
    const text = screen.snapshotFirstFrame().toString('utf8')
    screen.dispose()
    expect(text.startsWith('\x1b[?1049l\x1b[?1049h')).toBe(true)
    const body = text.slice('\x1b[?1049l\x1b[?1049h'.length)
    // Only SGR, cursor moves and erases survive; no ?-mode, no OSC.
    expect(body).not.toContain('\x1b[?')
    expect(body).not.toContain('\x1b]')
    expect(body).toContain('hello')
  })

  it('the body keeps only paint: SGR, cursor moves, erases, text', () => {
    const body = 'a\x1b[?1000hb\x1b]0;t\x07c\x1b[31md\x1b[2Ce\x1b[3Xf\x07g\x1bPq\x1b[1;1Hh'
    const text = snapshotFirstFrame('normal', body).toString('utf8')
    expect(text).toBe('\x1b[m\x1b[2J\x1b[Habc\x1b[31md\x1b[2Ce\x1b[3Xfgqh')
  })
})
