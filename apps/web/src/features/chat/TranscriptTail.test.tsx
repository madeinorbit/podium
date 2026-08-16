import type { ChatActivity, ChatRow } from '@podium/client-core/viewmodels'
import type { SessionMeta, TranscriptItem } from '@podium/model'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TranscriptTail, trailingRunIsLive } from './TranscriptTail'

// THE TAIL (POD-376): one object, three weights. What this pins is which state
// the feed ends in, what figure that state is allowed to show, and that the two
// states which must not move (waiting, idle) carry no perpetual motion.

let host: HTMLDivElement
let root: Root

function mount(
  activity: ChatActivity | null,
  since?: string,
  session?: SessionMeta,
  lastRow?: ChatRow,
): void {
  act(() => {
    root.render(
      <TranscriptTail activity={activity} since={since} session={session} lastRow={lastRow} />,
    )
  })
}

const toolRow = (item: TranscriptItem): ChatRow =>
  ({ kind: 'tools', blocks: [{ item }], blockIndices: [0], title: 'Ran a tool' }) as ChatRow

const session = (agentState: SessionMeta['agentState']): SessionMeta =>
  ({ agentState }) as unknown as SessionMeta

const tail = (): HTMLElement | null => host.querySelector('[data-testid="feed-tail"]')
const figure = (): string | undefined => host.querySelector('.feed-tail-figure')?.textContent ?? ''

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-05T12:00:00Z'))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
  vi.useRealTimers()
})

/** An instant `ms` before the frozen clock. */
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString()

describe('TranscriptTail', () => {
  it('shows nothing when there is neither activity nor a last stop', () => {
    mount(null, undefined)
    expect(tail()).toBeNull()
  })

  it('counts a working turn on a live clock, in the live hue', () => {
    mount({ label: 'Working…', tone: 'working' }, ago(42_000))
    expect(tail()?.dataset.tail).toBe('working')
    expect(host.textContent).toContain('Working')
    // A live timer is the one figure that earns second precision.
    expect(figure()).toBe('0:42')
    // …and it is the one state licensed to move. At the END of the feed that
    // motion is the breath rather than the braille spinner (POD-993): the
    // spinner stays inside work lines and machine-voice rows.
    expect(host.querySelector('[data-testid="breathing-mark"]')).not.toBeNull()
  })

  it('breathes for just-sent transport, timerless even with an old session clock', () => {
    mount(
      { label: 'Sending', tone: 'idle', transient: 'just-sent' },
      '2024-01-01T00:00:00.000Z',
      session({
        phase: 'idle',
        since: '2024-01-01T00:00:00.000Z',
        nativeSubagentCount: 0,
      }),
    )
    // POD-993: the hand-off is already the turn as far as the reader is
    // concerned, so the mark moves the moment they press send — but nothing
    // counts, because transport is not agent computation.
    expect(tail()?.dataset.tail).toBe('sending')
    expect(host.textContent).toContain('Sending')
    expect(host.querySelector('.feed-tail-figure')).toBeNull()
    expect(host.querySelector('.spb')).toBeNull()
    expect(host.querySelector('[data-testid="breathing-mark"]')).not.toBeNull()
  })

  it('addresses the reader when the agent is waiting on them, and stays still', () => {
    mount({ label: 'needs answer', tone: 'attention' }, ago(130_000))
    expect(tail()?.dataset.tail).toBe('waiting')
    // The session-state phrase is rewritten for the person being asked.
    expect(host.textContent).toContain('Waiting for your answer')
    expect(figure()).toBe('2m')
    expect(host.querySelector('.spb')).toBeNull()
    // Not dimmed: a question waiting on the human must not recede.
    expect(tail()?.dataset.stale).toBeUndefined()
  })

  it('names the approval case as an approval', () => {
    mount({ label: 'needs permission', tone: 'attention' })
    expect(host.textContent).toContain('Waiting for your approval')
  })

  it('names an unresolved shell dependency and holds the glyph still', () => {
    const started = ago(92_000)
    mount(
      { label: 'Working…', tone: 'working' },
      undefined,
      session({ phase: 'working', since: ago(180_000), nativeSubagentCount: 0 }),
      toolRow({
        id: 'bash',
        role: 'tool',
        text: '',
        toolName: 'Bash',
        toolTitle: 'tests',
        toolInput: 'bun test',
        ts: started,
      } as TranscriptItem),
    )
    expect(tail()?.dataset.tail).toBe('wait')
    expect(host.textContent).toContain('Waiting on shell')
    expect(host.textContent).toContain('tests')
    expect(figure()).toBe('1:32')
    expect(host.querySelector('.spb')).toBeNull()
    expect(host.querySelector('.feed-tail-wait')).not.toBeNull()
  })

  it('names the subagent count and task subject without parser changes', () => {
    mount(
      { label: 'Working…', tone: 'working' },
      undefined,
      session({
        phase: 'working',
        since: ago(200_000),
        nativeSubagentCount: 2,
        awaitingSubagents: true,
      }),
      toolRow({
        id: 'task',
        role: 'tool',
        text: '',
        toolName: 'Task',
        toolTitle: 'design audit',
        ts: ago(191_000),
      } as TranscriptItem),
    )
    expect(host.textContent).toContain('Waiting on 2 agents')
    expect(host.textContent).toContain('design audit')
  })

  it('recognizes namespaced Codex shell and subagent wait tools', () => {
    const base = { id: 'wait', role: 'tool', text: '', ts: ago(12_000) } as TranscriptItem
    const active = { label: 'Working…', tone: 'working' } as const

    mount(
      active,
      undefined,
      session({ phase: 'working', since: ago(20_000), nativeSubagentCount: 0 }),
      toolRow({ ...base, toolName: 'functions.exec_command', toolTitle: 'web tests' }),
    )
    expect(host.textContent).toContain('Waiting on shell')

    mount(
      active,
      undefined,
      session({ phase: 'working', since: ago(20_000), nativeSubagentCount: 1 }),
      toolRow({ ...base, toolName: 'collaboration.wait_agent', toolTitle: 'visual audit' }),
    )
    expect(host.textContent).toContain('Waiting on 1 agent')
  })

  it('composes interrupted and error stops instead of falling back to idle', () => {
    mount({ label: 'interrupted', tone: 'idle' }, ago(30_000))
    expect(tail()?.dataset.tail).toBe('interrupted')
    expect(host.textContent).toContain('Interrupted by you')

    mount({ label: 'error: rate_limit', tone: 'error' }, ago(30_000))
    expect(tail()?.dataset.tail).toBe('error')
    expect(host.textContent).toContain('Agent stopped with an error')
    expect(host.textContent).toContain('rate limit')
  })

  // NOTHING IS THE RIGHT ENDING (POD-993 round 3). There was an `idle` row here
  // — a dot, the word "Idle", and a clock counting since the last activity — and
  // it was the tail's MOST COMMON state, because most transcripts most of the
  // time are not doing anything. It read as a status worth reading and never
  // was: a conversation that has stopped is evident from having stopped.
  it('ends with nothing at all when nothing is happening', () => {
    mount(null, ago(17 * 60_000 + 39_000))
    expect(tail()).toBeNull()
    mount(null, ago(40_000))
    expect(tail()).toBeNull()
  })

  it('still speaks for the states that ARE news', () => {
    mount({ label: 'Working…', tone: 'working' }, ago(1000))
    expect(tail()?.getAttribute('aria-live')).toBe('polite')
    expect(tail()?.dataset.tail).toBe('working')
  })
})

