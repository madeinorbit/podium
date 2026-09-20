import { attachTestClient } from './test-support/client-transport'
// Headless superagent turns (concierge unification, Phase B): threads are
// persistent harness sessions — sendTurn acks before completion, progress fans
// out as headlessActivity frames, the harness session id becomes the thread's
// resume value, and "open in terminal" takes a one-writer lock.

import {
  asAccountId,
  asIssueId,
  asSessionId,
  asThreadId,
  asUserId,
  BUILTIN_HARNESS_KINDS,
  firstAdminMemberId,
  type AccountId,
} from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { type HarnessAgent, nativeAccountId } from '@podium/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import { harnessResumeKind } from './harness-manifest'
import {
  buildHandoffSeed,
  explicitlyRequestsExpandedResponse,
  hasDurableHeadlessResultIdentity,
  NORMAL_RESPONSE_WORD_LIMIT,
  SuperagentService,
  superagentResponseContract,
  TURN_FAILED_MARKER,
} from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

type TurnReq = {
  requestId: string
  turnId: string
  sessionId: string
  accountId: AccountId
  requestDigest: string
  prompt: string
  contextPrompt?: string
  systemPrompt?: string
  permissionMode?: string
  resumeValue?: string
  sessionUuid?: string
  model?: string
  effort?: string
  mcpConfig?: string
  allowedTools?: string[]
  toolPolicy?: 'none'
  timeoutMs?: number
  agent?: string
  cwd?: string
}
type BindReq = Extract<ControlMessage, { type: 'reattach' }> & { resumeValue?: string }
type TurnAck = Extract<ControlMessage, { type: 'headlessTurnAck' }>
type SpawnMsg = Extract<ControlMessage, { type: 'spawn' }>

async function harness() {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  registries.push(registry)
  const host = registry.sessionStore.hostMachineId
  await (registry.sessionStore as unknown as { machines: { upsertMachine(i: unknown): Promise<void>; setServiceAssignment(id: unknown, a: unknown): Promise<void> } }).machines.upsertMachine({
    id: host,
    name: 'host',
    hostname: 'host',
    tokenHash: 'test',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: true, agentExecution: true },
  })
  await (registry.sessionStore as unknown as { machines: { setServiceAssignment(id: unknown, a: unknown): Promise<void> } }).machines.setServiceAssignment(host, { server: true, agentExecution: true })
  const turnReqs: TurnReq[] = []
  const bindReqs: BindReq[] = []
  const turnAcks: TurnAck[] = []
  const spawns: SpawnMsg[] = []
  const interrupts: string[] = []
  const epochs = new Map<string, number>()
  const pendingResults = new Map<string, { harnessSessionId?: string; output?: string }>()
  const sessionInfo = new Map<string, { agent: string; cwd: string }>()
  await registry.gateway.attachDaemon(registry.sessionStore.hostMachineId, (m) => {
    if (m.type === 'spawn') {
      sessionInfo.set(m.sessionId, { agent: m.agentKind, cwd: m.cwd })
    }
    if (m.type === 'runtimeSendRequest' || m.type === 'runtimeDurableSendRequest') {
      const epoch = (epochs.get(m.sessionId) ?? 0) + 1
      epochs.set(m.sessionId, epoch)
      const info = sessionInfo.get(m.sessionId)
      turnReqs.push({
        requestId: m.requestId,
        turnId: m.turnId,
        sessionId: m.sessionId,
        accountId: (m.accountId ?? '') as AccountId,
        requestDigest: m.requestDigest ?? '0'.repeat(64),
        prompt: m.text,
        ...(m.contextPrompt ? { contextPrompt: m.contextPrompt } : {}),
        ...(m.systemPrompt ? { systemPrompt: m.systemPrompt } : {}),
        ...(m.permissionMode ? { permissionMode: m.permissionMode } : {}),
        ...(m.resumeValue ? { resumeValue: m.resumeValue } : {}),
        ...(m.sessionUuid ? { sessionUuid: m.sessionUuid } : {}),
        ...(m.model ? { model: m.model } : {}),
        ...(m.effort ? { effort: m.effort } : {}),
        ...(m.mcpConfig ? { mcpConfig: m.mcpConfig } : {}),
        ...(m.allowedTools ? { allowedTools: [...m.allowedTools] } : {}),
        ...(m.toolPolicy ? { toolPolicy: m.toolPolicy } : {}),
        ...(m.timeoutMs ? { timeoutMs: m.timeoutMs } : {}),
        ...(info ? { agent: info.agent, cwd: info.cwd } : {}),
      })
      return
    }
    if (m.type === 'reattach' && m.runtimeContract === 'headless') {
      bindReqs.push({
        ...m,
        resumeValue: m.resume?.value,
      } as BindReq)
      return
    }
    if (m.type === 'headlessTurnAck') turnAcks.push(m)
    if (m.type === 'spawn') spawns.push(m)
    if (m.type === 'runtimeInterruptRequest') {
      interrupts.push(m.sessionId)
      queueMicrotask(() =>
        registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
          type: 'runtimeLifecycleResult',
          requestId: m.requestId,
          sessionId: m.sessionId,
          result: { ok: true },
        }),
      )
      return
    }
    if (m.type === 'runtimeHistoryRequest') {
      const pending = pendingResults.get(m.sessionId)
      const output = pending?.output
      queueMicrotask(() =>
        registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
          type: 'runtimeHistoryResult',
          requestId: m.requestId,
          sessionId: m.sessionId,
          result: {
            page: {
              items: output ? [{ id: 'item-1', role: 'assistant', text: output, ts: new Date().toISOString() }] : [],
              hasMore: false,
            },
          },
        }),
      )
      return
    }
    if (m.type === 'runtimeSnapshotRequest') {
      const pending = pendingResults.get(m.sessionId)
      queueMicrotask(() =>
        registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
          type: 'runtimeSnapshotResult',
          requestId: m.requestId,
          sessionId: m.sessionId,
          result: {
            snapshot: {
              binding: {
                sessionId: m.sessionId,
                driver: 'headless',
                family: 'server',
                harness: 'claude-code',
                workdir: '/r',
                resume: pending?.harnessSessionId ? { kind: 'headless-session', value: pending.harnessSessionId } : null,
                process: { key: 'test' },
                bindingVersion: 1,
              },
              state: {},
              cursor: { segmentId: 's', components: {} },
              observerGeneration: 1,
              turnEpoch: epochs.get(m.sessionId) ?? 1,
              interactions: [],
              at: new Date().toISOString(),
            },
          },
        }),
      )
      return
    }
    if (m.type === 'repoOpRequest') {
      queueMicrotask(() =>
        registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
          type: 'repoOpResult',
          requestId: m.requestId,
          ok: true,
          output: '',
        }),
      )
    }
    if (m.type === 'transcriptRead') {
      queueMicrotask(() =>
        registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
          type: 'transcriptReadResult',
          requestId: m.requestId,
          sessionId: m.sessionId,
          items: [],
          hasMore: false,
        }),
      )
    }
  })
  registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
    type: 'inventoryReport',
    machineId: registry.sessionStore.hostMachineId,
    inventory: {
      os: 'linux',
      arch: 'x64',
      agents: BUILTIN_HARNESS_KINDS.map((kind) => ({
        kind,
        installed: true,
        login: { state: 'in' as const },
      })),
      tools: [],
    },
  })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  await repos.add('/r', registry.sessionStore.hostMachineId)
  const sa = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  // A connected web client, to observe headlessActivity broadcasts.
  const clientMsgs: ServerMessage[] = []
  attachTestClient(registry.clientGateway, (m) => clientMsgs.push(m))
  const activity = () => clientMsgs.flatMap((m) => (m.type === 'headlessActivity' ? [m] : []))
  const resolveTurn = (
    req: TurnReq,
    result?: { ok?: boolean; error?: string; harnessSessionId?: string; output?: string },
  ) => {
    const epoch = epochs.get(req.sessionId) ?? 1
    pendingResults.set(req.sessionId, {
      ...(result?.harnessSessionId ? { harnessSessionId: result.harnessSessionId } : {}),
      ...(result?.output ? { output: result.output } : {}),
    })
    // Receipt first (accepted with epoch), then the causal terminal events.
    // Events go straight through the gateway (not the mux) so the test does
    // not depend on daemon-frame routing for the contract stream.
    void registry.gateway.routeDaemonFrame(registry.sessionStore.hostMachineId, {
      type: 'runtimeSendResult',
      requestId: req.requestId,
      sessionId: req.sessionId as never,
      receipt: { outcome: 'accepted', turnEpoch: epoch, deliveredAs: 'when-ready', provenBy: 'protocol-ack', at: new Date().toISOString() },
    })
    const at = new Date().toISOString()
    const gateway = registry.modules.sessions.runtimeGateway
    const host = registry.sessionStore.hostMachineId
    void (async () => {
      await gateway.record(host, {
        sessionId: req.sessionId as never,
        event: {
          t: 'turn',
          ev: { ev: 'started', turnEpoch: epoch, origin: 'system' },
          cursor: { segmentId: 's', components: { seq: epoch * 2 - 1 } },
          observerGeneration: 1,
          turnEpoch: epoch,
          provenance: 'live',
          at,
        } as never,
      })
      const ok = result?.ok ?? true
      await gateway.record(host, {
        sessionId: req.sessionId as never,
        event: ok
          ? { t: 'turn', ev: { ev: 'completed', turnEpoch: epoch, verdict: 'done' }, cursor: { segmentId: 's', components: { seq: epoch * 2 } }, observerGeneration: 1, turnEpoch: epoch, provenance: 'live', at } as never
          : { t: 'turn', ev: { ev: 'failed', turnEpoch: epoch, reason: 'provider-error', disposition: 'fatal', detail: result?.error ?? 'error' }, cursor: { segmentId: 's', components: { seq: epoch * 2 } }, observerGeneration: 1, turnEpoch: epoch, provenance: 'live', at } as never,
      })
    })()
  }
  const settle = () => new Promise((r) => setTimeout(r))
  return {
    registry,
    repos,
    sa,
    turnReqs,
    bindReqs,
    turnAcks,
    spawns,
    interrupts,
    activity,
    resolveTurn,
    settle,
  }
}

