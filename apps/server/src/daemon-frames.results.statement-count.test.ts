/**
 * A daemon's `*Result` frames run a fixed number of statements, whatever the
 * number of sessions on the server, of requests in flight, or of items in the
 * reply [POD-6227, server-data rule 8].
 *
 * Most replies settle a request through the one correlator
 * (`modules/daemon-request.ts`): an in-memory map, so the frame itself runs no
 * statement, and what the awaiting caller does next is the caller's operation,
 * not the frame's. They are pinned together, each settling a real pending
 * request. The replies with a handler of their own (a repo scan's discovery,
 * an approval's execution, a kill receipt, a headless turn, an open-URL
 * answer) are pinned one by one.
 */
import { type IssueId, type MachineId, type SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { DAEMON_FRAME_PORTS } from './gateway/daemon-frame-routing'
import { DaemonRequestBroker, type DaemonRequestKind } from './modules/daemon-request'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import {
  describeGrowth,
  expectArmed,
  expectConstantStatements,
  measureAtSizes,
  quietShipping,
  type StatementPin,
  type StatementTally,
} from './test-support/statement-count'

interface Fixture {
  store: SessionStore
  reg: SessionRegistry
  ids: SessionId[]
  issueId: IssueId
  host: MachineId
}

/** `size` bound sessions, the first on an issue. */
async function fixture(size: number): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await attachHostDaemon(reg, () => {}, { repos: ['/repo'] })
  await quietShipping(reg)
  const host = store.hostMachineId
  const issue = await reg.issues.crud.create({ repoPath: '/repo', title: 'Results', startNow: false })
  const ids: SessionId[] = []
  for (let i = 0; i < size; i++) {
    const cwd = i === 0 ? '/repo/w' : `/other/w${i}`
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd,
      ...(i === 0 ? { issueId: issue.id } : {}),
    })
    await reg.gateway.routeDaemonFrame(host, {
      type: 'bind',
      sessionId,
      cmd: 'sh',
      cwd,
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    } as never)
    ids.push(sessionId)
  }
  await settle(reg)
  return { store, reg, ids, issueId: issue.id, host }
}

async function settle(reg: SessionRegistry): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  await reg.modules.sessions.flushBroadcasts()
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
}

const route = async (f: Fixture, frame: unknown) => {
  await f.reg.gateway.routeDaemonFrame(f.host, frame as never)
  await settle(f.reg)
}

const pin = <F extends Fixture>(
  name: string,
  setup: (size: number) => Promise<F>,
  run: (f: F, size: number) => Promise<unknown>,
  check?: (f: F, size: number) => Promise<void> | void,
): StatementPin<F> => ({
  name,
  setup,
  target: (f) => f.store,
  run,
  ...(check ? { check: async (_result: unknown, f: F, size: number) => await check(f, size) } : {}),
  teardown: async (f) => {
    await f.reg.dispose()
    await f.store.close()
  },
})

/** Plant a read per session of the fixture in front of the gateway's frame router. */
const plantPerSession = (f: Fixture): (() => void) => {
  const original = f.reg.gateway.routeDaemonFrame.bind(f.reg.gateway)
  const spy = vi.spyOn(f.reg.gateway, 'routeDaemonFrame').mockImplementation(async (...args) => {
    for (const id of f.ids) await f.store.sessions.getSession(id)
    return await original(...args)
  })
  return () => spy.mockRestore()
}

/** The reply frames whose only work is settling a request through the correlator. */
const BROKER_SETTLED = (Object.keys(DAEMON_FRAME_PORTS) as DaemonMessage['type'][]).filter((type) => {
  const ports = DAEMON_FRAME_PORTS[type] as readonly string[]
  return (
    type !== 'scanResult' &&
    (ports.every((port) => port === 'rpc') ||
      ['memoryBreakdownResult', 'reclaimDiskEstimateResult', 'transcriptMirrorResult'].includes(type))
  )
})