// ONE LIVE OBJECT AT THE END OF A TURN (POD-747). The feed ended in two of them
// — a run spinning under the name of the call in flight, and a tail spinning
// under the name of the turn — so what this pins is the handover: while a call
// is in flight the RUN owns the ending, and the moment its result lands the tail
// takes the turn back so the thinking in between is still counted.
describe('trailingRunIsLive', () => {
  const working: ChatActivity = { label: 'Working…', tone: 'working' }
  const call = (toolResult?: string): TranscriptItem =>
    ({
      id: 't1',
      role: 'tool',
      toolName: 'Bash',
      ts: ago(3000),
      ...(toolResult === undefined ? {} : { toolResult }),
    }) as unknown as TranscriptItem

  it('is true while the trailing run has a call in flight', () => {
    expect(trailingRunIsLive(working, toolRow(call()))).toBe(true)
  })

  it('is false once that call has returned, so the tail counts the thinking', () => {
    expect(trailingRunIsLive(working, toolRow(call('done')))).toBe(false)
  })

  it('is false when the run has been overtaken by prose', () => {
    const prose = { kind: 'block', block: { item: { role: 'assistant' } } } as unknown as ChatRow
    expect(trailingRunIsLive(working, prose)).toBe(false)
  })

  it('is false when the session is not working at all', () => {
    expect(trailingRunIsLive(null, toolRow(call()))).toBe(false)
    expect(trailingRunIsLive({ label: 'needs answer', tone: 'attention' }, toolRow(call()))).toBe(
      false,
    )
  })
})
