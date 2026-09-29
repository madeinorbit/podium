// Past-the-gate superagent delivery (POD-4827).
//
// POD-4806's gate test proved the daemon ACCEPTS the headless spawn binding,
// but stopped at "machine runtime is not composed" — nothing ever proved the
// headless session actually starts and becomes "behind the runtime contract"
// after the gate. This test goes past it: the server's ACTUAL superagent
// first-turn spawn goes through the REAL daemon `sessionHandlers.spawn` with a
// COMPOSED headless runtime (fake Codex engine), then the server's ACTUAL turn
// frame goes through the REAL `runtimeSendRequest` handler, asserting the turn
// is delivered (accepted + reaching the engine) rather than refused
// `not_running` ("session is not behind the runtime contract").
//
// The daemon half is completed too: the daemon's result/event frames are
// routed back into the server gateway, so a green run means the whole first
// turn — spawn, dispatch, harness run, resume bind — lands end to end.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalHeadlessContractFacts } from '@podium/harness/driver'
import type { SessionId } from '@podium/model'
import {
  asAccountId,
  asMachineId,
  asThreadId,
  BUILTIN_HARNESS_KINDS,
  firstAdminMemberId,
} from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { createHash } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { afterEach, describe, expect, it } from 'vitest'
import { BindingStore } from '../../../../daemon/src/binding-store'
import { sessionHandlers } from '../../../../daemon/src/control/session'
import { runtimeHandlers, sessionIsBehindContract } from '../../../../daemon/src/runtime/handlers'
import { composeHeadlessDeliveryDaemon } from '../../../../daemon/src/test-support/headless-delivery-daemon'
import { userCommandPrincipal } from '../../command-principal'
import { harnessResumeKind } from '../../harness-manifest'
import { SessionClientPlane, type SessionClientPlanePorts } from '../sessions/session-client-plane'
import { SessionMachineReconciler } from '../sessions/machine-reconciler'
import { selectHarnessAccountId } from '../sessions/harness-account'
import { SuperagentService } from './service'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { appRouter } from '../../router'
import { OPERATOR } from '../../test-support/capabilities'
import { assignHostMachine } from '../../test-support/host-daemon'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

/** Poll for a durable effect of the fire-and-forget daemon handlers. */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) return
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function onlineHarness() {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registries.push(registry)
  const host = registry.sessionStore.hostMachineId
  await assignHostMachine(registry.sessionStore)
  await (
    registry.sessionStore as unknown as {
      machines: { setServiceAssignment(id: unknown, a: unknown): Promise<void> }
    }
  ).machines.setServiceAssignment(host, { server: true, agentExecution: true })
  const frames: ControlMessage[] = []
  const peer = (m: ControlMessage) => {
    frames.push(m)
    // Answer the post-accept reads the turn completion needs: an empty
    // transcript tail and a snapshot binding the harness id the fake engine
    // reports. These ride the attached (fake) daemon because the composed
    // daemon under test only speaks spawn/turn verbs here.
    if (m.type === 'transcriptRead') {
      const req = m as { requestId: string; sessionId: SessionId }
      queueMicrotask(() =>
        registry.gateway.routeDaemonFrame(host, {
          type: 'transcriptReadResult',
          requestId: req.requestId,
          sessionId: req.sessionId,
          items: [],
          hasMore: false,
        }),
      )
    }
    if (m.type === 'runtimeSnapshotRequest') {
      const req = m as { requestId: string; sessionId: SessionId }
      queueMicrotask(() =>
        registry.gateway.routeDaemonFrame(host, {
          type: 'runtimeSnapshotResult',
          requestId: req.requestId,
          sessionId: req.sessionId,
          result: {
            snapshot: {
              binding: {
                sessionId: req.sessionId,
                driver: 'headless',
                family: 'server',
                harness: 'codex',
                workdir: '/tmp',
                resume: { kind: 'codex-thread', value: 'harness-1' },
                process: { key: 'test' },
                bindingVersion: 1,
              },
              state: {},
              cursor: { segmentId: 's', components: {} },
              observerGeneration: 1,
              turnEpoch: 1,
              interactions: [],
              at: new Date().toISOString(),
            },
          },
        }),
      )
    }
  }
  await registry.gateway.attachDaemon(host, peer)
  registry.gateway.routeDaemonFrame(host, {
    type: 'inventoryReport',
    machineId: host,
    inventory: {
      os: 'linux',
      arch: 'x64',
      agents: BUILTIN_HARNESS_KINDS.map((kind) => ({
        kind,
        installed: true,
        login: {
          state: 'in' as const,
          // The parity test resolves this fingerprint through both paths;
          // every other test ignores identity.
          ...(kind === 'codex' ? { identity: { fingerprint: 'FP1' } } : {}),
        },
      })),
      tools: [],
    },
  })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  await repos.add('/r', host)
  const sa = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  return { registry, repos, sa, frames, host, peer }
}