describe('superagent response contract', () => {
  it('retains a complete durable identity when a legacy generic account is empty', () => {
    expect(
      hasDurableHeadlessResultIdentity({
        requestDigest: 'a'.repeat(64),
        accountId: asAccountId(''),
      }),
    ).toBe(true)
  })

  it.each([
    'Why?',
    'How did this happen?',
    'Explain the failure',
    'Why? Explain briefly.',
  ])('keeps ordinary diagnostics inside the normal budget: %s', (prompt) => {
    expect(explicitlyRequestsExpandedResponse(prompt)).toBe(false)
    expect(superagentResponseContract(prompt)).toContain(
      'HARD LIMIT ' + NORMAL_RESPONSE_WORD_LIMIT + ' words',
    )
  })

  it.each([
    'Give me a detailed explanation.',
    'I want a thorough answer.',
    'Provide a walkthrough of the failure.',
  ])('allows expansion only for an explicit cue: %s', (prompt) => {
    expect(explicitlyRequestsExpandedResponse(prompt)).toBe(true)
    expect(superagentResponseContract(prompt)).toContain('EXPANDED:')
  })

  it.each([
    "Don't give me a detailed answer.",
    'Is the detailed log present?',
    'Why is the walkthrough test failing?',
  ])('does not treat a negated or incidental cue as an opt-in: %s', (prompt) => {
    expect(explicitlyRequestsExpandedResponse(prompt)).toBe(false)
  })
})

describe('bounded headless session identity', () => {
  it('persists personal ownership, attribution, issue, account fingerprint, and launch route', async () => {
    const h = await harness()
    const sessionId = asSessionId('shipwright:attempt:3:mechanic:0')
    const issueId = asIssueId('issue:shipwright')
    const accountId = asAccountId('native:claude-code:fingerprint-1')
    const createdBy = {
      actor: { kind: 'user' as const, id: firstAdminMemberId() },
      onBehalfOf: firstAdminMemberId(),
    }
    const input = {
      sessionId,
      agentKind: 'claude-code' as const,
      cwd: '/r',
      machineId: h.registry.sessionStore.hostMachineId,
      ownerUserId: firstAdminMemberId(),
      createdBy,
      issueId,
      accountId,
      model: 'repair-model',
      effort: 'high',
      requireNoTools: true,
    }

    expect(await h.registry.modules.sessions.headless.createHeadlessSession(input)).toEqual({ sessionId })
    expect(await h.registry.modules.sessions.headless.createHeadlessSession(input)).toEqual({ sessionId })
    expect(
      (await h.registry.modules.sessions.listSessions(undefined, 'rpc')).find((row) => row.sessionId === sessionId),
    ).toMatchObject({
      createdBy,
      issueId,
      accountId,
      model: 'repair-model',
      effort: 'high',
      headless: true,
    })
    expect(await h.registry.sessionStore.sessions.getSession(sessionId)).toMatchObject({
      ownerUserId: firstAdminMemberId(),
      createdBy,
      issueId,
      accountId,
    })
    const turn = h.registry.modules.sessions.headless.headlessTurn({
      turnId: 'turn:repair',
      sessionId,
      threadId: asThreadId('shipping:order'),
      agent: 'claude-code',
      cwd: '/r',
      prompt: 'bounded repair',
      toolPolicy: 'none',
    })
    await h.settle()
    const request = h.turnReqs.at(-1)
    if (!request) throw new Error('repair request was not dispatched')
    // Owner/createdBy/issueId ride the session row (asserted above), not the
    // turn wire; the wire carries the durable account identity.
    expect(request).toMatchObject({
      accountId,
    })
    h.resolveTurn(request, { output: '{}' })
    await expect(turn).resolves.toMatchObject({ ok: true })
    await expect(
      h.registry.modules.sessions.headless.createHeadlessSession({
        ...input,
        accountId: asAccountId('native:claude-code:different'),
      }),
    ).rejects.toThrow(/mismatched headless session/)
    await expect(
      h.registry.modules.sessions.headless.createHeadlessSession({
        ...input,
        createdBy: {
          actor: { kind: 'user', id: asUserId('user:different') },
          onBehalfOf: firstAdminMemberId(),
        },
      }),
    ).rejects.toThrow(/mismatched headless session/)
  })

  it('refuses unsupported no-tools sessions before dispatch', async () => {
    const h = await harness()
    await expect(
      h.registry.modules.sessions.headless.createHeadlessSession({
        ownerUserId: firstAdminMemberId(),
        agentKind: 'codex',
        cwd: '/r',
        requireNoTools: true,
      }),
    ).rejects.toThrow(/cannot enforce a no-tools headless session/)
    await expect(
      h.registry.modules.sessions.headless.createHeadlessSession({
        ownerUserId: firstAdminMemberId(),
        agentKind: 'claude-code',
        cwd: '/r',
        accountId: asAccountId('native:claude-code'),
        requireNoTools: true,
      }),
    ).rejects.toThrow(/exact native account fingerprint/)
    expect(h.turnReqs).toHaveLength(0)
  })

  it('keeps ordinary legacy headless sessions runnable without a bound account', async () => {
    const h = await harness()
    const { sessionId } = await h.registry.modules.sessions.headless.createHeadlessSession({
      ownerUserId: firstAdminMemberId(),
      agentKind: 'claude-code',
      cwd: '/r',
    })
    const turn = h.registry.modules.sessions.headless.headlessTurn({
      turnId: 'turn:legacy',
      sessionId,
      threadId: asThreadId('legacy'),
      agent: 'claude-code',
      cwd: '/r',
      prompt: 'continue',
    })
    await h.settle()
    const request = h.turnReqs.at(-1)
    if (!request) throw new Error('legacy request was not dispatched')
    expect(request.accountId).toBe('')
    h.resolveTurn(request, { output: 'done' })
    await expect(turn).resolves.toMatchObject({ ok: true, output: 'done' })
  })
})

