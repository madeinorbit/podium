import { asSessionId, type TranscriptItem } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildChatRows, pairToolResults, type ToolBatchRow } from './chat'
import { ToolBatchView } from './ToolBatchView'

// The work line (POD-364): a run of tool calls is one progress object. Live it
// names the call in flight and counts up; settled it summarizes. What must never
// regress: a failure stays visible on the COLLAPSED row, and the count is always
// on the row so the operator can see how much happened without unfolding.

let host: HTMLDivElement
let root: Root

const call = (over: Partial<TranscriptItem> & { id: string }): TranscriptItem => ({
  role: 'tool',
  text: '',
  toolName: 'Read',
  ...over,
})

function batchOf(items: TranscriptItem[]): ToolBatchRow {
  const rows = buildChatRows(pairToolResults(items))
  const row = rows[0]
  if (!row || row.kind !== 'tools') throw new Error('expected a tools row')
  return row
}

function mount(row: ToolBatchRow, live = false): void {
  act(() => {
    root.render(
      <ToolBatchView
        row={row}
        index={0}
        highlighted={false}
        dimmed={false}
        forceOpen={false}
        live={live}
        sessionId={asSessionId('s1')}
        cwd="/r"
        openFile={() => {}}
      />,
    )
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('ToolBatchView — the work line', () => {
  it('names the call in flight and counts up while live', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-08-03T10:00:07.000Z'))
    mount(
      batchOf([
        call({ id: 'a', ts: '2026-08-03T10:00:00.000Z' }),
        call({
          id: 'b',
          toolName: 'Edit',
          toolPaths: ['/r/apps/web/src/ChatView.tsx'],
          ts: '2026-08-03T10:00:05.000Z',
        }),
      ]),
      true,
    )
    const line = host.querySelector('[data-testid="work-line"]')!
    expect(line.getAttribute('data-state')).toBe('live')
    expect(line.querySelector('.work-line-phrase')?.textContent).toBe('Editing ChatView.tsx')
    expect(line.querySelector('.work-line-count')?.textContent).toBe('2')
    // Counted from the FIRST call, not the latest one.
    expect(line.querySelector('.work-line-time')?.textContent).toBe('0:07')
  })

  it('summarizes the run once it settles, with no live timer', () => {
    mount(
      batchOf([
        call({ id: 'a', ts: '2026-08-03T10:00:00.000Z' }),
        call({ id: 'b', toolName: 'Bash', ts: '2026-08-03T10:00:09.000Z' }),
      ]),
    )
    const line = host.querySelector('[data-testid="work-line"]')!
    expect(line.getAttribute('data-state')).toBe('done')
    expect(line.querySelector('.work-line-phrase')?.textContent).toBe('Read a file, ran a command')
    expect(line.querySelector('.work-line-time')?.textContent).toBe('0:09')
  })

  it('keeps a failure on the collapsed row', () => {
    mount(
      batchOf([
        call({ id: 'a', toolUseId: 'u1' }),
        call({ id: 'a-res', toolUseId: 'u1', toolResult: 'ok' }),
        call({ id: 'b', toolName: 'Bash', toolUseId: 'u2' }),
        call({ id: 'b-res', toolUseId: 'u2', toolResult: 'Error: exit code 1' }),
      ]),
    )
    const line = host.querySelector('[data-testid="work-line"]')!
    expect(line.getAttribute('data-open')).toBe('false')
    expect(line.querySelector('.work-line-fail')?.textContent).toContain('1 failed')
    expect(line.querySelector('.work-line-glyph')?.className).toContain('work-line-glyph--err')
  })

  it('unfolds the individual calls on click', () => {
    mount(batchOf([call({ id: 'a' }), call({ id: 'b', toolName: 'Bash', toolInput: 'ls -la' })]))
    const line = host.querySelector('[data-testid="work-line"]')!
    expect(line.querySelector('.work-line-list')).toBeNull()
    act(() => {
      line.querySelector<HTMLButtonElement>('.work-line-row')!.click()
    })
    expect(line.getAttribute('data-open')).toBe('true')
    expect(line.querySelectorAll('.work-line-list .tool-row')).toHaveLength(2)
  })

  it('drops the fanned deck for a lone call — nothing is folded behind it', () => {
    mount(batchOf([call({ id: 'a' })]))
    expect(host.querySelector('[data-testid="work-line"]')?.getAttribute('data-single')).toBe(
      'true',
    )
  })

  it('shows no timer at all when the transcript carries no timestamps', () => {
    mount(batchOf([call({ id: 'a' }), call({ id: 'b' })]))
    expect(host.querySelector('.work-line-time')).toBeNull()
  })
})
