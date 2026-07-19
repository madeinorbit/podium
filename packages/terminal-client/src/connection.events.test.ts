import {
  createDispatcher,
  type DispatchHandlers,
  encode,
  type ServerMessage,
  type SessionMeta,
} from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { type SessionScopedServerMessage, SocketHub, type WebSocketLike } from './connection'

class FakeSocket implements WebSocketLike {
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.onclose?.({})
  }
  open(): void {
    this.onopen?.({})
  }
  recv(msg: ServerMessage): void {
    this.onmessage?.({ data: encode(msg) })
  }
}

function setup() {
  const sock = new FakeSocket()
  const hub = new SocketHub({
    url: 'ws://x',
    viewport: { cols: 80, rows: 24, dpr: 1 },
    makeSocket: () => sock,
  })
  return { sock, hub }
}

const meta = (sessionId: string): SessionMeta => ({
  sessionId,
  agentKind: 'claude-code',
  title: 't',
  cwd: '/w',
  status: 'live',
  controllerId: 'c0',
  geometry: { cols: 80, rows: 24 },
  epoch: 0,
  clientCount: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
  lastActiveAt: '2026-07-01T00:00:00.000Z',
  origin: { kind: 'spawn' },
  archived: false,
  readAt: null,
  unread: false,
})

// The hub's ServerMessage dispatch is compile-checked total [spec:SP-3fe2]:
// this table mirrors the shape connection.ts builds, and the @ts-expect-error
// cases prove that an unhandled union member cannot compile.
describe('SocketHub dispatch exhaustiveness (type-level)', () => {
  const noop = () => {}
  const total: DispatchHandlers<ServerMessage> = {
    approvalsChanged: noop,
    welcome: noop,
    pong: noop,
    attached: noop,
    outputFrame: noop,
    controllerChanged: noop,
    geometry: noop,
    agentExit: noop,
    sessionsChanged: noop,
    sessionViewDelta: noop,
    conversationsChanged: noop,
    automationsChanged: noop,
    automationRunsChanged: noop,
    sessionTitleChanged: noop,
    sessionAgentStateChanged: noop,
    sessionDraftChanged: noop,
    hostMetricsChanged: noop,
    machinesChanged: noop,
    worktreesChanged: noop,
    attentionEvent: noop,
    transcriptDelta: noop,
    issuesChanged: noop,
    issueUpdated: noop,
    metadataDelta: noop,
    headlessActivity: noop,
    sessionOpenUrl: noop,
    sessionOpenUrlResult: noop,
  }

  it('a mock future ServerMessage member without a handler fails compilation', () => {
    // A total table over today's union compiles…
    createDispatcher<ServerMessage>(total)
    type FutureServerMessage = ServerMessage | { type: 'mockFutureMessage'; payload: number }
    // @ts-expect-error …but the moment the union grows, the same table is rejected
    createDispatcher<FutureServerMessage>(total)
    expect(true).toBe(true)
  })

  it('dropping a handled member from the table fails compilation', () => {
    const { pong: _pong, ...missingPong } = total
    // @ts-expect-error a table missing 'pong' is not total over ServerMessage
    createDispatcher<ServerMessage>(missingPong)
    expect(true).toBe(true)
  })

  it('the session-scoped subunion is compile-checked total too', () => {
    const sessionTotal: DispatchHandlers<SessionScopedServerMessage> = {
      attached: noop,
      outputFrame: noop,
      controllerChanged: noop,
      geometry: noop,
      agentExit: noop,
    }
    createDispatcher<SessionScopedServerMessage>(sessionTotal)
    const { agentExit: _agentExit, ...missingExit } = sessionTotal
    // @ts-expect-error a table missing 'agentExit' is not total over the subunion
    createDispatcher<SessionScopedServerMessage>(missingExit)
    expect(true).toBe(true)
  })
})