describe('headless turn refusal surfacing (POD-4409)', () => {
  // The migrated turn path (superagent + shipwright) reports a driver refusal
  // here INSTEAD of the legacy headless port POD-4279 deletes. Neutering the
  // `receipt.outcome === 'refused'` guard must turn every test below red: with
  // the guard gone the refusal is never surfaced and the turn waits out its
  // transport budget instead of reporting the fence.
  const refuseTurn = (
    h: Awaited<ReturnType<typeof harness>>,
    req: TurnReq,
    refusal: { reason: 'invalid_value' | 'not_running' | 'unsupported'; detail?: string },
  ) => {
    const host = h.registry.sessionStore.hostMachineId
    void h.registry.gateway.routeDaemonFrame(host, {
      type: 'runtimeSendResult',
      requestId: req.requestId,
      sessionId: req.sessionId as never,
      receipt: { outcome: 'refused', refusal },
    })
    // Poison for the neutered guard: with `if (receipt.outcome === 'refused')`
    // replaced by `if (false)` the turn falls through to the accepted branch
    // and waits for a terminal event that a real refusal never sends — a
    // 610s transport wait (test timeout, not an assertion). Emitting the
    // terminal here makes the mutant resolve ok:true in milliseconds, so the
    // mutation proof fails fast on the assertion below. The correct code has
    // already returned and unsubscribed, so these events are never observed.
    const at = new Date().toISOString()
    const gateway = h.registry.modules.sessions.runtimeGateway
    void (async () => {
      await gateway.record(host, {
        sessionId: req.sessionId as never,
        event: {
          t: 'turn',
          ev: { ev: 'started', turnEpoch: 1, origin: 'system' },
          cursor: { segmentId: 's', components: { seq: 1 } },
          observerGeneration: 1,
          turnEpoch: 1,
          provenance: 'live',
          at,
        } as never,
      })
      await gateway.record(host, {
        sessionId: req.sessionId as never,
        event: {
          t: 'turn',
          ev: { ev: 'completed', turnEpoch: 1, verdict: 'done' },
          cursor: { segmentId: 's', components: { seq: 2 } },
          observerGeneration: 1,
          turnEpoch: 1,
          provenance: 'live',
          at,
        } as never,
      })
    })()
  }

  const startProbeTurn = async (h: Awaited<ReturnType<typeof harness>>, turnId: string) => {
    const { sessionId } = await h.registry.modules.sessions.headless.createHeadlessSession({
      ownerUserId: firstAdminMemberId(),
      agentKind: 'claude-code',
      cwd: '/r',
    })
    const turn = h.registry.modules.sessions.headless.headlessTurn({
      turnId,
      sessionId,
      threadId: asThreadId('refusal-probe'),
      agent: 'claude-code',
      cwd: '/r',
      prompt: 'probe the fence',
    })
    await h.settle()
    const req = h.turnReqs.at(-1)
    if (!req) throw new Error('refusal probe was not dispatched')
    return { turn, req }
  }

  it('surfaces a digest-mismatch refusal as an identity mismatch', async () => {
    const h = await harness()
    const { turn, req } = await startProbeTurn(h, 'turn:digest-probe')
    // Exact daemon fence detail (POD-4386): apps/daemon/src/runtime/headless-driver.ts
    refuseTurn(h, req, { reason: 'invalid_value', detail: 'headless request digest mismatch' })
    const result = await turn
    expect(result).toMatchObject({ ok: false, error: 'headless result identity mismatch' })
    expect(result.retryable).toBeUndefined()
  })

  it('surfaces an account-fingerprint mismatch refusal as an identity mismatch', async () => {
    const h = await harness()
    const { turn, req } = await startProbeTurn(h, 'turn:account-probe')
    // Exact daemon fence detail (POD-4392): apps/daemon/src/control/headless.ts
    refuseTurn(h, req, {
      reason: 'invalid_value',
      detail: 'native claude-code account fingerprint changed before launch',
    })
    const result = await turn
    expect(result).toMatchObject({ ok: false, error: 'headless result identity mismatch' })
    expect(result.retryable).toBeUndefined()
  })

  it('passes a not_running refusal through as retryable with its detail', async () => {
    const h = await harness()
    const { turn, req } = await startProbeTurn(h, 'turn:not-running-probe')
    refuseTurn(h, req, { reason: 'not_running', detail: 'headless session has ended' })
    await expect(turn).resolves.toMatchObject({
      ok: false,
      error: 'headless session has ended',
      retryable: true,
    })
  })

  it('passes a non-identity refusal through with its detail verbatim', async () => {
    const h = await harness()
    const { turn, req } = await startProbeTurn(h, 'turn:policy-probe')
    // invalid_value WITHOUT a digest/identity/account keyword: not the identity
    // fence, so the driver detail itself is the error (no normalization).
    refuseTurn(h, req, {
      reason: 'invalid_value',
      detail: 'harness codex cannot enforce a no-tools headless turn',
    })
    const result = await turn
    expect(result).toMatchObject({
      ok: false,
      error: 'harness codex cannot enforce a no-tools headless turn',
    })
    expect(result.retryable).toBeUndefined()
  })
})

describe('global thread priming, clear, and per-turn user focus (#225)', () => {
  it('re-primes with the seed after clear() — a cleared thread starts a fresh harness session', async () => {
    const h = await harness()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'one',
    })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1' })
    await h.settle()
    const first = await h.registry.sessionStore.superagent.getSuperagentThread('global')
    expect(first?.harnessSessionId).toBe('h1')
    const oldSessionId = first?.podiumSessionId
    expect(oldSessionId).toBeTruthy()

    await h.sa.clear(firstAdminMemberId(), asThreadId('global'))

    // Binding dropped + old headless row disposed.
    const cleared = await h.registry.sessionStore.superagent.getSuperagentThread('global')
    expect(cleared?.harnessSessionId).toBeUndefined()
    expect(cleared?.podiumSessionId).toBeUndefined()
    expect(
      (await h.registry.modules.sessions.listSessions(undefined, 'rpc')).find((s) => s.sessionId === oldSessionId),
    ).toBeUndefined()

    // The next turn is a FIRST turn again: new session, no resume, re-primed.
    const ack = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'two',
    })
    expect(ack.podiumSessionId).not.toBe(oldSessionId)
    const req = h.turnReqs[1]!
    expect(req.resumeValue).toBeUndefined()
    expect(req.prompt).toBe('two')
    expect(req.contextPrompt).toContain('[SUPERAGENT CONTEXT]')
  })

  it('binds the harness session even when the FIRST turn fails — the thread keeps its conversation', async () => {
    const h = await harness()
    const { podiumSessionId } = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
    })
    // The harness minted a session, then the turn died (interrupt / tool crash /
    // error_during_execution). The conversation exists on disk.
    h.resolveTurn(h.turnReqs[0]!, {
      ok: false,
      error: 'claude turn failed: error_during_execution',
      harnessSessionId: 'h1',
    })
    await h.settle()

    const thread = await h.registry.sessionStore.superagent.getSuperagentThread('global')
    expect(thread?.harnessSessionId).toBe('h1')
    // The headless session carries the resume ref, so its transcript binds...
    const meta = (await h.registry.modules.sessions
      .listSessions(undefined, 'rpc'))
      .find((s) => s.sessionId === podiumSessionId)
    expect(meta?.resume).toMatchObject({ kind: harnessResumeKind(meta?.agentKind ?? 'codex'), value: 'h1' })
    // ...and the NEXT turn RESUMES rather than silently starting a new conversation.
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'again',
    })
    expect(h.turnReqs[1]?.resumeValue).toBe('h1')
    h.resolveTurn(h.turnReqs[1]!)
    await h.settle()
    // "Open in terminal" is available again (it gates on harnessSessionId).
    await expect(
      h.sa.openInTerminal({ ownerUserId: firstAdminMemberId(), threadId: asThreadId('global') }),
    ).resolves.toBeDefined()
  })

  /**
   * POD-782 INVERTED THIS. `clear` used to REFUSE while a turn was running, so
   * the one state the reset exists for — a turn whose result never came — was
   * the one state it would not act on, and the operator was stranded on a thread
   * they could neither chat with nor reset. Clearing IS "throw away what is
   * happening here", so it now abandons the turn: the pending row goes, the
   * thread stops being in-flight, and a turn-end reopens the composer.
   */
  it('ABANDONS a running turn rather than refusing to clear', async () => {
    const h = await harness()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
    })
    await expect(h.sa.clear(firstAdminMemberId(), asThreadId('global'))).resolves.toBeUndefined()
    // The thread is usable again immediately — the whole point of the hatch.
    await expect(
      h.sa.sendTurn({
        ownerUserId: firstAdminMemberId(),
        threadId: asThreadId('global'),
        text: 'after the reset',
      }),
    ).resolves.toMatchObject({ queued: false })
  })

  it('clear RELEASES a terminal lock — a locked thread can always be reset', async () => {
    const h = await harness()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
    })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1' })
    await h.settle()
    const { sessionId } = await h.sa.openInTerminal({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
    })
    await expect(
      h.sa.sendTurn({
        ownerUserId: firstAdminMemberId(),
        threadId: asThreadId('global'),
        text: 'x',
      }),
    ).rejects.toThrow(/open in a terminal/)

    await h.sa.clear(firstAdminMemberId(), asThreadId('global'))

    const thread = await h.registry.sessionStore.superagent.getSuperagentThread('global')
    expect(thread?.terminalSessionId).toBeUndefined()
    // The PTY session the user opened keeps running — only the binding was dropped.
    expect(
      (await h.registry.modules.sessions.listSessions(undefined, 'rpc')).find((s) => s.sessionId === sessionId),
    ).toBeTruthy()
    // And chatting works again, from a freshly primed session.
    const ack = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'back to chat',
    })
    expect(ack.podiumSessionId).toBeTruthy()
    expect(h.turnReqs.at(-1)?.prompt).toBe('back to chat')
    expect(h.turnReqs.at(-1)?.contextPrompt).toContain('[SUPERAGENT CONTEXT]')
  })

  it('prepends what the user is looking at to EVERY turn, resolving ids server-side', async () => {
    const h = await harness()
    // A real session to focus, and the issue it belongs to.
    const issue = await h.registry.issues.create({
      repoPath: '/r',
      title: 'Fix the thing',
      startNow: false,
    })
    const { sessionId } = await h.registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r',
    })

    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'why is this stuck?',
      focus: {
        view: 'workspace',
        worktreePath: '/r',
        issueId: issue.id,
        focusedSessionId: sessionId,
        visibleSessionIds: [sessionId],
      },
    })
    expect(h.turnReqs[0]?.prompt).toBe('why is this stuck?')
    const first = h.turnReqs[0]?.contextPrompt ?? ''
    expect(first).toContain('[USER VIEW @')
    expect(first).toContain(`#${issue.seq} "Fix the thing"`)
    expect(first).toContain('Worktree in view: /r')
    expect(first).toContain('Focused pane:')
    // The block sits closest to the user's message.
    expect(first.indexOf('[USER VIEW @')).toBeGreaterThan(first.indexOf('[SUPERAGENT CONTEXT]'))

    // And on LATER turns too — not just the primed first one.
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1' })
    await h.settle()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'and now?',
      focus: { view: 'issues' },
    })
    expect(h.turnReqs[1]?.prompt).toBe('and now?')
    const second = h.turnReqs[1]?.contextPrompt ?? ''
    expect(second).toContain('[USER VIEW @')
    expect(second).toContain('Screen: issues')
    expect(second).not.toContain('[SUPERAGENT CONTEXT]') // seed is first-turn only
  })

  it('omits the block entirely when the caller reports no focus (MCP/automation turns)', async () => {
    const h = await harness()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
    })
    expect(h.turnReqs[0]?.prompt).toBe('hi')
    expect(h.turnReqs[0]?.contextPrompt).not.toContain('[USER VIEW')
  })
})