describe('superagent first turn past the binding gate (POD-4827)', () => {
  it('the actual spawn establishes a contract session and the actual turn delivers to the engine', async () => {
    const h = await onlineHarness()
    const ack = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hello',
      agentKind: 'codex',
    })
    await waitFor(
      () =>
        h.frames.some((m) => m.type === 'spawn' && m.sessionId === ack.podiumSessionId) &&
        h.frames.some(
          (m) =>
            (m.type === 'runtimeSendRequest' || m.type === 'runtimeDurableSendRequest') &&
            m.sessionId === ack.podiumSessionId,
        ),
      'the server emitting the superagent spawn and turn',
    )
    const spawn = h.frames.find(
      (m) => m.type === 'spawn' && m.sessionId === ack.podiumSessionId,
    ) as Extract<ControlMessage, { type: 'spawn' }>
    const turn = h.frames.find(
      (m) =>
        (m.type === 'runtimeSendRequest' || m.type === 'runtimeDurableSendRequest') &&
        m.sessionId === ack.podiumSessionId,
    ) as unknown as { requestId: string; sessionId: SessionId; turnId: string } & ControlMessage
    expect(spawn.requestedDriverId).toBe('headless')

    // ---- daemon half: the real spawn handler over a composed headless runtime ----
    // (composed in apps/daemon test-support — the machine-host surface the
    // harness manifest restricts to the daemon — driven here through the real
    // control handlers, the same seam the wire takes).
    const dir = mkdtempSync(join(tmpdir(), 'podium-4827-delivery-'))
    const store = await BindingStore.open({ dir })
    const { ctx: dctx, sent, turns } = composeHeadlessDeliveryDaemon({ store })
    const forwardToServer = async () => {
      for (const msg of sent.splice(0)) {
        if (
          msg.type === 'runtimeSendResult' ||
          msg.type === 'runtimeEvent' ||
          msg.type === 'runtimeFineEvent' ||
          msg.type === 'runtimeInteractionAsked' ||
          msg.type === 'bind' ||
          msg.type === 'agentState'
        ) {
          await h.registry.gateway.routeDaemonFrame(h.host, msg as never)
        }
      }
    }

    sessionHandlers.spawn(dctx, spawn as never)
    await waitFor(
      () =>
        sessionIsBehindContract(dctx, ack.podiumSessionId) ||
        sent.some((m) => m.type === 'spawnError' && m.sessionId === ack.podiumSessionId),
      'the daemon establishing the headless session (or refusing the spawn)',
    )
    const spawnError = sent.find(
      (m) => m.type === 'spawnError' && m.sessionId === ack.podiumSessionId,
    ) as { message?: string } | undefined
    expect(spawnError, `daemon spawnError: ${spawnError?.message}`).toBeUndefined()
    expect(sessionIsBehindContract(dctx, ack.podiumSessionId)).toBe(true)

    // ---- the server's actual turn bytes through the real turn handler ----
    runtimeHandlers.runtimeSendRequest(dctx, turn as never)
    await waitFor(
      () =>
        turns.length > 0 ||
        sent.some(
          (m) =>
            m.type === 'runtimeSendResult' &&
            (m as { requestId?: string }).requestId === turn.requestId,
        ),
      'the daemon dispatching or answering the turn',
    )
    const receipt = sent.find(
      (m) =>
        m.type === 'runtimeSendResult' && (m as { requestId?: string }).requestId === turn.requestId,
    ) as
      | { receipt?: { outcome?: string; refusal?: { reason?: string; detail?: string } } }
      | undefined
    expect(receipt?.receipt?.outcome, `turn refused: ${JSON.stringify(receipt?.receipt)}`).toBe(
      'accepted',
    )
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ sessionId: ack.podiumSessionId, turnId: turn.turnId })

    // ---- complete the loop: daemon frames back into the server gateway ----
    await forwardToServer()
    turns[0]!.resolve({ harnessSessionId: 'harness-1', output: '' })
    await waitFor(
      () => sent.some((m) => m.type === 'runtimeEvent' && m.sessionId === ack.podiumSessionId),
      'the daemon emitting the terminal turn event',
    )
    await forwardToServer()
    const start = Date.now()
    for (;;) {
      const pending = await h.registry.sessionStore.superagent.listPendingTurns()
      if (pending.length === 0) break
      if (Date.now() - start > 10_000) throw new Error('timed out waiting for the superagent turn to finish')
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(
      (await h.registry.sessionStore.superagent.getSuperagentThread('global'))?.harnessSessionId,
    ).toBe('harness-1')
  })

  it('the offline refusal is a typed client error with no server stack', async () => {
    const h = await onlineHarness()
    const call = appRouter.createCaller({
      registry: h.registry,
      repos: h.repos,
      superagent: h.sa,
      capability: OPERATOR,
      principal: userCommandPrincipal(firstAdminMemberId(), 'admin'),
    })
    // Bind the thread's headless session to the host WITHOUT running a turn:
    // `ensureSession` mints the binding only, so no turn is ever in flight and
    // the offline send below cannot queue behind one (a queued send resolves
    // instead of refusing, which is what made a complete-the-first-turn setup
    // race the finish).
    const ensured = await h.sa.ensureSession({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
    })
    expect(ensured.podiumSessionId).toBeTruthy()
    // Take the machine offline: the bound session's host has no daemon now.
    h.registry.gateway.detachDaemon(h.host, h.peer)
    expect(h.registry.modules.machines.hasDaemon(h.host)).toBe(false)

    const outcome = await call.superagent
      .sendTurn({ threadId: 'global', text: 'second', agentKind: 'codex' })
      .then(
        (r) => ({ returned: r }) as const,
        (e: unknown) => ({ thrown: e as TRPCError }) as const,
      )
    const err = 'thrown' in outcome ? outcome.thrown : null
    expect(err).not.toBeNull()
    // Same message as before, but typed: PRECONDITION_FAILED (HTTP 412), the
    // same code the machine picker uses for an offline machine — never the
    // 500 INTERNAL_SERVER_ERROR with the server stack the re-check caught.
    expect(err).toBeInstanceOf(TRPCError)
    expect(err!.code).toBe('PRECONDITION_FAILED')
    expect(err!.message).toContain('is offline')
    expect(err!.message).toContain('bring its daemon online, then retry')
    expect(err!.stack).toBeUndefined()
  })

  it('a daemon re-attach re-establishes a never-bound headless session before its first turn', async () => {
    const h = await onlineHarness()
    // A real headless row with an explicit account (the account fix is test
    // 1's subject, not this one's — pin it so the mechanism turn verifies).
    const created = await h.registry.modules.sessions.headless.createHeadlessSession({
      agentKind: 'codex',
      cwd: '/r',
      ownerUserId: firstAdminMemberId(),
      accountId: asAccountId('native:codex:fp-test'),
    })
    const s1 = h.frames.find(
      (m) => m.type === 'spawn' && m.sessionId === created.sessionId,
    ) as Extract<ControlMessage, { type: 'spawn' }>
    expect(s1.requestedDriverId).toBe('headless')

    // Daemon generation 1: the real spawn handler establishes the session
    // (composed in apps/daemon test-support; the store is shared with
    // generation 2 below so the restart keeps bindings but loses handles).
    const dir = mkdtempSync(join(tmpdir(), 'podium-4827-restart-'))
    const store = await BindingStore.open({ dir })
    const gen1 = composeHeadlessDeliveryDaemon({ store, machineId: asMachineId('restart-machine') })
    sessionHandlers.spawn(gen1.ctx, s1 as never)
    await waitFor(
      () =>
        sessionIsBehindContract(gen1.ctx, created.sessionId) ||
        gen1.sent.some((m) => m.type === 'spawnError' && m.sessionId === created.sessionId),
      'generation 1 establishing the session',
    )
    expect(sessionIsBehindContract(gen1.ctx, created.sessionId)).toBe(true)

    // Restart: generation 2 shares the persisted binding store but holds no
    // sessions — the in-memory headless handle died with generation 1.
    const gen2 = composeHeadlessDeliveryDaemon({ store, machineId: asMachineId('restart-machine') })
    expect(sessionIsBehindContract(gen2.ctx, created.sessionId)).toBe(false)
    const accountId = 'native:codex:fp-test'
    const digest = createHash('sha256')
      .update(
        canonicalHeadlessContractFacts({
          prompt: 'hi again',
          turnId: 'turn-restart',
          sessionId: created.sessionId,
          accountId,
        }),
      )
      .digest('hex')
    const turn: Record<string, unknown> & {
      requestId: string
      turnId: string
      sessionId: SessionId
    } = {
      type: 'runtimeSendRequest',
      requestId: 'req-restart',
      turnId: 'turn-restart',
      sessionId: created.sessionId,
      text: 'hi again',
      origin: 'system',
      delivery: 'when-ready',
      accountId,
      requestDigest: digest,
    }
    runtimeHandlers.runtimeSendRequest(gen2.ctx, turn as never)
    await waitFor(
      () =>
        gen2.sent.some(
          (m) => m.type === 'runtimeSendResult' && (m as { requestId?: string }).requestId === 'req-restart',
        ),
      'generation 2 refusing the turn',
    )
    const firstReceipt = gen2.sent.find(
      (m) => m.type === 'runtimeSendResult' && (m as { requestId?: string }).requestId === 'req-restart',
    ) as { receipt?: { outcome?: string; refusal?: { reason?: string; detail?: string } } }
    expect(firstReceipt.receipt).toMatchObject({
      outcome: 'refused',
      refusal: { reason: 'not_running', detail: 'session is not behind the runtime contract' },
    })

    // The reconnect heals it: drive the REAL attach chain (reconciler loop +
    // plane + HeadlessService) the way a daemon attach does. The loop must
    // route the never-bound row to re-establish (not rebind), while a resumed
    // row still rebinds its tail.
    const createdResumed = await h.registry.modules.sessions.headless.createHeadlessSession({
      agentKind: 'codex',
      cwd: '/r',
      ownerUserId: firstAdminMemberId(),
      accountId: asAccountId('native:codex:fp-test'),
    })
    const row = h.registry.modules.sessions.headless.headlessSession(created.sessionId)
    const rowResumed = h.registry.modules.sessions.headless.headlessSession(createdResumed.sessionId)
    if (!row || !rowResumed) throw new Error('headless rows missing')
    // A resumed live row, assigned the way production's bind does (the
    // persisted setter lands on the draft/store, not the live object).
    rowResumed.resume = { kind: harnessResumeKind('codex'), value: 'harness-resumed' }
    expect(rowResumed.resume?.value).toBe('harness-resumed')
    const plane = new SessionClientPlane({
      headless: h.registry.modules.sessions.headless,
    } as unknown as SessionClientPlanePorts)
    const rebound: SessionId[] = []
    const reestablished: SessionId[] = []
    const directSends: ControlMessage[] = []
    const reconciler = new SessionMachineReconciler({
      sessions: () => [row, rowResumed],
      drainInbox: async () => {},
      triggerLakeSweep: async () => {},
      resetPriorities: () => {},
      pushPriorities: () => {},
      parkArchivedSession: async () => {},
      reattachMessage: async () => {
        throw new Error('no headed probe expected for live headless rows')
      },
      toMachine: (_mid, msg) => void directSends.push(msg),
      viewTiers: () => new Map(),
      rebindHeadless: (s) => {
        rebound.push(s.sessionId)
        plane.rebindHeadless(s)
      },
      reestablishHeadless: (s) => {
        reestablished.push(s.sessionId)
        plane.reestablishHeadless(s)
      },
      markVolatileSessionDirty: () => {},
      write: async () => {},
      broadcastSessions: () => {},
    })
    // ... and the resumed row rebound its tail instead of spawning. (Its
    // creation spawn predates the attach; only post-attach frames count.)
    const resumedSpawnsBefore = h.frames.filter(
      (m) => m.type === 'spawn' && m.sessionId === createdResumed.sessionId,
    ).length
    await reconciler.onAttached({ kind: 'machine', machine: h.host } as never)
    // Routing: the never-bound row re-establishes, the resumed row rebinds.
    expect(rebound).toEqual([createdResumed.sessionId])
    expect(reestablished).toEqual([created.sessionId])
    expect(directSends).toHaveLength(0)
    // Both arms are fire-and-forget (re-issued on every attach), so poll for
    // the frames rather than awaiting a promise that resolves before they land.
    await waitFor(
      () =>
        h.frames.filter((m) => m.type === 'spawn' && m.sessionId === created.sessionId).length === 2,
      'the attach re-sending the establish frame',
    )
    await waitFor(
      () => h.frames.some((m) => m.type === 'reattach' && m.sessionId === createdResumed.sessionId),
      'the attach rebinding the resumed tail',
    )
    // The re-sent establish frame — same session, same binding transition
    // (the daemon dedupes on it, so this is a re-establish, never a second
    // session). Without the attach wiring nothing is sent and the assertion
    // below fails red.
    const s2 = h.frames.find(
      (m) => m.type === 'spawn' && m.sessionId === created.sessionId && m !== s1,
    ) as Extract<ControlMessage, { type: 'spawn' }>
    expect(s2.requestedDriverId).toBe('headless')
    expect((s2.binding as { transitionId?: string } | undefined)?.transitionId).toBe(
      (s1.binding as { transitionId?: string }).transitionId,
    )
    // ... and the resumed row rebound its tail instead of spawning.
    const reattach = h.frames.find(
      (m) => m.type === 'reattach' && m.sessionId === createdResumed.sessionId,
    ) as Extract<ControlMessage, { type: 'reattach' }>
    expect(reattach.resume).toMatchObject({ value: 'harness-resumed' })
    expect(
      h.frames.filter((m) => m.type === 'spawn' && m.sessionId === createdResumed.sessionId),
    ).toHaveLength(resumedSpawnsBefore)

    // The re-sent frame re-establishes generation 2 through the real handler
    // (binding dedup path — the store already holds the spawn transition),
    // and the retried turn then delivers to the engine.
    sessionHandlers.spawn(gen2.ctx, s2 as never)
    await waitFor(
      () =>
        sessionIsBehindContract(gen2.ctx, created.sessionId) ||
        gen2.sent.some((m) => m.type === 'spawnError' && m.sessionId === created.sessionId),
      'generation 2 re-establishing the session',
    )
    const reError = gen2.sent.find(
      (m) => m.type === 'spawnError' && m.sessionId === created.sessionId,
    ) as { message?: string } | undefined
    expect(reError, `re-establish spawnError: ${reError?.message}`).toBeUndefined()
    expect(sessionIsBehindContract(gen2.ctx, created.sessionId)).toBe(true)
    runtimeHandlers.runtimeSendRequest(gen2.ctx, { ...turn, requestId: 'req-restart-2' } as never)
    await waitFor(
      () =>
        gen2.sent.some(
          (m) => m.type === 'runtimeSendResult' && (m as { requestId?: string }).requestId === 'req-restart-2',
        ),
      'generation 2 accepting the retried turn',
    )
    const secondReceipt = gen2.sent.find(
      (m) => m.type === 'runtimeSendResult' && (m as { requestId?: string }).requestId === 'req-restart-2',
    ) as { receipt?: { outcome?: string; refusal?: unknown } }
    expect(secondReceipt.receipt?.outcome).toBe('accepted')
    expect(gen2.turns.map((t) => t.turnId)).toContain('turn-restart')
  })

  it('the composer path and the superagent path resolve the same account for the same settings', async () => {
    const h = await onlineHarness()
    // Both roles name a claude login for a codex session, so the one shared
    // rule must fall back to codex's bare native id on both paths — resolved
    // to this machine's fingerprint downstream. The coding role seeds through
    // the instance blob, but the superagent role MUST be written per-user:
    // the superagent seeder pre-matches an empty role to a ready harness in
    // per-user rows, which shadow the blob — seeding only the blob would
    // leave the superagent path matched and the mismatch arm untested.
    const settings = await h.registry.sessionStore.settings.getSettings()
    await h.registry.sessionStore.settings.setSettings({
      ...settings,
      roles: {
        ...settings.roles,
        coding: { ...settings.roles.coding, accountId: asAccountId('native:claude-code:FP9') },
      },
    })
    const now = new Date().toISOString()
    const owner = firstAdminMemberId()
    for (const [path, value] of [
      ['roles.superagent.harness', 'claude-code'],
      ['roles.superagent.accountId', 'native:claude-code:FP9'],
    ] as const) {
      await h.registry.sessionStore.settings.userPreferences.set(owner, path, value, now)
    }
    const { sessionId: headedId } = await h.registry.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/r',
    })
    const ack = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
      agentKind: 'codex',
    })
    const thread = await h.registry.sessionStore.superagent.getSuperagentThread('global')
    const headedAccount = (await h.registry.sessionStore.sessions.getSession(headedId))?.accountId
    const headlessAccount = thread?.podiumSessionId
      ? (await h.registry.sessionStore.sessions.getSession(thread.podiumSessionId))?.accountId
      : undefined
    expect(headedAccount).toBe('native:codex:FP1')
    // Same settings, same harness, same machine: the same account. A fork in
    // the selection rule would show up here as two different identities for
    // one login.
    expect(headlessAccount).toBe(headedAccount)
    expect(ack.podiumSessionId).toBe(thread?.podiumSessionId)
  })

  it('the shared account rule keeps matching ids and falls back cross-harness ones', async () => {
    // The selection table both paths call (selectHarnessAccountId): a native
    // id for another harness must never be spent silently, while matching,
    // explicit-shaped and non-native ids ride unchanged.
    expect(selectHarnessAccountId('codex', asAccountId('native:codex:fp-a'))).toBe('native:codex:fp-a')
    expect(selectHarnessAccountId('codex', asAccountId('native:codex'))).toBe('native:codex')
    expect(selectHarnessAccountId('codex', asAccountId('native:claude-code:fp-b'))).toBe(
      'native:codex',
    )
    expect(selectHarnessAccountId('codex', asAccountId('managed:openrouter'))).toBe(
      'managed:openrouter',
    )
    expect(selectHarnessAccountId('codex', undefined)).toBe('native:codex')
  })
})