describe('SocketHub subscription seam (on/emit)', () => {
  it('routes a metadata message through the seam to a legacy on* wrapper unchanged', () => {
    const { sock, hub } = setup()
    const viaWrapper: SessionMeta[][] = []
    const viaSeam: SessionMeta[][] = []
    hub.onSessions((s) => viaWrapper.push(s)) // legacy wrapper (replays immediately)
    hub.on('sessions', (s) => viaSeam.push(s)) // new seam (no replay)
    hub.connect()
    sock.open()
    const m = meta('s1')
    sock.recv({ type: 'sessionsChanged', sessions: [m] })
    // Wrapper: synchronous replay of the empty list + the update — timing unchanged.
    expect(viaWrapper).toEqual([[], [m]])
    // Seam: the update only, and the very same array the wrapper saw.
    expect(viaSeam).toEqual([[m]])
    expect(viaSeam[0]).toBe(viaWrapper[1])
    expect(viaSeam[0]).toBe(hub.sessions())
  })

  it('carries multi-argument payloads (sessionDraft) to legacy subscribers unchanged', () => {
    const { sock, hub } = setup()
    const legacy: Array<[string, string]> = []
    const seam: Array<[string, string]> = []
    hub.onSessionDraft((sessionId, text) => legacy.push([sessionId, text]))
    hub.on('sessionDraft', (sessionId, text) => seam.push([sessionId, text]))
    hub.connect()
    sock.open()
    sock.recv({ type: 'sessionDraftChanged', sessionId: 's1', text: 'draft…' })
    expect(legacy).toEqual([['s1', 'draft…']])
    expect(seam).toEqual([['s1', 'draft…']])
  })

  it('unsubscribe actually unsubscribes (seam and wrapper), and is idempotent', () => {
    const { sock, hub } = setup()
    const seam: number[] = []
    const wrapper: number[] = []
    const offSeam = hub.on('issues', (issues) => seam.push(issues.length))
    const offWrapper = hub.onIssues((issues) => wrapper.push(issues.length))
    hub.connect()
    sock.open()
    sock.recv({ type: 'issuesChanged', issues: [] })
    expect(seam).toEqual([0])
    expect(wrapper).toEqual([0, 0]) // replay + update
    offSeam()
    offSeam() // double-unsubscribe is a no-op
    offWrapper()
    sock.recv({ type: 'issuesChanged', issues: [] })
    expect(seam).toEqual([0])
    expect(wrapper).toEqual([0, 0])
  })

  it('unsubscribing one handler leaves other handlers of the same kind subscribed', () => {
    const { sock, hub } = setup()
    const a: number[] = []
    const b: number[] = []
    const offA = hub.on('machines', (m) => a.push(m.length))
    hub.on('machines', (m) => b.push(m.length))
    hub.connect()
    sock.open()
    offA()
    sock.recv({ type: 'machinesChanged', machines: [] })
    expect(a).toEqual([])
    expect(b).toEqual([0])
  })
})

describe('Codex review round (#261)', () => {
  it('subscribeHeadless dedups the same callback and one unsubscribe fully detaches it', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const seen: unknown[] = []
    const cb = (e: unknown) => seen.push(e)
    const un1 = hub.subscribeHeadless('s1', cb as never)
    const un2 = hub.subscribeHeadless('s1', cb as never)
    expect(un2).toBe(un1) // same registration → same unsubscribe
    sock.recv({
      type: 'headlessActivity',
      sessionId: 's1',
      event: { kind: 'turn-start' },
    } as unknown as ServerMessage)
    expect(seen).toHaveLength(1) // delivered once despite double registration
    un1()
    sock.recv({
      type: 'headlessActivity',
      sessionId: 's1',
      event: { kind: 'turn-start' },
    } as unknown as ServerMessage)
    expect(seen).toHaveLength(1) // fully detached
  })

  it('a handler registered during an emit starts with the NEXT event, one unsubscribed mid-emit is skipped', () => {
    const { sock, hub } = setup()
    hub.connect()
    sock.open()
    const late: unknown[] = []
    let skippedCalls = 0
    // First subscriber: registers a late handler and unsubscribes the third.
    let unThird: (() => void) | undefined
    hub.on('attention', () => {
      hub.on('attention', (e) => late.push(e))
      unThird?.()
    })
    unThird = hub.on('attention', () => {
      skippedCalls += 1
    })
    const fire = () =>
      sock.recv({
        type: 'attentionEvent',
        sessionId: 's1',
        title: 'needs you',
        body: 'b',
      } as unknown as ServerMessage)
    fire()
    expect(late).toHaveLength(0) // registration during emit: not the in-flight frame
    expect(skippedCalls).toBe(0) // unsubscribed during emit: skipped
    fire()
    expect(late).toHaveLength(1)
    expect(skippedCalls).toBe(0)
  })
})