describe('sendTurn (headless harness turns)', () => {
  it('cleans up an ordinary durable turn with the empty generic-account sentinel', async () => {
    const h = await harness()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'ordinary turn',
    })
    const request = h.turnReqs[0]!
    expect(request.accountId).toBe('')

    h.resolveTurn(request, { harnessSessionId: 'ordinary-harness' })
    await h.settle()

    expect(await h.registry.sessionStore.superagent.listPendingTurns()).toHaveLength(0)
    expect(h.turnAcks).toContainEqual({
      type: 'headlessTurnAck',
      sessionId: request.sessionId,
      turnId: request.turnId,
      requestDigest: request.requestDigest,
      accountId: asAccountId(''),
    })
  })

  it('acks before completion, creates the headless session, and dispatches the turn', async () => {
    const h = await harness()
    const ack = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hello',
    })
    expect(ack.threadId).toBe('global')
    expect(ack.podiumSessionId).toBeTruthy()
    // The turn was DISPATCHED but not completed — ack came first.
    expect(h.turnReqs).toHaveLength(1)
    const req = h.turnReqs[0]!
    // Global thread: machine context stays separate from the human message.
    expect(req.prompt).toBe('hello')
    expect(req.contextPrompt).toContain('[SUPERAGENT CONTEXT]')
    expect(req.contextPrompt).toContain('/r')
    expect(req.permissionMode).toBe('auto')
    expect(req.systemPrompt).toContain('superagent')
    expect(req.resumeValue).toBeUndefined() // first turn
    // First-turn sessionUuid is harness-specific (claude premints, codex does
    // not); the contract carries it when the caller mints one.
    // The headless Podium session exists: live, PTY-less, flagged, established
    // via spawn with runtimeContract headless (settings default frozen on).
    const meta = (await h.registry.modules.sessions
      .listSessions(undefined, 'rpc'))
      .find((s) => s.sessionId === ack.podiumSessionId)
    expect(meta).toMatchObject({ status: 'live', headless: true, spawnedBy: 'superagent:global' })
    expect(meta?.agentKind).toBeTruthy()
    expect(h.spawns).toHaveLength(1)
    expect(h.spawns[0]).toMatchObject({ sessionId: ack.podiumSessionId, agentKind: meta?.agentKind, runtimeContract: 'headless' })
    // The agent is frozen onto the thread row.
    expect((await h.registry.sessionStore.superagent.getSuperagentThread('global'))?.agentKind).toBe(
      meta?.agentKind,
    )
    expect(
      (await h.sa.listThreads(firstAdminMemberId())).find((thread) => thread.id === 'global')?.turnRunning,
    ).toBe(true)
    await expect(
      h.registry.modules.readToolkit.status(ack.podiumSessionId, 'operator'),
    ).resolves.toMatchObject({
      phase: 'working',
    })
    h.resolveTurn(req, { harnessSessionId: 'h1' })
    await h.settle()
    expect(
      (await h.sa.listThreads(firstAdminMemberId())).find((thread) => thread.id === 'global')?.turnRunning,
    ).toBe(false)
    await expect(
      h.registry.modules.readToolkit.status(ack.podiumSessionId, 'operator'),
    ).resolves.toMatchObject({
      phase: 'idle',
    })
  })

  it('forwards turn events + boundary markers as headlessActivity broadcasts', async () => {
    const h = await harness()
    const { podiumSessionId } = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
    })
    const req = h.turnReqs[0]!
    await h.registry.modules.sessions.runtimeGateway.record(h.registry.sessionStore.hostMachineId, {
      sessionId: podiumSessionId as never,
      event: {
        t: 'item',
        item: { kind: 'partial', item: { id: `headless:${req.turnId}:text`, role: 'assistant', text: 'thinking…', ts: new Date().toISOString() } },
        cursor: { segmentId: 's', components: { seq: 99 } },
        observerGeneration: 1,
        turnEpoch: 1,
        provenance: 'live',
        at: new Date().toISOString(),
      } as never,
    })
    h.resolveTurn(req, { harnessSessionId: 'h1' })
    await h.settle()
    const events = h.activity().map((m) => m.event)
    expect(events[0]).toEqual({ kind: 'turn-start' })
    expect(events).toContainEqual({ kind: 'partial-text', text: 'thinking…', itemHint: 'text' })
    expect(events.at(-1)).toEqual({ kind: 'turn-end' })
    expect(h.activity().every((m) => m.sessionId === podiumSessionId)).toBe(true)
  })

  it('persists the harness session id as the resume value after the first turn', async () => {
    const h = await harness()
    const { podiumSessionId } = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
    })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'harness-1' })
    await h.settle()
    // Thread row carries the harness session id…
    expect((await h.registry.sessionStore.superagent.getSuperagentThread('global'))?.harnessSessionId).toBe(
      'harness-1',
    )
    // …and the session's resume ref uses the same per-kind convention PTY rows use.
    const meta = (await h.registry.modules.sessions
      .listSessions(undefined, 'rpc'))
      .find((s) => s.sessionId === podiumSessionId)
    const kind = harnessResumeKind(meta?.agentKind ?? 'codex')
    expect(meta?.resume).toEqual({ kind, value: 'harness-1' })
    // Persisted (survives a reload).
    const row = (await h.registry.sessionStore.sessions
      .loadSessions())
      .find((r) => r.id === podiumSessionId)
    expect(row).toMatchObject({ resumeKind: kind, resumeValue: 'harness-1' })
    // The second turn resumes — same session, resumeValue set, no new uuid.
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'again',
    })
    const second = h.turnReqs[1]!
    expect(second.sessionId).toBe(podiumSessionId)
    expect(second.resumeValue).toBe('harness-1')
    expect(second.sessionUuid).toBeUndefined()
  })

  it('reasserts the normal budget on a resumed Claude thread after an expanded turn', async () => {
    const h = await harness()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'Give me a detailed walkthrough.',
    })
    const first = h.turnReqs[0]!
    expect(first.systemPrompt).toContain('EXPANDED:')
    h.resolveTurn(first, { harnessSessionId: 'claude-thread-1' })
    await h.settle()

    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'Why?',
    })
    const resumed = h.turnReqs[1]!
    expect(resumed.resumeValue).toBe('claude-thread-1')
    expect(resumed.systemPrompt).toContain(
      'NORMAL: HARD LIMIT ' + NORMAL_RESPONSE_WORD_LIMIT + ' words',
    )
    expect(resumed.systemPrompt).not.toContain('EXPANDED:')
  })

  /**
   * POD-782 INVERTED THIS TOO. A second send used to be REJECTED with "a turn is
   * already running" — the superagent was the one surface in the product where
   * typing a second thought lost it, and it has the longest turns in the
   * product, which is exactly when a person types again. It is now queued
   * durably and drained in arrival order when the running turn ends.
   *
   * ONE TURN AT A TIME IS UNCHANGED and is the invariant this asserts: the
   * queued message must NOT reach the daemon while the first turn is live (two
   * writers on one harness session), and must reach it — with its own text, in
   * order — the moment the first one finishes.
   */
  it('QUEUES a second send while a turn is running, and drains it in order', async () => {
    const h = await harness()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'one',
    })
    await expect(
      h.sa.sendTurn({
        ownerUserId: firstAdminMemberId(),
        threadId: asThreadId('global'),
        text: 'two',
      }),
    ).resolves.toMatchObject({ queued: true })
    await expect(
      h.sa.sendTurn({
        ownerUserId: firstAdminMemberId(),
        threadId: asThreadId('global'),
        text: 'three',
      }),
    ).resolves.toMatchObject({ queued: true })
    // Still exactly ONE turn in flight — the queue is not a second writer.
    expect(h.turnReqs).toHaveLength(1)

    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1' })
    await h.settle()
    // The drain took the OLDEST waiting message, not the newest.
    expect(h.turnReqs).toHaveLength(2)
    expect(h.turnReqs[1]?.prompt).toBe('two')

    h.resolveTurn(h.turnReqs[1]!, { harnessSessionId: 'h1' })
    await h.settle()
    expect(h.turnReqs).toHaveLength(3)
    expect(h.turnReqs[2]?.prompt).toBe('three')
  })

  it('a failed turn records a persisted notice, broadcasts the error, and unlocks', async () => {
    const h = await harness()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
    })
    h.resolveTurn(h.turnReqs[0]!, { ok: false, error: 'claude: command not found' })
    await h.settle()
    // Honest, persisted failure — no silent fallback to the buffered path. The
    // raw harness stderr is interpreted into a user-facing message (POD-1021):
    // "command not found" → a "CLI couldn't be launched" notice.
    const notice = (await h.sa
      .history(firstAdminMemberId(), asThreadId('global')))
      .find((m) => m.content.startsWith(TURN_FAILED_MARKER))
    expect(notice?.content).toMatch(/CLI couldn't be launched/)
    const last = h
      .activity()
      .map((m) => m.event)
      .at(-1)
    expect(last).toMatchObject({ kind: 'turn-end' })
    expect((last as { error?: string }).error).toMatch(/CLI couldn't be launched/)
    // No harness session was learned; the next send is a fresh first turn again.
    expect(
      (await h.registry.sessionStore.superagent.getSuperagentThread('global'))?.harnessSessionId,
    ).toBeUndefined()
    await expect(
      h.sa.sendTurn({
        ownerUserId: firstAdminMemberId(),
        threadId: asThreadId('global'),
        text: 'retry',
      }),
    ).resolves.toBeTruthy()
  })

  it('keeps legacy buffered history readable; successful turns add nothing to it', async () => {
    const h = await harness()
    const store = h.registry.sessionStore
    await store.superagent.appendSuperagentMessage(asThreadId('global'), {
      role: 'user',
      content: 'old question',
    })
    await store.superagent.appendSuperagentMessage(asThreadId('global'), {
      role: 'assistant',
      content: 'old answer',
    })
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'new turn',
    })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1', output: 'new answer' })
    await h.settle()
    // The transcript is the truth for new turns — superagent_messages is frozen.
    expect((await h.sa.history(firstAdminMemberId(), asThreadId('global'))).map((m) => m.content)).toEqual([
      'old question',
      'old answer',
    ])
  })

  it('rejects an unknown thread', async () => {
    const h = await harness()
    await expect(
      h.sa.sendTurn({
        ownerUserId: firstAdminMemberId(),
        threadId: asThreadId('btw_nope'),
        text: 'x',
      }),
    ).rejects.toThrow(/unknown thread/)
  })

  it('mounts MCP config + allowedTools for MCP-capable agents when the endpoint is up', async () => {
    const h = await harness()
    await h.sa.setMcpEndpoint('http://127.0.0.1:1878/mcp', 'route-tok', ['list_sessions', 'issue_list'])
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
    })
    const req = h.turnReqs[0]!
    expect(req.allowedTools).toContain('mcp__podium__issue_list')
    const cfg = JSON.parse(req.mcpConfig ?? '{}') as {
      mcpServers: Record<string, { url: string; headers: Record<string, string> }>
    }
    expect(cfg.mcpServers.podium?.url).toBe('http://127.0.0.1:1878/mcp')
    expect(cfg.mcpServers.podium?.headers['x-podium-mcp-token']).toBe('route-tok')
    expect(
      h.sa.threadForMcpToken(cfg.mcpServers.podium?.headers['x-podium-mcp-thread'] ?? ''),
    ).toBe('global')
  })
})