interface Pending extends Fixture {
  /** Per reply type: the id of the request it settles, and whether it did. */
  requests: Map<string, { requestId: string; settled: Promise<boolean> }>
}

/**
 * The broker's request family for each reply type, learned by routing the
 * reply once for an id nobody asked for (the settle is dropped), then one
 * real pending request per type, and `size` more of the first family in
 * flight beside them.
 */
async function pending(size: number): Promise<Pending> {
  const f = await fixture(size)
  const settles = vi.spyOn(DaemonRequestBroker.prototype, 'settle')
  const kinds = new Map<string, { broker: DaemonRequestBroker; kind: DaemonRequestKind<unknown> }>()
  try {
    for (const type of BROKER_SETTLED) {
      settles.mockClear()
      await f.reg.gateway.routeDaemonFrame(f.host, { type, requestId: 'nobody-asked' } as never)
      const call = settles.mock.calls[0]
      if (!call) throw new Error(`${type} did not settle through the correlator`)
      kinds.set(type, { broker: settles.mock.contexts[0] as DaemonRequestBroker, kind: call[0] as DaemonRequestKind<unknown> })
    }
  } finally {
    settles.mockRestore()
  }
  const requests = new Map<string, { requestId: string; settled: Promise<boolean> }>()
  const ask = (broker: DaemonRequestBroker, kind: DaemonRequestKind<unknown>) => {
    let requestId = ''
    const settled = broker
      .request({
        kind,
        timeoutMs: 60_000,
        onTimeout: () => 'timed out',
        build: (id) => {
          requestId = id
          return { type: 'pod6227Probe', requestId: id } as never
        },
        machineId: f.host,
      })
      .then((value) => value !== 'timed out')
    return { get requestId() { return requestId }, settled }
  }
  for (const [type, { broker, kind }] of kinds) requests.set(type, ask(broker, kind))
  const [first] = kinds.values()
  for (let i = 0; i < size; i++) void ask(first!.broker, first!.kind)
  await settle(f.reg)
  return { ...f, requests }
}

