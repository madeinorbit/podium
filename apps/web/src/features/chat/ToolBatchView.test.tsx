import { asSessionId, type TranscriptItem } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildChatRows, pairToolResults, type ToolBatchRow } from './chat'
import { ToolBatchView, WorkLinePreviewList } from './ToolBatchView'

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

// POD-423: what the fold still cost a reader — seeing WHICH calls it holds, and
// noticing WHEN a live run finished.
describe('ToolBatchView — the folded run’s preview', () => {
  it('drops the native title on a previewable row so two tooltips cannot race', () => {
    mount(batchOf([call({ id: 'a' }), call({ id: 'b' })]))
    expect(host.querySelector('.work-line-row')?.hasAttribute('title')).toBe(false)
  })

  it('keeps the native title on a lone call — there is no "which" to answer', () => {
    mount(batchOf([call({ id: 'a' })]))
    expect(host.querySelector('.work-line-row')?.getAttribute('title')).toBe('Read a file')
  })

  it('lists the calls the fold would reveal, naming each subject', () => {
    const row = batchOf([
      call({ id: 'a', toolPaths: ['/r/apps/web/src/ChatView.tsx'], toolTitle: 'ChatView' }),
      call({ id: 'b', toolName: 'Bash', toolInput: 'bun test', toolTitle: 'Run the tests' }),
    ])
    act(() => root.render(<WorkLinePreviewList blocks={row.blocks} />))
    const items = [...host.querySelectorAll('.work-line-preview-item')]
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('ChatView')
    // Bash names the COMMAND, not the agent's description of it — same rule the
    // unfolded row follows, because the preview must match what unfolding shows.
    expect(items[1]?.textContent).toContain('bun test')
    expect(items[1]?.textContent).not.toContain('Run the tests')
  })

  it('defers to the fold past a glanceable number of calls', () => {
    const row = batchOf(Array.from({ length: 12 }, (_, i) => call({ id: `c${i}` })))
    act(() => root.render(<WorkLinePreviewList blocks={row.blocks} />))
    expect(host.querySelectorAll('.work-line-preview-item')).toHaveLength(8)
    expect(host.querySelector('.work-line-preview-more')?.textContent).toContain('+4 more')
  })

  it('marks a failed call in the preview — the fold never hides a failure', () => {
    const row = batchOf([
      call({ id: 'a', toolUseId: 'u1' }),
      call({ id: 'a-res', toolUseId: 'u1', toolResult: 'ok' }),
      call({ id: 'b', toolName: 'Bash', toolUseId: 'u2' }),
      call({ id: 'b-res', toolUseId: 'u2', toolResult: 'Error: exit code 1' }),
    ])
    act(() => root.render(<WorkLinePreviewList blocks={row.blocks} />))
    expect(host.querySelectorAll('.work-line-preview-glyph--err')).toHaveLength(1)
  })
})

describe('ToolBatchView — the settle', () => {
  it('does not settle on mount — a transcript of finished runs replays nothing', () => {
    mount(batchOf([call({ id: 'a' }), call({ id: 'b' })]))
    expect(host.querySelector('[data-testid="work-line"]')?.hasAttribute('data-settle')).toBe(false)
  })

  it('plays one morph when a live run resolves, then holds still', () => {
    vi.useFakeTimers()
    const row = batchOf([call({ id: 'a' }), call({ id: 'b' })])
    mount(row, true)
    const line = (): Element => host.querySelector('[data-testid="work-line"]')!
    expect(line().hasAttribute('data-settle')).toBe(false)
    mount(row, false)
    expect(line().getAttribute('data-settle')).toBe('true')
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(line().hasAttribute('data-settle')).toBe(false)
  })
})