describe('conciergeTurn / startBtwTurn (thread creation on the headless path)', () => {
  it('first concierge turn prepends the tracker seed; re-entry prepends the event delta', async () => {
    const h = await harness()
    await h.registry.issues.create({ repoPath: '/r', title: 'Fix login', startNow: false })
    const a = await h.sa.conciergeTurn({
      ownerUserId: firstAdminMemberId(),
      repoPath: '/r',
      text: 'status?',
    })
    expect(a.isNew).toBe(true)
    const first = h.turnReqs[0]!
    expect(first.prompt).toBe('status?')
    expect(first.contextPrompt).toContain('[CONCIERGE CONTEXT]')
    expect(first.contextPrompt).toContain('Fix login')
    expect(first.systemPrompt).toContain('concierge for /r')
    expect(first.cwd).toBe('/r')
    h.resolveTurn(first, { harnessSessionId: 'hc1' })
    await h.settle()
    // New tracker activity → the next turn carries a delta, not a re-seed.
    await h.registry.issues.create({ repoPath: '/r', title: 'New work', startNow: false })
    const b = await h.sa.conciergeTurn({
      ownerUserId: firstAdminMemberId(),
      repoPath: '/r',
      text: 'what changed?',
    })
    expect(b.isNew).toBe(false)
    expect(b.threadId).toBe(a.threadId)
    const second = h.turnReqs[1]!
    expect(second.resumeValue).toBe('hc1')
    expect(second.prompt).toBe('what changed?')
    expect(second.contextPrompt).toContain('[CONCIERGE UPDATE')
    expect(second.contextPrompt).toContain('created "New work"')
    expect(second.contextPrompt).not.toContain('[CONCIERGE CONTEXT]')
    // No gap → no delta block on the third turn.
    h.resolveTurn(second)
    await h.settle()
    await h.sa.conciergeTurn({ ownerUserId: firstAdminMemberId(), repoPath: '/r', text: 'and now?' })
    expect(h.turnReqs[2]?.prompt).toBe('and now?')
    expect(h.turnReqs[2]?.contextPrompt).toBeUndefined()
  })

  it('rejects an unregistered repo without minting a thread', async () => {
    const h = await harness()
    await expect(
      h.sa.conciergeTurn({ ownerUserId: firstAdminMemberId(), repoPath: '/typo', text: 'hi' }),
    ).rejects.toThrow(/unknown repo/)
    expect(
      (await h.sa.listThreads(firstAdminMemberId())).filter((t) => t.kind === 'concierge'),
    ).toHaveLength(0)
  })

  it('startBtwTurn ensures the thread; the first send seeds from the origin transcript', async () => {
    const h = await harness()
    const { sessionId } = await h.registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    const res = await h.sa.startBtwTurn({ ownerUserId: firstAdminMemberId(), sessionId })
    expect(res).toEqual({ threadId: `btw_${sessionId}`, isNew: true })
    expect(await h.sa.startBtwTurn({ ownerUserId: firstAdminMemberId(), sessionId })).toEqual({
      threadId: `btw_${sessionId}`,
      isNew: false,
    })
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: res.threadId,
      text: 'what is this session doing?',
    })
    const req = h.turnReqs[0]!
    expect(req.prompt).toBe('what is this session doing?')
    expect(req.contextPrompt).toContain('[BTW CONTEXT]')
    expect(req.contextPrompt).toContain(sessionId)
    // Origin session's cwd rides the headless spawn, not the turn.
    const spawn = h.spawns.find((s) => s.sessionId === req.sessionId)
    expect(spawn?.cwd).toBe('/w')
  })

  it('attaches a session to a GLOBAL turn — the btw digest without the btw thread', async () => {
    // POD-1069: what "Ask superagent (BTW)" does now. The web pane binds the one
    // global thread (POD-782), so pointing it at `btw_<sessionId>` left it
    // rendering a thread with no headless session — blank, composer-less, and
    // stuck there until a reload. The digest rides the turn instead.
    const h = await harness()
    const { sessionId } = await h.registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })

    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'what is this session doing?',
      attachSessionId: sessionId,
    })

    const req = h.turnReqs[0]!
    expect(req.prompt).toBe('what is this session doing?')
    expect(req.contextPrompt).toContain('[BTW CONTEXT]')
    expect(req.contextPrompt).toContain(sessionId)
    // NO SECOND THREAD. The old action minted one per session; a thread nothing
    // renders is the whole defect, so this path must not create one.
    expect((await h.sa.listThreads(firstAdminMemberId())).filter((t) => t.kind === 'btw')).toHaveLength(0)
    // The turn still runs where the GLOBAL thread runs — an attachment is
    // context, not a change of machine or checkout.
    const spawn = h.spawns.find((s) => s.sessionId === req.sessionId)
    expect(spawn?.cwd).not.toBe('/w')
  })

  it('carries the attachment across the queue, so a turn that waits keeps its context', async () => {
    // The attachment is a column on the queued input, not an in-memory side map:
    // a second send lands behind a running turn and may only reach the harness
    // after a restart. Losing the session there would silently turn the
    // operator's question about a specific session into a general one.
    const h = await harness()
    const { sessionId } = await h.registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })

    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'first',
    })
    const second = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'and about this one?',
      attachSessionId: sessionId,
    })
    expect(second.queued).toBe(true)

    const queued = (await h.registry.sessionStore.superagent
      .listQueuedInputs(asThreadId('global')))
      .find((row) => row.text === 'and about this one?')
    expect(queued?.attachSessionId).toBe(sessionId)
  })
})

