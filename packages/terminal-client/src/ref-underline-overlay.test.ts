// @vitest-environment happy-dom
import { ALL_ISSUE_STATUSES, type IssueStatus } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { BufferLike, Cell } from './buffer-line'
import {
  mentionRects,
  REF_STATUS_ACCENT,
  RefUnderlineOverlay,
  refStatusAccent,
  type ViewportBufferLike,
} from './ref-underline-overlay'

/** Build a row of unstyled cells from a string. */
function cells(text: string, y = 0): Cell[] {
  return [...text].map((char, x) => ({ char, x, y, styled: false }))
}

const known = (p: string): boolean => p === 'POD' || p === 'WEB'

describe('mentionRects', () => {
  it('positions one rect per mention in cell geometry', () => {
    const rows = [cells('no refs here'), cells('see POD-13 now', 1)]
    const rects = mentionRects(rows, known, 8, 17)
    expect(rects).toEqual([
      { left: 4 * 8, top: 1 * 17, width: 6 * 8, height: 17, ref: 'POD-13', status: null },
    ])
  })

  it('handles multiple mentions and skips unknown prefixes', () => {
    const rows = [cells('POD-1 UTF-8 WEB-22')]
    const rects = mentionRects(rows, known, 10, 20)
    expect(rects).toEqual([
      { left: 0, top: 0, width: 5 * 10, height: 20, ref: 'POD-1', status: null },
      { left: 12 * 10, top: 0, width: 6 * 10, height: 20, ref: 'WEB-22', status: null },
    ])
  })

  it('attaches resolved stages when a resolver is supplied', () => {
    const rows = [cells('POD-1 and WEB-22')]
    const stages: Record<string, IssueStatus> = { 'POD-1': 'in_progress', 'WEB-22': 'done' }
    const rects = mentionRects(rows, known, 8, 17, (ref) => stages[ref] ?? null)
    expect(rects.map((r) => [r.ref, r.status])).toEqual([
      ['POD-1', 'in_progress'],
      ['WEB-22', 'done'],
    ])
  })

  it('uses real buffer columns, so wide glyphs earlier in the row keep rects aligned', () => {
    // '漢' occupies columns 0-1; its spacer cell is already dropped, so the
    // token's cells carry x=3.. — the rect must come from x, not array index.
    const row: Cell[] = [
      { char: '漢', x: 0, y: 0, styled: false },
      { char: ' ', x: 2, y: 0, styled: false },
      ...[...'POD-7'].map((char, i) => ({ char, x: 3 + i, y: 0, styled: false })),
    ]
    const rects = mentionRects([row], known, 8, 17)
    expect(rects).toEqual([
      { left: 3 * 8, top: 0, width: 5 * 8, height: 17, ref: 'POD-7', status: null },
    ])
  })

  it('returns nothing for empty rows', () => {
    expect(mentionRects([[], []], known, 8, 17)).toEqual([])
  })
})

describe('refStatusAccent', () => {
  it('maps every status to a non-default accent', () => {
    for (const status of Object.keys(REF_STATUS_ACCENT) as IssueStatus[]) {
      expect(refStatusAccent(status)).toBe(REF_STATUS_ACCENT[status])
    }
    expect(refStatusAccent(null)).toContain('--muted-foreground')
    expect(refStatusAccent(undefined)).toContain('--muted-foreground')
  })

  it('never paints an unknown ref in the brand accent', () => {
    // A ref the client cannot resolve must not borrow --primary: beside the
    // status colours it reads as a state rather than as "no state known".
    expect(refStatusAccent(null)).not.toContain('--primary')
  })

  it('keeps in-progress on the shared blue channel, not obligation amber', () => {
    expect(refStatusAccent('in_progress')).toBe('rgb(59, 130, 246)')
    expect(refStatusAccent('in_progress')).not.toContain('245, 158, 11')
  })
})

// Fake buffer over rows of plain strings, including translateToString so the
// overlay's cheap per-row pre-filter is exercised.
function fakeBuf(rows: string[], viewportY = 0): ViewportBufferLike {
  const buf: BufferLike & { viewportY: number } = {
    viewportY,
    getLine(y: number) {
      const s = rows[y]
      if (s === undefined) return undefined
      return {
        length: s.length,
        isWrapped: false,
        translateToString: () => s,
        getCell(x: number) {
          if (x >= s.length) return undefined
          return {
            getChars: () => s[x] ?? ' ',
            getWidth: () => 1,
            isBold: () => false,
            isUnderline: () => false,
            getFgColor: () => -1,
            getFgColorMode: () => 0,
          }
        },
      }
    },
  }
  return buf
}

function makeOverlay(
  rows: string[],
  prefix: ((p: string) => boolean) | null = known,
  resolveStatus?: (ref: string) => IssueStatus | null | undefined,
  boundary?: { beginPaint(): void; endPaint(): void },
) {
  const screen = document.createElement('div')
  document.body.appendChild(screen)
  // happy-dom has no layout; give the screen a measured size (80×24 grid at 8×17).
  screen.getBoundingClientRect = () =>
    ({ width: 640, height: 408, left: 0, top: 0, right: 640, bottom: 408 }) as DOMRect
  const overlay = new RefUnderlineOverlay({
    screen,
    getBuffer: () => fakeBuf(rows),
    getCols: () => 80,
    getRows: () => 24,
    getIsKnownPrefix: () => prefix,
    getResolveStatus: () => resolveStatus ?? null,
    ...boundary,
  })
  return { screen, overlay }
}

