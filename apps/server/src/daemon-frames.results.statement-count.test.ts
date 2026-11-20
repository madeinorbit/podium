// POD-6789: two model-table builds replace the stored-copy comparison; source queue and registry writes publish atomically. Pins measured at both fixture sizes on the agents VM.
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
import type { IssueId, MachineId, SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { DAEMON_FRAME_PORTS } from './gateway/daemon-frame-routing'
import { DaemonRequestBroker, type DaemonRequestKind } from './modules/daemon-request'
import { SessionRegistry } from './relay'
import type { SessionStore } from './store'
import { decideApproval, fileApproval } from './test-support/approvals'
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
  settledCommand,
  settledOperation,
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
  // Pin one inbound frame, with no unrelated timer-driven ledger/queue/file
  // sweeps. On a remote engine those can otherwise overlap the counted window.
  const reg = await SessionRegistry.create(store, undefined, {
    instanceId: 'default',
    rehearseBoot: true,
  })
  await settledCommand(() => attachHostDaemon(reg, () => {}, { repos: ['/repo'] }))
  await quietShipping(reg)
  // Complete the normal startup cursor load explicitly; later frames still
  // exercise the live durable board projection and all of its statements.
  await reg.modules.sessions.runtimeGateway.replayBoardProjection()
  const host = store.hostMachineId
  const issue = await settledCommand(() =>
    reg.issues.crud.create(reg.issues.reports.store.serverWriter, {
      repoPath: '/repo',
      title: 'Results',
      startNow: false,
    }),
  )
  const ids: SessionId[] = []
  for (let i = 0; i < size; i++) {
    const cwd = i === 0 ? '/repo/w' : `/other/w${i}`
    const { sessionId } = await settledCommand(() =>
      reg.modules.sessions.createSession({
        agentKind: 'shell',
        cwd,
        ...(i === 0 ? { issueId: issue.id } : {}),
      }),
    )
    await settledOperation(() =>
      reg.gateway.routeDaemonFrame(host, {
        type: 'bind',
        sessionId,
        cmd: 'sh',
        cwd,
        agentKind: 'shell',
        geometry: { cols: 80, rows: 24 },
      } as never),
    )
    ids.push(sessionId)
  }
  await settle(reg)
  return { store, reg, ids, issueId: issue.id, host }
}

async function settle(reg: SessionRegistry): Promise<void> {
  await reg.changeLedger.authority.settled()
  await settledOperation(() => reg.modules.sessions.flushBroadcasts())
  await reg.changeLedger.authority.settled()
}