describe('openInTerminal + one-writer lock', () => {
  async function threadWithHarnessSession() {
    const h = await harness()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
    })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1' })
    await h.settle()
    return h
  }

  it('opens a normal PTY session with the per-agent resume ref and locks the thread', async () => {
    const h = await threadWithHarnessSession()
    const { sessionId } = await h.sa.openInTerminal({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
    })
    // A REAL spawn went to the daemon, carrying the harness resume ref.
    // (Plus the headless establishment spawn from the first turn.)
    expect(h.spawns).toHaveLength(2)
    const pty = h.spawns.find((s) => s.sessionId === sessionId)
    expect(pty).toMatchObject({
      sessionId,
      resume: { kind: harnessResumeKind(pty?.agentKind ?? 'codex'), value: 'h1' },
    })
    const meta = (await h.registry.modules.sessions.listSessions(undefined, 'rpc')).find((s) => s.sessionId === sessionId)
    expect(meta?.headless).toBeUndefined() // a normal PTY session
    expect(
      (await h.registry.sessionStore.superagent.getSuperagentThread('global'))?.terminalSessionId,
    ).toBe(sessionId)
    // One writer: sendTurn refuses while the terminal session is alive.
    await expect(
      h.sa.sendTurn({
        ownerUserId: firstAdminMemberId(),
        threadId: asThreadId('global'),
        text: 'x',
      }),
    ).rejects.toThrow(/open in a terminal/)
    // The lock clears lazily once the terminal session is gone.
    await h.registry.modules.sessions.killSession({ sessionId })
    await expect(
      h.sa.sendTurn({
        ownerUserId: firstAdminMemberId(),
        threadId: asThreadId('global'),
        text: 'x',
      }),
    ).resolves.toBeTruthy()
    expect(
      (await h.registry.sessionStore.superagent.getSuperagentThread('global'))?.terminalSessionId,
    ).toBeUndefined()
  })

  it('refuses before a harness session exists and while a turn is running', async () => {
    const h = await harness()
    await expect(
      h.sa.openInTerminal({ ownerUserId: firstAdminMemberId(), threadId: asThreadId('global') }),
    ).rejects.toThrow(/no harness session/)
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
    })
    await expect(
      h.sa.openInTerminal({ ownerUserId: firstAdminMemberId(), threadId: asThreadId('global') }),
    ).rejects.toThrow(/turn is running/)
  })

  it('interruptTurn routes to the headless session', async () => {
    const h = await harness()
    const { podiumSessionId } = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
    })
    await h.sa.interruptTurn({ ownerUserId: firstAdminMemberId(), threadId: asThreadId('global') })
    expect(h.interrupts).toEqual([podiumSessionId])
    await expect(
      h.sa.interruptTurn({ ownerUserId: firstAdminMemberId(), threadId: asThreadId('btw_none') }),
    ).rejects.toThrow(/unknown thread/)
  })
})

