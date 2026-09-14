/**
 * DONE WHEN 4 REGRESSION — reopening at a DIFFERENT size than the bytes were
 * produced at (POD-3918 P1b).
 *
 * The four reported symptoms (half-drawn views, a lone input box, wrong line
 * widths, a spinner painted in the wrong place) are all one bug: stale bytes
 * drawn at a size the program never drew them at. For an alternate screen the
 * fix is never the model alone — the size goes FIRST and the program's own
 * repaint at the new size is what renders correctly. For a normal screen the
 * bytes are replayed into a model at their PRODUCED size and the model is
 * resized to the viewer's size, so the emulator reflows instead of rewrapping
 * from scratch.
 *
 * The emulator truths below pin the mechanism; the wiring that delivers it
 * (no stale replay + resize-before-repaint) is pinned in
 * session-redraw-policy.test.ts and terminal-reopen.test.ts, and the snapshot
 * framing assertion at the bottom fails until the fix lands.
 */

import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { snapshotFirstFrame } from './session-screens'

const flush = (term: Terminal): Promise<void> =>
  new Promise<void>((resolve) => term.write('', () => resolve()))

function screenAt(cols: number, rows = 24): Terminal {
  return new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 })
}

function rendered(term: Terminal): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = 0; i < buf.length; i += 1) out.push(buf.getLine(i)?.translateToString(true) ?? '')
  return out
}

const boxAt = (cols: number, label: string): string =>
  `\x1b[?1049h\x1b[H+${'-'.repeat(cols - 2)}+\r\n|${label.padEnd(cols - 2)}|\r\n+${'-'.repeat(cols - 2)}+`

describe('reopening at a different size (DONE WHEN 4)', () => {
  it('stale alternate bytes replayed at the new size do NOT render the new layout', async () => {
    const producedAt80 = boxAt(80, 'eighty-wide TUI')
    const staleViewer = screenAt(40)
    staleViewer.write(producedAt80)
    await flush(staleViewer)

    const repaintedViewer = screenAt(40)
    repaintedViewer.write(boxAt(40, 'forty-wide TUI'))
    await flush(repaintedViewer)

    // The stale replay shreds the box across the narrower grid; only the
    // program's own repaint at 40 draws the 40-wide frame.
    expect(rendered(staleViewer).slice(0, 3)).not.toEqual(rendered(repaintedViewer).slice(0, 3))
    expect(rendered(repaintedViewer).slice(0, 3)).toEqual([
      `+${'-'.repeat(38)}+`,
      `|${'forty-wide TUI'.padEnd(38)}|`,
      `+${'-'.repeat(38)}+`,
    ])
  })

  it('normal bytes replayed directly at the new width wrap differently from the original', async () => {
    // Cursor-addressed status line: painted at col 70, which exists at 80.
    const produced = 'job started\r\n\x1b[3;70H* done\r\n'
    const naive = screenAt(40)
    naive.write(produced)
    await flush(naive)

    const held = screenAt(80)
    held.write(produced)
    await flush(held)

    // Direct replay clamps the marker into the narrow grid; the produced
    // screen held it at column 70.
    expect(rendered(naive)[2]).not.toBe(rendered(held)[2])
    expect(rendered(held)[2]).toBe(`${' '.repeat(69)}* done`)
  })

  it('normal bytes replayed at their PRODUCED size then resized reflow through the emulator', async () => {
    const produced = 'job started\r\n\x1b[3;70H* done\r\n'
    const model = screenAt(80)
    model.write(produced)
    await flush(model)
    const before = rendered(model)
    model.resize(40, 24)
    await flush(model)
    const after = rendered(model)
    // The mechanism the normal-screen policy rests on: the SAME bytes, the
    // SAME emulator, resized — never bytes replayed straight at 40.
    expect(before[2]).toBe(`${' '.repeat(69)}* done`)
    expect(after).not.toEqual(before)
  })

  it('the alternate snapshot frame paints the model lines on a fresh viewer', async () => {
    const modelLines = [
      `+${'-'.repeat(38)}+`,
      `|${'forty-wide TUI'.padEnd(38)}|`,
      `+${'-'.repeat(38)}+`,
    ]
    const viewer = screenAt(40)
    viewer.write(snapshotFirstFrame('alternate', modelLines))
    await flush(viewer)
    expect(rendered(viewer).slice(0, 3)).toEqual(modelLines)
    expect(viewer.buffer.active.type).toBe('alternate')
  })
})