const route = async (f: Fixture, frame: unknown) => {
  await settledOperation(() => f.reg.gateway.routeDaemonFrame(f.host, frame as never))
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
const BROKER_SETTLED = (Object.keys(DAEMON_FRAME_PORTS) as DaemonMessage['type'][]).filter(
  (type) => {
    const ports = DAEMON_FRAME_PORTS[type] as readonly string[]
    return (
      type !== 'scanResult' &&
      // A loopback listener streams callbacks after its opening request has
      // settled. RPC owns that stream, but it is not a broker settlement.
      type !== 'oauthLoopbackCallback' &&
      (ports.every((port) => port === 'rpc') ||
        ['memoryBreakdownResult', 'reclaimDiskEstimateResult', 'transcriptMirrorResult'].includes(
          type,
        ))
    )
  },
)

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
      kinds.set(type, {
        broker: settles.mock.contexts[0] as DaemonRequestBroker,
        kind: call[0] as DaemonRequestKind<unknown>,
      })
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
    return {
      get requestId() {
        return requestId
      },
      settled,
    }
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
        await f.reg.gateway.routeDaemonFrame(f.host, {
          type,
          requestId: request.requestId,
        } as never)
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
        if (rescan)
          await route(f, {
            type: 'scanResult',
            requestId: 'r-first',
            conversations: conversations(size),
            diagnostics: [],
          })
        return f
      },
      async (f, size) =>
        await route(f, {
          type: 'scanResult',
          requestId: 'r-unasked',
          conversations: conversations(size),
          diagnostics: [],
        }),
      async (f, size) => {
        expect(
          await f.store.conversations.registry.podiumIds(
            f.host,
            conversations(size).map((c) => c.id),
          ),
        ).toHaveProperty('size', size)
      },
    )

  // Discovery has fixed work apart from the 100-row change-log INSERT chunks.
  // There is no per-record copy-table write (POD-6228 is superseded).
  it('scanResult that discovers as many new conversations as the size', async () => {
    const counts = await measureAtSizes(scan(false))
    const matching = (tally: StatementTally, pattern: RegExp) =>
      [...tally.byQuery].reduce((n, [key, count]) => (pattern.test(key) ? n + count : n), 0)
    const latest = (tally: StatementTally) => matching(tally, /^insert into "change_latest"/i)
    const appended = (tally: StatementTally) => matching(tally, /^insert into "changes"/i)
    const detail = describeGrowth(counts.small, counts.large)
    expect([latest(counts.small), appended(counts.small)], detail).toEqual([0, 1])
    expect([latest(counts.large), appended(counts.large)], detail).toEqual([0, 2])
    for (const tally of [counts.small, counts.large]) {
      expect(tally.statements - latest(tally) - appended(tally), detail).toBe(10)
    }
  })

  // A report of conversations the server knows writes nothing: every row is
  // unchanged, so no change is appended either.
  it('scanResult that reports as many known conversations as the size', async () => {
    // POD-6920: derived change capture (no build before the write; one drain
    // after it, the registry's writes inside the same commit): 6 -> 4.
    await expectConstantStatements(scan(true), 4)
  })

  // The same discovery path, on the frame a daemon's watcher sends whenever its
  // corpus changes; it re-offers every conversation it holds.
  it('conversationsChanged that re-offers as many known conversations as the size', async () => {
    await expectConstantStatements(
      {
        ...scan(true),
        name: 'conversationsChanged (known conversations)',
        run: async (f, size) =>
          await route(f, {
            type: 'conversationsChanged',
            conversations: conversations(size),
            diagnostics: [],
          }),
      },
      // POD-6920: derived change capture (no build before the write; one drain
      // after it, the registry's writes inside the same commit): 6 -> 4.
      4,
    )
  })

  it('scanResult pin is armed', async () => {
    await expectArmed(scan(true), 5, plantPerSession)
  })

  interface Approval extends Fixture {
    messagesBefore: number
    approvalId: string
  }

  const approval = pin<Approval>(
    'approvalExecResult',
    async (size) => {
      const f = await fixture(size)
      // This case owns an executing approval. Start that dispatcher explicitly
      // in the otherwise maintenance-free fixture; decideApproval awaits it.
      f.reg.modules.effects?.runner.start()
      const { id } = await settledCommand(() =>
        fileApproval(f.reg, {
          op: { kind: 'update' },
          sessionId: f.ids[0]!,
          machineId: f.host,
        }),
      )
      await settledCommand(() => decideApproval(f.reg, id))
      await settle(f.reg)
      const messagesBefore = (await f.store.issues.listIssueMessages(f.issueId)).length
      return { ...f, approvalId: id, messagesBefore }
    },
    async (f) =>
      await route(f, {
        type: 'approvalExecResult',
        requestId: f.approvalId,
        ok: true,
        exitCode: 0,
        output: 'updated',
      }),
    async (f) => {
      expect((await f.reg.modules.approvals.get({ id: f.approvalId })).status).toBe('succeeded')
      const notices = await f.store.issues.listIssueMessages(f.issueId)
      expect(notices).toHaveLength(f.messagesBefore + 1)
      expect(notices.at(-1)?.body).toBeTruthy()
    },
  )

  // The transition, its event, the issue notice (a mail to the issue) and the
  // approvals broadcast to connected members. POD-6218: the earliest admin in one statement: 19 -> 18.
  // POD-6229: the notice's apply-time check reads no machines: 18 -> 14.
  // POD-6341 (measured on the polaris VM, statement lists diffed against the
  // integration branch's base): 14 -> 12. The access check no longer reads the
  // session's grants (#92da1c94; sessions are private, design §2.3, POD-6283),
  // and the broadcast lists approvals per connected member (POD-6284
  // fad322e0a3), so with no client connected it reads no approvals list
  // (#5db52787).
  // POD-6674: 12 -> 17. The approval is an effect record on the feed now, so
  // its settlement is written through the effects funnel and its change reaches
  // the change log in the same unit (the record read, the guarded settle, and
  // the log's append and latest-state rows); the broadcast and its approvals
  // list are gone.
  it('approvalExecResult of a session on an issue', async () => {
    // Diffed against the original pin: issueAccessByIds adds one scoped
    // SELECT of execution pointers and quarantine fields for the sharing rules
    // before publishing the notice/effect (POD-7153). Fixed cost 20 -> 21.
    await expectConstantStatements(approval, 21)
  })

  it('approvalExecResult pin is armed', async () => {
    await expectArmed(approval, 21, plantPerSession)
  })

  it('sessionKillResult that confirms the kill', async () => {
    await expectConstantStatements(
      pin(
        'sessionKillResult (killed)',
        fixture,
        async (f) =>
          await route(f, { type: 'sessionKillResult', sessionId: f.ids[0], killed: true }),
      ),
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
      pin(
        'sessionOpenUrlResult',
        fixture,
        async (f) =>
          await route(f, {
            type: 'sessionOpenUrlResult',
            sessionId: f.ids[0],
            requestId: 'o1',
            status: 'opened',
          }),
      ),
      0,
    )
  })
})