describe('boot reconciliation for headless sessions', () => {
  it('persists raw input before async context preparation and resumes it after restart', async () => {
    const h = await harness()
    const stalled = h.sa as unknown as {
      composeContext: () => Promise<undefined>
    }
    let preparationStarted!: () => void
    const preparing = new Promise<void>((resolve) => { preparationStarted = resolve })
    stalled.composeContext = () => {
      preparationStarted()
      return new Promise(() => {})
    }

    void h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'accepted before preparation',
      focus: { view: 'issues' },
    })
    await preparing
    expect(await h.registry.sessionStore.superagent.listQueuedInputs()).toMatchObject([
      {
        threadId: asThreadId('global'),
        text: 'accepted before preparation',
        focus: { view: 'issues' },
      },
    ])
    expect(await h.registry.sessionStore.superagent.listPendingTurns()).toHaveLength(0)

    const store = h.registry.sessionStore
    const reborn = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(reborn)
    const replayed: TurnReq[] = []
    await reborn.gateway.attachDaemon(reborn.sessionStore.hostMachineId, (message) => {
      if (message.type === 'headlessTurnRequest') replayed.push(message)
    })
    const repos = new RepoRegistry(reborn, store)
    const superagent = await SuperagentService.create(reborn.modules, repos, store)
    await superagent.setMcpEndpoint('http://127.0.0.1:1878/mcp', 'fresh-token')
    await new Promise((resolve) => setTimeout(resolve))

    expect(await store.superagent.listQueuedInputs()).toHaveLength(0)
    expect(await store.superagent.listPendingTurns()).toHaveLength(1)
    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toMatchObject({
      prompt: 'accepted before preparation',
      contextPrompt: expect.stringContaining('[USER VIEW @'),
    })
  })

  it('a prompt-box connector pick on a queued turn survives process restart', async () => {
    const h = await harness()
    const stalled = h.sa as unknown as {
      composeContext: () => Promise<undefined>
    }
    let preparationStarted!: () => void
    const preparing = new Promise<void>((resolve) => { preparationStarted = resolve })
    stalled.composeContext = () => {
      preparationStarted()
      return new Promise(() => {})
    }

    void h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'run on grok',
      agentKind: 'grok',
      model: 'grok-4.5',
    })
    await preparing
    expect((await h.registry.sessionStore.superagent.listQueuedInputs())[0]?.agentKind).toBe('grok')

    const store = h.registry.sessionStore
    const reborn = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(reborn)
    const replayed: TurnReq[] = []
    await reborn.gateway.attachDaemon(reborn.sessionStore.hostMachineId, (message) => {
      if (message.type === 'headlessTurnRequest') replayed.push(message)
    })
    const repos = new RepoRegistry(reborn, store)
    const superagent = await SuperagentService.create(reborn.modules, repos, store)
    await superagent.setMcpEndpoint('http://127.0.0.1:1878/mcp', 'fresh-token')
    await new Promise((resolve) => setTimeout(resolve))

    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toMatchObject({
      agent: 'grok',
      model: 'grok-4.5',
      prompt: 'run on grok',
    })
  })

  it('replays an accepted in-flight message with the same turn id after a server restart', async () => {
    const h = await harness()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'survive restart',
    })
    const original = h.turnReqs[0]!
    expect(await h.registry.sessionStore.superagent.listPendingTurns()).toHaveLength(1)

    const store = h.registry.sessionStore
    const reborn = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(reborn)
    const replayed: TurnReq[] = []
    const acknowledgements: TurnAck[] = []
    const rebornEpochs = new Map<string, number>()
    const rebornPending = new Map<string, { harnessSessionId?: string; output?: string }>()
    await reborn.gateway.attachDaemon(reborn.sessionStore.hostMachineId, (message) => {
      if (message.type === 'runtimeSendRequest' || message.type === 'runtimeDurableSendRequest') {
        const epoch = (rebornEpochs.get(message.sessionId) ?? 0) + 1
        rebornEpochs.set(message.sessionId, epoch)
        replayed.push({
          requestId: message.requestId,
          turnId: message.turnId,
          sessionId: message.sessionId,
          accountId: (message.accountId ?? '') as AccountId,
          requestDigest: message.requestDigest ?? '0'.repeat(64),
          prompt: message.text,
          ...(message.contextPrompt ? { contextPrompt: message.contextPrompt } : {}),
          ...(message.systemPrompt ? { systemPrompt: message.systemPrompt } : {}),
        })
        return
      }
      if (message.type === 'headlessTurnAck') acknowledgements.push(message)
      if (message.type === 'runtimeHistoryRequest') {
        const pending = rebornPending.get(message.sessionId)
        queueMicrotask(() =>
          reborn.gateway.routeDaemonFrame(reborn.sessionStore.hostMachineId, {
            type: 'runtimeHistoryResult',
            requestId: message.requestId,
            sessionId: message.sessionId,
            result: {
              page: {
                items: pending?.output ? [{ id: 'item-1', role: 'assistant', text: pending.output, ts: new Date().toISOString() }] : [],
                hasMore: false,
              },
            },
          }),
        )
        return
      }
      if (message.type === 'runtimeSnapshotRequest') {
        const pending = rebornPending.get(message.sessionId)
        queueMicrotask(() =>
          reborn.gateway.routeDaemonFrame(reborn.sessionStore.hostMachineId, {
            type: 'runtimeSnapshotResult',
            requestId: message.requestId,
            sessionId: message.sessionId,
            result: {
              snapshot: {
                binding: {
                  sessionId: message.sessionId,
                  driver: 'headless',
                  family: 'server',
                  harness: 'codex',
                  workdir: '/r',
                  resume: pending?.harnessSessionId ? { kind: 'headless-session', value: pending.harnessSessionId } : null,
                  process: { key: 'test' },
                  bindingVersion: 1,
                },
                state: {},
                cursor: { segmentId: 's', components: {} },
                observerGeneration: 1,
                turnEpoch: rebornEpochs.get(message.sessionId) ?? 1,
                interactions: [],
                at: new Date().toISOString(),
              },
            },
          }),
        )
        return
      }
    })
    const repos = new RepoRegistry(reborn, store)
    const superagent = await SuperagentService.create(reborn.modules, repos, store)
    await superagent.setMcpEndpoint('http://127.0.0.1:1878/mcp', 'fresh-token')
    await new Promise((resolve) => setTimeout(resolve))

    expect(replayed).toHaveLength(1)
    const replay = replayed[0]
    if (!replay) throw new Error('pending turn was not replayed')
    expect(replay).toMatchObject({
      turnId: original.turnId,
      sessionId: original.sessionId,
      prompt: 'survive restart',
    })
    expect(replay.contextPrompt).toContain('[SUPERAGENT CONTEXT]')

    // Same turnId replayed after restart (no rerun identity fork).
    rebornPending.set(replay.sessionId, { harnessSessionId: 'recovered-harness', output: 'done' })
    const epoch = rebornEpochs.get(replay.sessionId) ?? 1
    await reborn.gateway.routeDaemonFrame(reborn.sessionStore.hostMachineId, {
      type: 'runtimeSendResult',
      requestId: replay.requestId,
      sessionId: replay.sessionId as never,
      receipt: { outcome: 'accepted', turnEpoch: epoch, deliveredAs: 'when-ready', provenBy: 'protocol-ack', at: new Date().toISOString() },
    })
    const at = new Date().toISOString()
    const gateway = reborn.modules.sessions.runtimeGateway
    const host = reborn.sessionStore.hostMachineId
    await gateway.record(host, {
      sessionId: replay.sessionId as never,
      event: { t: 'turn', ev: { ev: 'started', turnEpoch: epoch, origin: 'system' }, cursor: { segmentId: 's', components: { seq: 1 } }, observerGeneration: 1, turnEpoch: epoch, provenance: 'live', at } as never,
    })
    await gateway.record(host, {
      sessionId: replay.sessionId as never,
      event: { t: 'turn', ev: { ev: 'completed', turnEpoch: epoch, verdict: 'done' }, cursor: { segmentId: 's', components: { seq: 2 } }, observerGeneration: 1, turnEpoch: epoch, provenance: 'live', at } as never,
    })
    await new Promise((resolve) => setTimeout(resolve))

    expect(await store.superagent.listPendingTurns()).toHaveLength(0)
    expect(acknowledgements).toContainEqual({
      type: 'headlessTurnAck',
      turnId: original.turnId,
      sessionId: original.sessionId,
      accountId: replay.accountId,
      requestDigest: replay.requestDigest,
    })
    await expect(
      superagent.sendTurn({
        ownerUserId: firstAdminMemberId(),
        threadId: asThreadId('global'),
        text: 'next message',
      }),
    ).resolves.toBeTruthy()
  })

  it('stays live across a restart and rebinds tails via headlessBind (no reattach probe)', async () => {
    const h = await harness()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
    })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'h1' })
    await h.settle()
    const sessionId =
      (await h.registry.sessionStore.superagent.getSuperagentThread('global'))?.podiumSessionId
    // "Restart": a fresh registry over the same store.
    const store = h.registry.sessionStore
    const reborn = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registries.push(reborn)
    const binds: BindReq[] = []
    const reattaches: string[] = []
    await reborn.gateway.attachDaemon(reborn.sessionStore.hostMachineId, (m) => {
      if (m.type === 'reattach' && m.runtimeContract === 'headless') {
        binds.push({ ...m, resumeValue: m.resume?.value } as BindReq)
        return
      }
      if (m.type === 'reattach') reattaches.push(m.sessionId)
    })
    await new Promise((r) => setTimeout(r))
    const meta = (await reborn.modules.sessions.listSessions(undefined, 'rpc')).find((s) => s.sessionId === sessionId)
    // Not demoted to reconnecting/exited — headless sessions have no PTY to probe.
    expect(meta?.status).toBe('live')
    expect(meta?.headless).toBe(true)
    expect(reattaches).not.toContain(sessionId)
    expect(binds).toHaveLength(1)
    expect(binds[0]).toMatchObject({
      sessionId,
      resumeValue: 'h1',
    })
  })
})

