import { asSessionId } from '@podium/model'
import type { AgentRuntimeState, SessionId, SessionMeta, SessionMetaInput } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobxPool } from '../../../client-graph/src/pool'
import type { UiState } from '../replica/contract'
import {
  audibleCondition,
  type NotificationCue,
  createNotificationSounds,
  SOUNDS_ENABLED_KEY,
} from './notification-sounds'

const stops: (() => void)[] = []
afterEach(() => { for (const stop of stops.splice(0)) stop() })

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

function meta(over: Partial<SessionMeta> & { sessionId: SessionId }): SessionMeta {
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
  } as unknown as SessionMeta
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
  sounder: ReturnType<typeof createNotificationSounds>
  pool: MobxPool
  update: (sessions: SessionMeta[]) => void
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
  const pool = new MobxPool({ selectedIssueId: null, coarseNow: clock.now })
  const sounder = createNotificationSounds({
    phases: () => pool.sessionPhaseChanges.get(),
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
  sounder.start()
  stops.push(() => { sounder.stop(); pool.dispose() })
  const held = new Set<string>()
  const update = (sessions: SessionMeta[]) => {
    const next = new Set(sessions.map(s => s.sessionId as string))
    pool.apply({ type: 'update', rows: [
      ...sessions.map(s => ({ kind: 'session' as const, id: s.sessionId, value: s as never })),
      ...[...held].filter(id => !next.has(id)).map(id => ({ kind: 'session' as const, id, value: undefined })),
    ] })
    held.clear()
    for (const id of next) held.add(id)
  }
  return { sounder, pool, update, played, clock, ui, focused, visible, owner }
}

describe('audibleCondition', () => {
  it('maps runtime states to cues', () => {
    expect(audibleCondition(meta({ sessionId: asSessionId('s'), agentState: idleDone() }))).toBe('done')
    expect(audibleCondition(meta({ sessionId: asSessionId('s'), agentState: needsUser('question') }))).toBe(
      'question',
    )
    expect(audibleCondition(meta({ sessionId: asSessionId('s'), agentState: needsUser('permission') }))).toBe(
      'approval',
    )
    expect(audibleCondition(meta({ sessionId: asSessionId('s'), agentState: errored() }))).toBe('error')
    expect(audibleCondition(meta({ sessionId: asSessionId('s'), agentState: working() }))).toBeNull()
    expect(audibleCondition(meta({ sessionId: asSessionId('s') }))).toBeNull()
  })

  it('stays silent when a turn ends with open todos (POD-415)', () => {
    // The verdict says the agent's own list is unfinished — ordinary with a fleet
    // running, and not worth a cue in a room full of them. It sits with
    // 'interrupted' and bare idle, NOT with the question/approval sounds.
    expect(
      audibleCondition(
        meta({
          sessionId: asSessionId('s'),
          agentState: {
            phase: 'idle',
            since: SINCE,
            nativeSubagentCount: 0,
            idle: { kind: 'open_todos', summary: 'open todo list' },
          },
        }),
      ),
    ).toBeNull()
  })

  it('stays silent for shells, headless sessions, archived rows, and interruptions', () => {
    expect(
      audibleCondition(meta({ sessionId: asSessionId('s'), agentKind: 'shell', agentState: idleDone() })),
    ).toBeNull()
    expect(
      audibleCondition(meta({ sessionId: asSessionId('s'), headless: true, agentState: idleDone() })),
    ).toBeNull()
    expect(
      audibleCondition(meta({ sessionId: asSessionId('s'), archived: true, agentState: idleDone() })),
    ).toBeNull()
    expect(
      audibleCondition(
        meta({
          sessionId: asSessionId('s'),
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

describe('pool notification sounds', () => {
  it.each([32, 128])('handles only the changed phase among %s synced sessions', (count) => {
    const h = harness()
    const rows = Array.from({ length: count }, (_, i) => meta({ sessionId: asSessionId(String(i)), agentState: working() }))
    h.pool.apply({ type: 'replace', rows: rows.map(value => ({ kind: 'session', id: value.sessionId, value: value as never })) })
    expect(h.played).toEqual([])
    const baseline = h.pool.sessionPhaseChanges.get()
    h.pool.apply({ type: 'update', rows: [{ kind: 'session', id: '0', value: { ...rows[0], title: 'renamed' } as never }] })
    expect(h.pool.sessionPhaseChanges.get()).toBe(baseline)
    h.pool.apply({ type: 'update', rows: [{ kind: 'session', id: '0', value: { ...rows[0], agentState: idleDone() } as never }] })
    expect(h.pool.sessionPhaseChanges.get().map(change => change.sessionId)).toEqual(['0'])
    expect(h.played).toEqual(['done'])
    // Reconnect installs current truth silently, even if its condition moved.
    h.pool.apply({ type: 'replace', rows: rows.map(value => ({ kind: 'session', id: value.sessionId, value: { ...value, agentState: errored() } as never })) })
    expect(h.played).toEqual(['done'])
  })

  it('stops its reaction and cancels a pending burst before restarting silently', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const a = (agentState: AgentRuntimeState) => meta({ sessionId: asSessionId('a'), agentState })
      h.update([a(working())])
      h.update([a(idleDone())])
      h.update([a(errored())])
      h.sounder.stop()
      await vi.advanceTimersByTimeAsync(2100)
      expect(h.played).toEqual(['done'])
      h.update([a(needsUser('permission'))])
      h.sounder.start()
      expect(h.played).toEqual(['done'])
      h.update([a(working())])
      h.update([a(needsUser('question'))])
      expect(h.played).toEqual(['done', 'question'])
    } finally { vi.useRealTimers() }
  })

  it('handles an audible refinement within the same phase once', () => {
    const h = harness()
    h.update([meta({ sessionId: asSessionId('a'), agentState: { ...idleDone(), idle: undefined } })])
    h.update([meta({ sessionId: asSessionId('a'), agentState: idleDone() })])
    expect(h.played).toEqual(['done'])
    h.update([meta({ sessionId: asSessionId('a'), agentState: { ...idleDone(), idle: { kind: 'done', summary: 'Refined' } } })])
    expect(h.played).toEqual(['done'])
  })
  it('plays only on a live transition, not on first sight or re-broadcast', () => {
    const h = harness()
    // First sight of an already-done session: silence (reload must not chorus).
    h.update([meta({ sessionId: asSessionId('a'), agentState: idleDone() })])
    expect(h.played).toEqual([])
    // Working → done is a real transition.
    h.update([meta({ sessionId: asSessionId('a'), agentState: working() })])
    h.update([meta({ sessionId: asSessionId('a'), agentState: idleDone() })])
    expect(h.played).toEqual(['done'])
    // Same state again: no repeat.
    h.update([meta({ sessionId: asSessionId('a'), agentState: idleDone() })])
    expect(h.played).toEqual(['done'])
  })

  it('suppresses the session being watched in a focused window, but not others', () => {
    const h = harness({ visible: ['a'], focused: true })
    h.update([
      meta({ sessionId: asSessionId('a'), agentState: working() }),
      meta({ sessionId: asSessionId('b'), agentState: working() }),
    ])
    h.update([
      meta({ sessionId: asSessionId('a'), agentState: idleDone() }),
      meta({ sessionId: asSessionId('b'), agentState: needsUser('permission') }),
    ])
    expect(h.played).toEqual(['approval'])
    // Unfocused window: the watched session audibly finishes too.
    const h2 = harness({ visible: ['a'], focused: false })
    h2.update([meta({ sessionId: asSessionId('a'), agentState: working() })])
    h2.update([meta({ sessionId: asSessionId('a'), agentState: idleDone() })])
    expect(h2.played).toEqual(['done'])
  })

  it('honors the device-local kill switch', () => {
    const h = harness()
    h.ui.set(SOUNDS_ENABLED_KEY, 'false')
    h.update([meta({ sessionId: asSessionId('a'), agentState: working() })])
    h.update([meta({ sessionId: asSessionId('a'), agentState: idleDone() })])
    expect(h.played).toEqual([])
  })

  it('yields to a more recently focused same-origin window', () => {
    const h = harness()
    h.owner.value = 'some-other-window'
    h.update([meta({ sessionId: asSessionId('a'), agentState: working() })])
    h.update([meta({ sessionId: asSessionId('a'), agentState: idleDone() })])
    expect(h.played).toEqual([])
  })

  it('throttles a burst and coalesces to the highest-priority cue', async () => {
    const h = harness()
    h.update([
      meta({ sessionId: asSessionId('a'), agentState: working() }),
      meta({ sessionId: asSessionId('b'), agentState: working() }),
      meta({ sessionId: asSessionId('c'), agentState: working() }),
    ])
    h.update([
      meta({ sessionId: asSessionId('a'), agentState: idleDone() }),
      meta({ sessionId: asSessionId('b'), agentState: idleDone() }),
      meta({ sessionId: asSessionId('c'), agentState: errored() }),
    ])
    // First cue immediate; the other two coalesce to the error cue.
    expect(h.played).toEqual(['done'])
    await new Promise((r) => setTimeout(r, 2100))
    expect(h.played).toEqual(['done', 'error'])
  })

  it('re-arms a session that left the list and returned', () => {
    const h = harness()
    h.update([meta({ sessionId: asSessionId('a'), agentState: working() })])
    h.update([])
    // Back, already done: that's first sight again, so silence.
    h.update([meta({ sessionId: asSessionId('a'), agentState: idleDone() })])
    expect(h.played).toEqual([])
  })
})
