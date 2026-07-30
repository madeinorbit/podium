import type { AgentRuntimeState, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { UiState } from '../replica/replica'
import {
  audibleCondition,
  type NotificationCue,
  NotificationSounder,
  SOUNDS_ENABLED_KEY,
} from './notification-sounds'

const SINCE = '2026-07-01T01:00:00.000Z'

const working = (): AgentRuntimeState => ({
  phase: 'working',
  since: SINCE,
  nativeSubagentCount: 0,
})

const idleDone = (): AgentRuntimeState => ({
  phase: 'idle',
  since: SINCE,
  nativeSubagentCount: 0,
  idle: { kind: 'done' },
})

const needsUser = (kind: 'question' | 'permission'): AgentRuntimeState => ({
  phase: 'needs_user',
  since: SINCE,
  nativeSubagentCount: 0,
  need: { kind, summary: 'Need a decision' },
})

const errored = (): AgentRuntimeState => ({
  phase: 'errored',
  since: SINCE,
  nativeSubagentCount: 0,
  error: { class: 'api', retryable: true },
})

function meta(over: Partial<SessionMeta> & { sessionId: string }): SessionMeta {
  const { sessionId, ...rest } = over
  return {
    sessionId,
    agentKind: 'claude-code',
    title: 'task',
    cwd: '/repo',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
    ...rest,
  }
}

function memoryUi(initial: Record<string, string> = {}): UiState {
  const data = new Map(Object.entries(initial))
  return {
    get: (k) => data.get(k) ?? null,
    set: (k, v) => {
      if (v === null) data.delete(k)
      else data.set(k, v)
    },
  } as UiState
}

interface Harness {
  sounder: NotificationSounder
  played: NotificationCue[]
  clock: { now: number }
  ui: UiState
  focused: { value: boolean }
  visible: string[]
  owner: { value: string | null }
}

function harness(over: { visible?: string[]; focused?: boolean } = {}): Harness {
  const played: NotificationCue[] = []
  const clock = { now: 1_000_000 }
  const ui = memoryUi()
  const focused = { value: over.focused ?? false }
  const visible = over.visible ?? []
  const owner: { value: string | null } = { value: null }
  const sounder = new NotificationSounder({
    ui,
    visibleSessionIds: () => visible,
    windowFocused: () => focused.value,
    playCue: (cue) => played.push(cue),
    now: () => clock.now,
    readOwner: () => owner.value,
    writeOwner: (id) => {
      owner.value = id
    },
  })
  return { sounder, played, clock, ui, focused, visible, owner }
}

describe('audibleCondition', () => {
  it('maps runtime states to cues', () => {
    expect(audibleCondition(meta({ sessionId: 's', agentState: idleDone() }))).toBe('done')
    expect(audibleCondition(meta({ sessionId: 's', agentState: needsUser('question') }))).toBe(
      'question',
    )
    expect(audibleCondition(meta({ sessionId: 's', agentState: needsUser('permission') }))).toBe(
      'approval',
    )
    expect(audibleCondition(meta({ sessionId: 's', agentState: errored() }))).toBe('error')
    expect(audibleCondition(meta({ sessionId: 's', agentState: working() }))).toBeNull()
    expect(audibleCondition(meta({ sessionId: 's' }))).toBeNull()
  })

  it('stays silent for shells, headless sessions, archived rows, and interruptions', () => {
    expect(
      audibleCondition(meta({ sessionId: 's', agentKind: 'shell', agentState: idleDone() })),
    ).toBeNull()
    expect(
      audibleCondition(meta({ sessionId: 's', headless: true, agentState: idleDone() })),
    ).toBeNull()
    expect(
      audibleCondition(meta({ sessionId: 's', archived: true, agentState: idleDone() })),
    ).toBeNull()
    expect(
      audibleCondition(
        meta({
          sessionId: 's',
          agentState: {
            phase: 'idle',
            since: SINCE,
            nativeSubagentCount: 0,
            idle: { kind: 'interrupted' },
          },
        }),
      ),
    ).toBeNull()
  })
})

describe('NotificationSounder', () => {
  it('plays only on a live transition, not on first sight or re-broadcast', () => {
    const h = harness()
    // First sight of an already-done session: silence (reload must not chorus).
    h.sounder.onSessions([meta({ sessionId: 'a', agentState: idleDone() })])
    expect(h.played).toEqual([])
    // Working → done is a real transition.
    h.sounder.onSessions([meta({ sessionId: 'a', agentState: working() })])
    h.sounder.onSessions([meta({ sessionId: 'a', agentState: idleDone() })])
    expect(h.played).toEqual(['done'])
    // Same state again: no repeat.
    h.sounder.onSessions([meta({ sessionId: 'a', agentState: idleDone() })])
    expect(h.played).toEqual(['done'])
  })

  it('suppresses the session being watched in a focused window, but not others', () => {
    const h = harness({ visible: ['a'], focused: true })
    h.sounder.onSessions([
      meta({ sessionId: 'a', agentState: working() }),
      meta({ sessionId: 'b', agentState: working() }),
    ])
    h.sounder.onSessions([
      meta({ sessionId: 'a', agentState: idleDone() }),
      meta({ sessionId: 'b', agentState: needsUser('permission') }),
    ])
    expect(h.played).toEqual(['approval'])
    // Unfocused window: the watched session audibly finishes too.
    const h2 = harness({ visible: ['a'], focused: false })
    h2.sounder.onSessions([meta({ sessionId: 'a', agentState: working() })])
    h2.sounder.onSessions([meta({ sessionId: 'a', agentState: idleDone() })])
    expect(h2.played).toEqual(['done'])
  })

  it('honors the device-local kill switch', () => {
    const h = harness()
    h.ui.set(SOUNDS_ENABLED_KEY, 'false')
    h.sounder.onSessions([meta({ sessionId: 'a', agentState: working() })])
    h.sounder.onSessions([meta({ sessionId: 'a', agentState: idleDone() })])
    expect(h.played).toEqual([])
  })

  it('yields to a more recently focused same-origin window', () => {
    const h = harness()
    h.owner.value = 'some-other-window'
    h.sounder.onSessions([meta({ sessionId: 'a', agentState: working() })])
    h.sounder.onSessions([meta({ sessionId: 'a', agentState: idleDone() })])
    expect(h.played).toEqual([])
  })

  it('throttles a burst and coalesces to the highest-priority cue', async () => {
    const h = harness()
    h.sounder.onSessions([
      meta({ sessionId: 'a', agentState: working() }),
      meta({ sessionId: 'b', agentState: working() }),
      meta({ sessionId: 'c', agentState: working() }),
    ])
    h.sounder.onSessions([
      meta({ sessionId: 'a', agentState: idleDone() }),
      meta({ sessionId: 'b', agentState: idleDone() }),
      meta({ sessionId: 'c', agentState: errored() }),
    ])
    // First cue immediate; the other two coalesce to the error cue.
    expect(h.played).toEqual(['done'])
    await new Promise((r) => setTimeout(r, 2100))
    expect(h.played).toEqual(['done', 'error'])
  })

  it('re-arms a session that left the list and returned', () => {
    const h = harness()
    h.sounder.onSessions([meta({ sessionId: 'a', agentState: working() })])
    h.sounder.onSessions([])
    // Back, already done: that's first sight again, so silence.
    h.sounder.onSessions([meta({ sessionId: 'a', agentState: idleDone() })])
    expect(h.played).toEqual([])
  })
})