describe('harness switch + effort (#199)', () => {
  const setSuperagentHarness = async (
    h: Awaited<ReturnType<typeof harness>>,
    patch: { harness?: HarnessAgent; model?: string; effort?: string },
  ) => {
    const cur = await h.registry.sessionStore.settings.getSettings()
    const harness = patch.harness ?? 'claude-code'
    await h.registry.sessionStore.settings.setSettings({
      ...cur,
      roles: {
        ...cur.roles,
        superagent: {
          ...cur.roles.superagent,
          accountId: nativeAccountId(harness),
          harness,
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
        },
      },
    })
  }

  it('switches the harness when the setting changes, starting a fresh session', async () => {
    const h = await harness()
    // First turn freezes claude-code (explicit pick, not settings default)
    // and learns a harness session id.
    const first = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
      agentKind: 'claude-code',
    })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'claude-1' })
    await h.settle()
    expect(h.turnReqs[0]?.agent).toBeTruthy()

    // User picks a different harness in settings.
    await setSuperagentHarness(h, { harness: 'codex' })
    const second = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'still there?',
    })

    const req = h.turnReqs[1]!
    expect(req.agent).toBe('codex') // switched
    expect(req.resumeValue).toBeUndefined() // fresh session, not resuming claude-1
    expect(second.podiumSessionId).not.toBe(first.podiumSessionId) // new headless row
    // The thread is re-bound to the new harness.
    expect((await h.registry.sessionStore.superagent.getSuperagentThread('global'))?.agentKind).toBe(
      'codex',
    )
    expect(
      (await h.registry.sessionStore.superagent.getSuperagentThread('global'))?.harnessSessionId,
    ).toBeFalsy()
  })

  it('does not switch when the setting is unchanged (resumes)', async () => {
    const h = await harness()
    await setSuperagentHarness(h, { harness: 'claude-code' })
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
    })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'claude-1' })
    await h.settle()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'again',
    })
    expect(h.turnReqs[1]?.agent).toBe(h.turnReqs[0]?.agent)
    expect(h.turnReqs[1]?.resumeValue).toBe('claude-1') // same session
  })

  it('restartThread resets the harness session so the next turn is fresh', async () => {
    const h = await harness()
    const first = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
      agentKind: 'claude-code',
    })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'claude-1' })
    await h.settle()
    await h.sa.restartThread({ ownerUserId: firstAdminMemberId(), threadId: asThreadId('global') })
    const row = await h.registry.sessionStore.superagent.getSuperagentThread('global')
    expect(row?.harnessSessionId).toBeFalsy()
    expect(row?.podiumSessionId).toBeFalsy()
    expect(row?.agentKind).toBe('claude-code') // agent kept, only the session reset
    const second = await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'again',
    })
    expect(second.podiumSessionId).not.toBe(first.podiumSessionId) // fresh session
    expect(h.turnReqs[1]?.resumeValue).toBeUndefined()
  })

  it('plumbs harnessEffort into the turn request; auto sends none', async () => {
    const h = await harness()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
      effort: 'high',
    })
    expect(h.turnReqs[0]?.effort).toBe('high')

    const h2 = await harness()
    await h2.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
      effort: 'auto',
    })
    expect(h2.turnReqs[0]?.effort).toBeUndefined()
  })

  it('switches harness from a prompt-box agentKind without a settings change', async () => {
    const h = await harness()
    await setSuperagentHarness(h, { harness: 'claude-code' })
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
    })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'claude-1' })
    await h.settle()
    expect(h.turnReqs[0]?.agent).toBeTruthy()

    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'now grok',
      agentKind: 'grok',
      model: 'grok-4.5',
    })
    const req = h.turnReqs[1]!
    expect(req.agent).toBe('grok')
    expect(req.model).toBe('grok-4.5')
    expect(req.resumeValue).toBeUndefined()
    expect((await h.registry.sessionStore.superagent.getSuperagentThread('global'))?.agentKind).toBe('grok')
  })

  it('Auto after an explicit pick returns the thread to the settings harness', async () => {
    const h = await harness()
    await setSuperagentHarness(h, { harness: 'claude-code' })
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
      agentKind: 'grok',
      model: 'grok-4.5',
    })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'grok-1' })
    await h.settle()
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'back to default',
      model: 'auto',
    })
    // Back to the settings harness (a fresh session, not resuming grok-1).
    expect(h.turnReqs[1]?.agent).toBeTruthy()
    expect(h.turnReqs[1]?.agent).not.toBe('grok')
    expect(h.turnReqs[1]?.resumeValue).toBeUndefined()
  })

  it('drains a queued connector pick onto a fresh harness session', async () => {
    const h = await harness()
    await setSuperagentHarness(h, { harness: 'claude-code' })
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'one',
    })
    await expect(
      h.sa.sendTurn({
        ownerUserId: firstAdminMemberId(),
        threadId: asThreadId('global'),
        text: 'two on grok',
        agentKind: 'grok',
        model: 'grok-4.5',
      }),
    ).resolves.toMatchObject({ queued: true })
    expect(
      (await h.registry.sessionStore.superagent.listQueuedInputs(asThreadId('global')))[0]?.agentKind,
    ).toBe('grok')
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'claude-1' })
    await h.settle()
    expect(h.turnReqs[1]?.agent).toBe('grok')
    expect(h.turnReqs[1]?.model).toBe('grok-4.5')
    expect(h.turnReqs[1]?.resumeValue).toBeUndefined()
  })

  it('keeps a model override on its frozen harness when settings later change', async () => {
    const h = await harness()
    await setSuperagentHarness(h, { harness: 'claude-code' })
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
      model: 'opus',
    })
    h.resolveTurn(h.turnReqs[0]!, { harnessSessionId: 'claude-1' })
    await h.settle()
    await setSuperagentHarness(h, { harness: 'codex' })
    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'again',
    })
    // Frozen on the first harness despite the settings change.
    expect(h.turnReqs[1]?.agent).toBe(h.turnReqs[0]?.agent)
    expect(h.turnReqs[1]?.resumeValue).toBe('claude-1')
    expect(h.turnReqs[1]?.model).toBe('opus')
  })

  it('uses a native Codex superagent model even when coding uses another harness', async () => {
    const h = await harness()
    const current = await h.registry.sessionStore.settings.getSettings()
    await h.registry.sessionStore.settings.setSettings({
      ...current,
      roles: {
        ...current.roles,
        coding: {
          ...current.roles.coding,
          accountId: nativeAccountId('grok'),
          model: 'grok-build',
          effort: 'low',
        },
        // Existing settings blobs can predate the explicit harness field.
        superagent: {
          accountId: nativeAccountId('codex'),
          model: 'gpt-5.5',
          effort: 'xhigh',
        },
      },
    })

    await h.sa.sendTurn({
      ownerUserId: firstAdminMemberId(),
      threadId: asThreadId('global'),
      text: 'hi',
    })

    // Uses a native Codex model (gpt-*, not claude) even when coding uses another harness.
    expect(h.turnReqs[0]?.agent).toBe('codex')
    expect(h.turnReqs[0]?.model).toMatch(/^gpt-/)
    expect(h.turnReqs[0]?.effort).toBeTruthy()
  })
})

describe('buildHandoffSeed (#199)', () => {
  it('frames the handoff and digests the outgoing transcript', () => {
    const seed = buildHandoffSeed({
      from: 'claude-code',
      to: 'codex',
      items: [
        { id: '1', role: 'user', text: 'add a login page', ts: 't1' },
        { id: '2', role: 'assistant', text: 'done', ts: 't2' },
        { id: '3', role: 'tool', toolName: 'Edit', toolInput: 'login.tsx', text: '', ts: 't3' },
      ],
    })
    expect(seed).toContain('[HANDOFF]')
    expect(seed).toContain('from claude-code')
    expect(seed).toContain('to codex')
    expect(seed).toContain('add a login page') // user message carried verbatim
    expect(seed).toContain('Recap:') // deterministic recap included
  })

  it('is empty-safe', () => {
    expect(() => buildHandoffSeed({ from: 'codex', to: 'grok', items: [] })).not.toThrow()
  })
})