describe('daemon *Result frames: pinned statement counts at 5 and 200', () => {
  const settled = pin(
    `${BROKER_SETTLED.length} correlated replies`,
    pending,
    async (f) => {
      for (const [type, request] of f.requests) {
        await f.reg.gateway.routeDaemonFrame(f.host, { type, requestId: request.requestId } as never)
      }
      await settle(f.reg)
    },
    async (f) => {
      for (const [type, request] of f.requests) expect(await request.settled, type).toBe(true)
    },
  )

  it('every reply that only settles a request runs no statement', async () => {
    expect(BROKER_SETTLED.length).toBeGreaterThan(40)
    await expectConstantStatements(settled, 0)
  })

  it('correlated replies pin is armed', async () => {
    await expectArmed(settled, 0, plantPerSession)
  })

  const conversations = (size: number) =>
    Array.from({ length: size }, (_, i) => ({
      id: `native-${i}`,
      agentKind: 'codex',
      providerId: 'codex',
      title: `Conversation ${i}`,
      projectPath: '/repo',
      path: `/home/u/.codex/sessions/rollout-${i}.jsonl`,
      sizeBytes: 100 + i,
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:00:00.000Z',
      messageCount: i,
    }))

  const scan = (rescan: boolean) =>
    pin(
      `scanResult (${rescan ? 'known' : 'new'} conversations)`,
      async (size) => {
        const f = await fixture(size)
        if (rescan) await route(f, { type: 'scanResult', requestId: 'r-first', conversations: conversations(size), diagnostics: [] })
        return f
      },
      async (f, size) =>
        await route(f, { type: 'scanResult', requestId: 'r-unasked', conversations: conversations(size), diagnostics: [] }),
      async (f, size) => {
        expect(await f.store.conversations.registry.podiumIds(f.host, conversations(size).map((c) => c.id))).toHaveProperty('size', size)
      },
    )

  // POD-6227 registers a report's conversations in batches (one read, then one
  // write per kind of write), where it read and wrote each one. What still
  // grows is the change log's own write: a commit upserts change_latest once
  // per change (`SyncRepository`, sync behaviour, POD-6228), and appends to
  // `changes` 100 rows a statement (the log's bound on bound values). This pin
  // counts those two exactly and holds every other statement constant.
  it('scanResult that discovers as many new conversations as the size', async () => {
    const counts = await measureAtSizes(scan(false))
    const matching = (tally: StatementTally, pattern: RegExp) =>
      [...tally.byQuery].reduce((n, [key, count]) => (pattern.test(key) ? n + count : n), 0)
    const latest = (tally: StatementTally) => matching(tally, /^insert into "change_latest"/i)
    const appended = (tally: StatementTally) => matching(tally, /^insert into "changes"/i)
    const detail = describeGrowth(counts.small, counts.large)
    expect([latest(counts.small), appended(counts.small)], detail).toEqual([5, 1])
    expect([latest(counts.large), appended(counts.large)], detail).toEqual([200, 2])
    for (const tally of [counts.small, counts.large]) {
      expect(tally.statements - latest(tally) - appended(tally), detail).toBe(8)
    }
  })

  // A report of conversations the server knows writes nothing: every row is
  // unchanged, so no change is appended either.
  it('scanResult that reports as many known conversations as the size', async () => {
    await expectConstantStatements(scan(true), 5)
  })

  // The same discovery path, on the frame a daemon's watcher sends whenever its
  // corpus changes; it re-offers every conversation it holds.
  it('conversationsChanged that re-offers as many known conversations as the size', async () => {
    await expectConstantStatements(
      {
        ...scan(true),
        name: 'conversationsChanged (known conversations)',
        run: async (f, size) =>
          await route(f, { type: 'conversationsChanged', conversations: conversations(size), diagnostics: [] }),
      },
      5,
    )
  })

  it('scanResult pin is armed', async () => {
    await expectArmed(scan(true), 5, plantPerSession)
  })

  interface Approval extends Fixture {
    approvalId: string
  }

  const approval = pin<Approval>(
    'approvalExecResult',
    async (size) => {
      const f = await fixture(size)
      const { id } = await f.reg.modules.approvals.request({
        op: { kind: 'update' },
        sessionId: f.ids[0],
        machineId: f.host,
      })
      await f.reg.modules.approvals.approve(id)
      await settle(f.reg)
      return { ...f, approvalId: id }
    },
    async (f) =>
      await route(f, { type: 'approvalExecResult', requestId: f.approvalId, ok: true, exitCode: 0, output: 'updated' }),
    async (f) => {
      expect((await f.reg.modules.approvals.get({ id: f.approvalId })).status).toBe('succeeded')
    },
  )

  // The transition, its event, the issue notice (a mail to the issue) and the
  // approvals broadcast.
  it('approvalExecResult of a session on an issue', async () => {
    await expectConstantStatements(approval, 19)
  })

  it('approvalExecResult pin is armed', async () => {
    await expectArmed(approval, 19, plantPerSession)
  })

  it('sessionKillResult that confirms the kill', async () => {
    await expectConstantStatements(
      pin('sessionKillResult (killed)', fixture, async (f) =>
        await route(f, { type: 'sessionKillResult', sessionId: f.ids[0], killed: true })),
      0,
    )
  })

  it('headlessTurnResult and headlessBindResult', async () => {
    await expectConstantStatements(
      pin('headless results', fixture, async (f) => {
        await route(f, { type: 'headlessTurnResult', requestId: 'h1', ok: true })
        await route(f, { type: 'headlessBindResult', requestId: 'h2', ok: true })
      }),
      0,
    )
  })

  it('sessionOpenUrlResult nobody is waiting for', async () => {
    await expectConstantStatements(
      pin('sessionOpenUrlResult', fixture, async (f) =>
        await route(f, { type: 'sessionOpenUrlResult', sessionId: f.ids[0], requestId: 'o1', status: 'opened' })),
      0,
    )
  })
})

