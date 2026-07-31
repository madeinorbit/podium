import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentKind,
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  HarnessAgent,
} from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BindingStore,
  SESSION_BINDING_EVENTS,
  type SessionBindingRecord,
  type SessionBindingTransitionOutcome,
} from './binding-store'

const roots: string[] = []
const machineA = asMachineId('machine-a')
const machineB = asMachineId('machine-b')
const alice = asUserId('user:alice')
const bob = asUserId('user:bob')
const issueA = asIssueId('issue-a')

async function store(): Promise<BindingStore> {
  const root = await mkdtemp(join(tmpdir(), 'podium-binding-transitions-'))
  roots.push(root)
  return BindingStore.open({ dir: join(root, 'bindings') })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function applied(outcome: SessionBindingTransitionOutcome): SessionBindingRecord {
  if (outcome.status !== 'applied' && outcome.status !== 'unchanged') {
    throw new Error(`expected applied binding, got ${outcome.status}`)
  }
  return outcome.binding
}

async function spawn(
  bindings: BindingStore,
  session: string,
  agentKind: AgentKind,
  extra: Partial<Extract<Parameters<BindingStore['transition']>[0], { event: 'spawn' }>> = {},
): Promise<SessionBindingRecord> {
  return applied(
    await bindings.transition({
      event: 'spawn',
      transitionId: `spawn:${session}`,
      sessionId: asSessionId(session),
      agentKind,
      claimantMachineId: machineA,
      machineAccess: 'allowed',
      principal: { kind: 'user', userId: alice },
      issueId: issueA,
      ...extra,
    }),
  )
}

describe('SessionBinding transition vocabulary', () => {
  it('is exactly the five lifecycle events, with adopt admitted ahead of POD-644', () => {
    expect(SESSION_BINDING_EVENTS).toEqual([
      'spawn',
      'reattach',
      'hook-repin',
      'headless-allocation',
      'adopt',
    ])
  })

  it.each(
    AgentKind.options,
  )('SPAWN mints a narrow transport-derived delegation for %s', async (kind) => {
    const bindings = await store()
    const row = await spawn(bindings, `spawn-${kind}`, kind)
    const delegation = bindings.currentDelegation(row)

    expect(row.state).toBe('unbound')
    expect(row.observationGeneration).toBe(1)
    expect(delegation).toMatchObject({
      actor: `spawn-${kind}`,
      onBehalfOf: alice,
      grantedScope: { kind: 'subtree', rootId: issueA },
      parentBindingId: null,
    })
    expect(row).not.toHaveProperty('capability')
    expect(row).not.toHaveProperty('rights')
  })

  it('SPAWN admits a broad human scope only after the existing confirmation path', async () => {
    const bindings = await store()
    const rejected = await bindings.transition({
      event: 'spawn',
      transitionId: 'spawn:wide-no',
      sessionId: asSessionId('wide-no'),
      agentKind: 'codex',
      claimantMachineId: machineA,
      machineAccess: 'allowed',
      principal: { kind: 'user', userId: alice },
      issueId: issueA,
      requestedScope: { kind: 'all' },
    })
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: 'scope-widening-denied',
      terminal: true,
    })
    expect(await bindings.read(asSessionId('wide-no'))).toBeNull()

    const broad = await spawn(bindings, 'wide-yes', 'codex', {
      requestedScope: { kind: 'all' },
      scopeOverrideConfirmed: true,
    })
    expect(bindings.currentDelegation(broad)?.grantedScope).toEqual({ kind: 'all' })
  })

  it('SUB-AGENT SPAWN chains the root human, narrows, and rejects widening visibly', async () => {
    const bindings = await store()
    const parent = await spawn(bindings, 'parent', 'claude-code')
    const child = applied(
      await bindings.transition({
        event: 'spawn',
        transitionId: 'spawn:child',
        sessionId: asSessionId('child'),
        agentKind: 'codex',
        claimantMachineId: machineA,
        machineAccess: 'allowed',
        principal: { kind: 'agent', parentBindingId: parent.sessionId },
        requestedScope: { kind: 'none' },
      }),
    )
    expect(bindings.currentDelegation(child)).toMatchObject({
      onBehalfOf: alice,
      grantedScope: { kind: 'none' },
      parentBindingId: parent.sessionId,
    })

    const widening = await bindings.transition({
      event: 'spawn',
      transitionId: 'spawn:child-wide',
      sessionId: asSessionId('child-wide'),
      agentKind: 'grok',
      claimantMachineId: machineA,
      machineAccess: 'allowed',
      principal: { kind: 'agent', parentBindingId: parent.sessionId },
      requestedScope: { kind: 'all' },
      scopeOverrideConfirmed: true,
    })
    expect(widening).toMatchObject({
      status: 'rejected',
      reason: 'scope-widening-denied',
      terminal: true,
    })
    expect(await bindings.read(asSessionId('child-wide'))).toBeNull()
  })

  it.each(AgentKind.options)('REATTACH carries delegation byte-for-byte for %s', async (kind) => {
    const bindings = await store()
    const before = await spawn(bindings, `reattach-${kind}`, kind)
    const delegation = JSON.stringify(before.delegationHistory)
    const after = applied(
      await bindings.transition({
        event: 'reattach',
        transitionId: `reattach:${kind}:2`,
        sessionId: before.sessionId,
        claimantMachineId: machineA,
        machineAccess: 'allowed',
        sessionAccess: 'allowed',
        principal: { kind: 'user', userId: alice },
        requestedGeneration: 2,
        attemptId: `attempt-${kind}`,
      }),
    )
    expect(after.observationGeneration).toBe(2)
    expect(JSON.stringify(after.delegationHistory)).toBe(delegation)
  })

  it('two same-principal reattaches produce one durable winner and one redundant result', async () => {
    const bindings = await store()
    const before = await spawn(bindings, 'same-principal-race', 'codex')
    const request = (transitionId: string) =>
      bindings.transition({
        event: 'reattach',
        transitionId,
        sessionId: before.sessionId,
        claimantMachineId: machineA,
        machineAccess: 'allowed',
        sessionAccess: 'allowed',
        principal: { kind: 'user' as const, userId: alice },
        requestedGeneration: 2,
        attemptId: 'podium-same-principal-race',
      })

    const outcomes = await Promise.all([request('race:same:a'), request('race:same:b')])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['applied', 'redundant'])

    const persisted = await BindingStore.open({ dir: bindings.dir })
    const row = await persisted.read(before.sessionId)
    expect(row?.observationGeneration).toBe(2)
    expect(row?.transitionHistory.filter((entry) => entry.event === 'reattach')).toEqual([
      expect.objectContaining({
        transitionId: 'race:same:a',
        reattachClaim: {
          principal: { kind: 'user', userId: alice },
          requestedGeneration: 2,
          attemptId: 'podium-same-principal-race',
        },
      }),
    ])
    expect(
      (
        await persisted.transition({
          event: 'reattach',
          transitionId: 'race:same:after-restart',
          sessionId: before.sessionId,
          claimantMachineId: machineA,
          machineAccess: 'allowed',
          sessionAccess: 'allowed',
          principal: { kind: 'user', userId: alice },
          requestedGeneration: 2,
          attemptId: 'podium-same-principal-race',
        })
      ).status,
    ).toBe('redundant')
  })

  it.each([
    ['alice-first', alice, bob],
    ['bob-first', bob, alice],
  ])('two-principal reattach race is deterministic when %s', async (_case, first, second) => {
    const bindings = await store()
    const before = await spawn(bindings, `two-principal-race-${_case}`, 'claude-code')
    const request = (transitionId: string, userId: typeof alice) =>
      bindings.transition({
        event: 'reattach',
        transitionId,
        sessionId: before.sessionId,
        claimantMachineId: machineA,
        machineAccess: 'allowed',
        sessionAccess: 'allowed',
        principal: { kind: 'user' as const, userId },
        requestedGeneration: 2,
        attemptId: `podium-two-principal-race-${_case}`,
      })

    const outcomes = await Promise.all([
      request(`race:${_case}:first`, first),
      request(`race:${_case}:second`, second),
    ])
    expect(outcomes[0]?.status).toBe('applied')
    expect(outcomes[1]).toEqual({
      status: 'denied',
      event: 'reattach',
      reason: 'not-claimant',
      terminal: true,
    })

    const row = await bindings.read(before.sessionId)
    expect(
      row?.transitionHistory.findLast((entry) => entry.event === 'reattach')?.reattachClaim
        ?.principal,
    ).toEqual({ kind: 'user', userId: first })
    // Reattach ownership is arbitration metadata only. It cannot rewrite the
    // agent's human or widen the scope it was spawned with.
    expect(row && bindings.currentDelegation(row)).toMatchObject({
      onBehalfOf: alice,
      grantedScope: { kind: 'subtree', rootId: issueA },
    })

    const unreachable = await bindings.transition({
      event: 'reattach',
      transitionId: `race:${_case}:offline`,
      sessionId: before.sessionId,
      claimantMachineId: machineA,
      machineAccess: 'unreachable',
      sessionAccess: 'allowed',
      principal: { kind: 'user', userId: second },
      requestedGeneration: 3,
    })
    expect(unreachable).toEqual({
      status: 'unreachable',
      event: 'reattach',
      reason: 'machine-unreachable',
      terminal: true,
    })
  })

  it('keeps invisible and nonexistent sessions uniform below policy', async () => {
    const bindings = await store()
    const existing = await spawn(bindings, 'private-session', 'grok')
    const denied = {
      event: 'reattach' as const,
      transitionId: 'invisible',
      claimantMachineId: machineA,
      // If arbitration consulted placement first, this would leak that the
      // invisible session names a visible-but-denied machine.
      machineAccess: 'denied' as const,
      sessionAccess: 'not-found' as const,
      principal: { kind: 'user' as const, userId: bob },
      requestedGeneration: 2,
    }
    const invisible = await bindings.transition({ ...denied, sessionId: existing.sessionId })
    const missing = await bindings.transition({
      ...denied,
      transitionId: 'missing',
      sessionId: asSessionId('no-such-session'),
    })

    const uniform = {
      status: 'denied',
      event: 'reattach',
      reason: 'not-found',
      terminal: true,
    }
    expect(invisible).toEqual(uniform)
    expect(missing).toEqual(uniform)
    expect((await bindings.read(existing.sessionId))?.transitionHistory).toHaveLength(1)
  })

  it('HOOK-REPIN consumes hook and process receipts as sources of the same event', async () => {
    const bindings = await store()
    const before = await spawn(bindings, 'repin', 'codex')
    const delegation = JSON.stringify(before.delegationHistory)
    const hook = applied(
      await bindings.transition({
        event: 'hook-repin',
        transitionId: 'repin:hook:a',
        sessionId: before.sessionId,
        evidenceSource: 'hook-receipt',
        value: 'thread-a',
        nativeKind: 'codex-thread',
        observedAt: '2026-07-31T10:00:00.000Z',
      }),
    )
    const process = applied(
      await bindings.transition({
        event: 'hook-repin',
        transitionId: 'repin:process:a',
        sessionId: before.sessionId,
        evidenceSource: 'process-ownership-receipt',
        value: 'thread-a',
        nativeKind: 'codex-thread',
        observedAt: '2026-07-31T10:00:01.000Z',
      }),
    )

    expect(process.observations.map((row) => [row.channel, row.source, row.value])).toEqual([
      ['resume-ref', 'native-hook', 'thread-a'],
      ['resume-ref', 'process', 'thread-a'],
    ])
    expect(process.transitionHistory.map((row) => row.event)).toEqual([
      'spawn',
      'hook-repin',
      'hook-repin',
    ])
    expect(JSON.stringify(process.delegationHistory)).toBe(delegation)

    const conflict = applied(
      await bindings.transition({
        event: 'hook-repin',
        transitionId: 'repin:process:b',
        sessionId: hook.sessionId,
        evidenceSource: 'process-ownership-receipt',
        value: 'thread-b',
        nativeKind: 'codex-thread',
        observedAt: '2026-07-31T10:00:02.000Z',
      }),
    )
    expect(conflict.state).toBe('conflicted')
  })

  it.each(
    HarnessAgent.options,
  )('HOOK-REPIN preserves delegation for %s', async (kind) => {
    const bindings = await store()
    const before = await spawn(bindings, `hook-${kind}`, kind)
    const delegation = JSON.stringify(before.delegationHistory)
    const after = applied(
      await bindings.transition({
        event: 'hook-repin',
        transitionId: `hook:${kind}`,
        sessionId: before.sessionId,
        evidenceSource: 'hook-receipt',
        value: `native-${kind}`,
        nativeKind: `${kind}-session`,
        observedAt: '2026-07-31T10:30:00.000Z',
      }),
    )
    expect(after.state).toBe('bound')
    expect(JSON.stringify(after.delegationHistory)).toBe(delegation)
  })


  it.each(
    HarnessAgent.options,
  )('HEADLESS ALLOCATION binds %s without touching delegation', async (kind) => {
    const bindings = await store()
    const before = await spawn(bindings, `headless-${kind}`, kind)
    const delegation = JSON.stringify(before.delegationHistory)
    const after = applied(
      await bindings.transition({
        event: 'headless-allocation',
        transitionId: `headless:${kind}:attempt-1`,
        sessionId: before.sessionId,
        attemptId: 'attempt-1',
        nativeKind: `${kind}-session`,
        value: `native-${kind}`,
        observedAt: '2026-07-31T11:00:00.000Z',
      }),
    )
    expect(after.state).toBe('bound')
    expect(after.observations.at(-1)).toMatchObject({
      channel: 'resume-ref',
      source: 'headless-driver',
      value: `native-${kind}`,
    })
    expect(JSON.stringify(after.delegationHistory)).toBe(delegation)
  })

  it('shell visibly rejects native repin and headless allocation', async () => {
    const bindings = await store()
    const shell = await spawn(bindings, 'shell-no-native', 'shell')
    for (const transition of [
      {
        event: 'hook-repin' as const,
        transitionId: 'shell:repin',
        sessionId: shell.sessionId,
        evidenceSource: 'hook-receipt' as const,
        value: 'impossible',
        nativeKind: 'shell',
        observedAt: '2026-07-31T11:00:00.000Z',
      },
      {
        event: 'headless-allocation' as const,
        transitionId: 'shell:headless',
        sessionId: shell.sessionId,
        attemptId: 'attempt',
        nativeKind: 'shell',
        value: 'impossible',
        observedAt: '2026-07-31T11:00:00.000Z',
      },
    ]) {
      expect(await bindings.transition(transition)).toMatchObject({
        status: 'rejected',
        reason: 'unsupported-agent-transition',
      })
    }
  })

  it.each(AgentKind.options)('ADOPT carries delegation unchanged for %s', async (kind) => {
    const bindings = await store()
    const before = await spawn(bindings, `adopt-${kind}`, kind)
    const delegation = JSON.stringify(before.delegationHistory)
    await bindings.transition({
      event: 'adopt',
      transitionId: `adopt:${kind}:claim`,
      sessionId: before.sessionId,
      machineAccess: 'allowed',
      transferId: `transfer-${kind}`,
      phase: 'claim',
      fromMachineId: machineA,
      toMachineId: machineB,
      at: '2026-07-31T12:00:00.000Z',
    })
    const committed = applied(
      await bindings.transition({
        event: 'adopt',
        transitionId: `adopt:${kind}:commit`,
        sessionId: before.sessionId,
        machineAccess: 'allowed',
        transferId: `transfer-${kind}`,
        phase: 'commit',
        fromMachineId: machineA,
        toMachineId: machineB,
        at: '2026-07-31T12:00:01.000Z',
      }),
    )
    expect(committed.claimantMachineId).toBe(machineB)
    expect(JSON.stringify(committed.delegationHistory)).toBe(delegation)
  })

  it('machine-use denial is a stable terminal outcome distinct from unreachable', async () => {
    const bindings = await store()
    const base = {
      event: 'spawn' as const,
      sessionId: asSessionId('placement'),
      agentKind: 'codex' as const,
      claimantMachineId: machineA,
      principal: { kind: 'user' as const, userId: alice },
      issueId: issueA,
    }
    expect(
      await bindings.transition({
        ...base,
        transitionId: 'placement:denied',
        machineAccess: 'denied',
      }),
    ).toEqual({
      status: 'denied',
      event: 'spawn',
      reason: 'machine-use-denied',
      terminal: true,
    })
    expect(
      await bindings.transition({
        ...base,
        transitionId: 'placement:offline',
        machineAccess: 'unreachable',
      }),
    ).toEqual({
      status: 'unreachable',
      event: 'spawn',
      reason: 'machine-unreachable',
      terminal: true,
    })
    expect(await bindings.read(base.sessionId)).toBeNull()
  })

  it('is idempotent by transition id and never writes a rights snapshot', async () => {
    const bindings = await store()
    const first = await spawn(bindings, 'idempotent', 'opencode')
    const repeated = applied(
      await bindings.transition({
        event: 'spawn',
        transitionId: 'spawn:idempotent',
        sessionId: first.sessionId,
        agentKind: 'opencode',
        claimantMachineId: machineA,
        machineAccess: 'allowed',
        principal: { kind: 'user', userId: alice },
        issueId: issueA,
      }),
    )
    expect(repeated.transitionHistory).toHaveLength(1)

    const persisted = JSON.parse(await readFile(bindings.pathFor(first.sessionId), 'utf8'))
    const found: string[] = []
    const forbidden =
      /capabilit|effectiveright|rights?|permission|privileg|entitlement|grant|role|acl/i
    const walk = (value: unknown, path = ''): void => {
      if (Array.isArray(value)) {
        value.forEach((entry) => {
          walk(entry, `${path}[]`)
        })
        return
      }
      if (!value || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        const next = path ? `${path}.${key}` : key
        if (forbidden.test(key)) found.push(next)
        walk(child, next)
      }
    }
    walk(persisted)
    expect(found).toEqual(['delegationHistory[].grantedScope'])
  })
})