const visibleRects = (screen: HTMLElement): HTMLElement[] =>
  [...screen.querySelectorAll<HTMLElement>('.podium-ref-underlines > div')].filter(
    (el) => el.style.display !== 'none',
  )

describe('RefUnderlineOverlay', () => {
  it('repaints a pooled decoration through every status without retaining a green closed outcome', () => {
    let status: IssueStatus | null = null
    const { screen, overlay } = makeOverlay(['POD-1'], known, () => status)
    try {
      for (const value of ALL_ISSUE_STATUSES) {
        status = value
        overlay.refreshNow()
        const el = visibleRects(screen)[0]
        expect(el?.dataset.issueStatus).toBe(value)
        expect(el?.style.getPropertyValue('--ref-accent')).toBe(REF_STATUS_ACCENT[value])
        expect(el?.style.getPropertyValue('--ref-accent').includes('--success')).toBe(
          value === 'done',
        )
        expect(screen.querySelectorAll('.podium-ref-underlines > div')).toHaveLength(1)
      }
      status = null
      overlay.refreshNow()
      expect(visibleRects(screen)[0]?.dataset.issueStatus).toBeUndefined()
    } finally {
      overlay.dispose()
      screen.remove()
    }
  })
  it('ends each viewport demand even with no visible rows or a failed status read', () => {
    const events: string[] = []
    const rows = ['POD-1']
    let fail = false
    const { screen, overlay } = makeOverlay(
      rows,
      known,
      () => {
        if (fail) throw new Error('status failed')
        return 'review'
      },
      { beginPaint: () => events.push('begin'), endPaint: () => events.push('end') },
    )
    overlay.refreshNow()
    rows.splice(0, rows.length, 'plain output')
    overlay.refreshNow()
    rows.splice(0, rows.length, 'POD-2')
    fail = true
    expect(() => overlay.refreshNow()).toThrow('status failed')
    screen.getBoundingClientRect = () => ({ width: 0, height: 0 }) as DOMRect
    overlay.refreshNow()
    expect(events).toEqual(['begin', 'end', 'begin', 'end', 'begin', 'end', 'begin', 'end'])
    overlay.dispose()
    overlay.refreshNow()
    expect(events).toHaveLength(8)
  })
  it('draws pooled underline divs for visible mentions and hides them when gone', () => {
    const rows = ['see POD-13 now', 'and WEB-2']
    const { screen, overlay } = makeOverlay(rows)
    overlay.refreshNow()
    const shown = visibleRects(screen)
    expect(shown).toHaveLength(2)
    expect(shown[0]?.style.left).toBe(`${4 * 8}px`)
    expect(shown[0]?.style.width).toBe(`${6 * 8}px`)
    expect(shown[1]?.style.top).toBe('17px')

    // Mentions scroll away → the SAME pooled nodes are hidden, not destroyed.
    rows.splice(0, rows.length, 'plain output')
    overlay.refreshNow()
    expect(visibleRects(screen)).toHaveLength(0)
    expect(screen.querySelectorAll('.podium-ref-underlines > div')).toHaveLength(2)
    overlay.dispose()
  })

  it('stays empty while ref links are unconfigured', () => {
    const { screen, overlay } = makeOverlay(['see POD-13 now'], null)
    overlay.refreshNow()
    expect(visibleRects(screen)).toHaveLength(0)
    overlay.dispose()
  })

  it('dispose removes the layer', () => {
    const { screen, overlay } = makeOverlay(['POD-1'])
    overlay.refreshNow()
    expect(screen.querySelector('.podium-ref-underlines')).toBeTruthy()
    overlay.dispose()
    expect(screen.querySelector('.podium-ref-underlines')).toBeNull()
  })

  it('paints status colour and dashed backlog underline from the live resolver', () => {
    const stages: Record<string, IssueStatus> = {
      'POD-13': 'in_progress',
      'WEB-2': 'backlog',
    }
    const { screen, overlay } = makeOverlay(
      ['see POD-13 now', 'and WEB-2'],
      known,
      (ref) => stages[ref] ?? null,
    )
    overlay.refreshNow()
    const shown = visibleRects(screen)
    expect(shown).toHaveLength(2)
    expect(shown[0]?.dataset.ref).toBe('POD-13')
    expect(shown[0]?.dataset.issueStatus).toBe('in_progress')
    expect(shown[0]?.style.getPropertyValue('--ref-accent')).toBe(REF_STATUS_ACCENT.in_progress)
    expect(shown[0]?.style.borderBottomStyle).toBe('solid')
    expect(shown[1]?.dataset.issueStatus).toBe('backlog')
    expect(shown[1]?.style.getPropertyValue('--ref-accent')).toBe(REF_STATUS_ACCENT.backlog)
    expect(shown[1]?.style.borderBottomStyle).toBe('dashed')
    overlay.dispose()
  })

  it('paints an unresolved ref in the muted default accent', () => {
    const { screen, overlay } = makeOverlay(['POD-1'], known, () => null)
    overlay.refreshNow()
    const el = visibleRects(screen)[0]
    expect(el?.dataset.issueStatus).toBeUndefined()
    expect(el?.style.getPropertyValue('--ref-accent')).toContain('--muted-foreground')
    expect(el?.style.borderBottomStyle).toBe('solid')
    overlay.dispose()
  })
})
