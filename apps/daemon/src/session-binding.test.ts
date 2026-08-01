import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentKind,
  asAgentIdentityId,
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  HarnessAgent,
} from '@podium/model'
import { afterEach, describe, expect, it } from 'vitest'
import {
  arbitrateBindingOwnership,
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

const delegationOperand = (binding: SessionBindingRecord) => {
  const delegation = binding.delegationHistory.at(-1)
  if (!delegation) throw new Error('delegation missing')
  return {
    actor: delegation.actor,
    onBehalfOf: delegation.onBehalfOf,
    grantedScope: delegation.grantedScope,
    parentBindingId: delegation.parentBindingId,
  }
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
  it('is exactly the six lifecycle events, including adopt and terminal retire', () => {
    expect(SESSION_BINDING_EVENTS).toEqual([
      'spawn',
      'reattach',
      'hook-repin',
      'headless-allocation',
      'adopt',
      'retire',
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

  it('applies one transitionId exactly once when 30 identical reattaches arrive together', async () => {
    const bindings = await store()
    const before = await spawn(bindings, 'same-transition-race', 'codex')
    const request = () =>
      bindings.transition({
        event: 'reattach',
        transitionId: 'race:same-transition',
        sessionId: before.sessionId,
        claimantMachineId: machineA,
        machineAccess: 'allowed',
        sessionAccess: 'allowed',
        principal: { kind: 'user' as const, userId: alice },
        requestedGeneration: 2,
        attemptId: 'attempt-same-transition',
      })

    const outcomes = await Promise.all(Array.from({ length: 30 }, request))
    expect(outcomes.filter((outcome) => outcome.status === 'applied')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'unchanged')).toHaveLength(29)

    const persisted = await BindingStore.open({ dir: bindings.dir })
    const row = await persisted.read(before.sessionId)
    expect(row).toMatchObject({
      observationGeneration: 2,
      attemptId: 'attempt-same-transition',
    })
    expect(
      row?.transitionHistory.filter((entry) => entry.transitionId === 'race:same-transition'),
    ).toHaveLength(1)
  })

  it('reattaches a 30-session reconnect burst without cross-wiring durable observations', async () => {
    const bindings = await store()
    const sessions = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        spawn(bindings, `reconnect-burst-${index}`, 'codex', {
          attemptId: `attempt-before-${index}`,
        }),
      ),
    )
    await Promise.all(
      sessions.map((session, index) =>
        bindings.transition({
          event: 'hook-repin',
          transitionId: `burst:hook:${index}`,
          sessionId: session.sessionId,
          evidenceSource: 'hook-receipt',
          value: `native-${index}`,
          nativeKind: 'codex-thread',
          observedAt: `2026-07-31T10:00:${String(index).padStart(2, '0')}.000Z`,
          pendingServerAck: { nativeKind: 'codex-thread', value: `native-${index}` },
        }),
      ),
    )

    const outcomes = await Promise.all(
      sessions.map((session, index) =>
        bindings.transition({
          event: 'reattach',
          transitionId: `burst:reattach:${index}`,
          sessionId: session.sessionId,
          claimantMachineId: machineA,
          machineAccess: 'allowed',
          sessionAccess: 'allowed',
          principal: { kind: 'user' as const, userId: alice },
          requestedGeneration: 2,
          attemptId: `attempt-after-${index}`,
        }),
      ),
    )
    expect(outcomes.every((outcome) => outcome.status === 'applied')).toBe(true)

    const persisted = await BindingStore.open({ dir: bindings.dir })
    const rows = await Promise.all(sessions.map((session) => persisted.read(session.sessionId)))
    expect(rows).toHaveLength(30)
    rows.forEach((row, index) => {
      expect(row).toMatchObject({
        sessionId: `reconnect-burst-${index}`,
        observationGeneration: 2,
        attemptId: `attempt-after-${index}`,
      })
      expect(
        row?.observations.map((entry) => ({
          value: entry.value,
          pendingServerAck: entry.pendingServerAck,
        })),
      ).toEqual([
        {
          value: `native-${index}`,
          pendingServerAck: { nativeKind: 'codex-thread', value: `native-${index}` },
        },
      ])
      expect(row?.transitionHistory.map((entry) => entry.event)).toEqual([
        'spawn',
        'hook-repin',
        'reattach',
      ])
    })
  })

  it.each([
    'reattach-first',
    'hook-first',
  ] as const)('serializes a reattach racing hook-repin without losing either write (%s)', async (order) => {
    const bindings = await store()
    const before = await spawn(bindings, `mixed-race-${order}`, 'codex', {
      attemptId: 'attempt-before',
    })
    const delegation = JSON.stringify(before.delegationHistory)
    const reattach = () =>
      bindings.transition({
        event: 'reattach',
        transitionId: `mixed:${order}:reattach`,
        sessionId: before.sessionId,
        claimantMachineId: machineA,
        machineAccess: 'allowed',
        sessionAccess: 'allowed',
        principal: { kind: 'user' as const, userId: alice },
        requestedGeneration: 2,
        attemptId: 'attempt-after',
      })
    const hook = () =>
      bindings.transition({
        event: 'hook-repin',
        transitionId: `mixed:${order}:hook`,
        sessionId: before.sessionId,
        evidenceSource: 'hook-receipt',
        value: `native-${order}`,
        nativeKind: 'codex-thread',
        observedAt: '2026-07-31T11:00:00.000Z',
        pendingServerAck: {
          nativeKind: 'codex-thread',
          value: `native-${order}`,
        },
      })
    const operations = order === 'reattach-first' ? [reattach, hook] : [hook, reattach]

    const outcomes = await Promise.all(operations.map((operation) => operation()))
    expect(outcomes.every((outcome) => outcome.status === 'applied')).toBe(true)

    const persisted = await BindingStore.open({ dir: bindings.dir })
    const row = await persisted.read(before.sessionId)
    expect(row).toMatchObject({
      state: 'bound',
      observationGeneration: 2,
      attemptId: 'attempt-after',
    })
    expect(row?.observations).toEqual([
      expect.objectContaining({
        channel: 'resume-ref',
        value: `native-${order}`,
        pendingServerAck: {
          nativeKind: 'codex-thread',
          value: `native-${order}`,
        },
      }),
    ])
    expect(row?.transitionHistory.map((entry) => entry.event)).toEqual([
      'spawn',
      ...(order === 'reattach-first'
        ? (['reattach', 'hook-repin'] as const)
        : (['hook-repin', 'reattach'] as const)),
    ])
    expect(JSON.stringify(row?.delegationHistory)).toBe(delegation)
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

  it.each(HarnessAgent.options)('HOOK-REPIN preserves delegation for %s', async (kind) => {
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

  it.each(
    AgentKind.options,
  )('ADOPT moves %s across hosts without re-minting the importing principal', async (kind) => {
    const source = await store()
    const target = await store()
    const before = await spawn(source, `adopt-${kind}`, kind, {
      attemptId: `source-attempt-${kind}`,
    })
    expect(before.attemptId).toBe(`source-attempt-${kind}`)
    const delegation = delegationOperand(before)
    const transferId = `transfer-${kind}`
    const sourceClaim = applied(
      await source.transition({
        event: 'adopt',
        transitionId: `adopt:${kind}:claim`,
        sessionId: before.sessionId,
        machineAccess: 'allowed',
        transferId,
        role: 'source',
        phase: 'claim',
        fromMachineId: machineA,
        toMachineId: machineB,
        at: '2026-07-31T12:00:00.000Z',
      }),
    )
    expect(sourceClaim).toMatchObject({ state: 'exporting', attemptId: null })

    const carried = source.currentDelegation(sourceClaim)
    if (!carried) throw new Error('source delegation missing')
    const targetClaim = applied(
      await target.transition({
        event: 'adopt',
        transitionId: `adopt:${kind}:target-claim`,
        sessionId: before.sessionId,
        machineAccess: 'allowed',
        transferId,
        role: 'target',
        phase: 'claim',
        fromMachineId: machineA,
        toMachineId: machineB,
        at: '2026-07-31T12:00:00.500Z',
        adoption: {
          agentKind: kind,
          observationGeneration: before.observationGeneration + 1,
          delegation: {
            actor: carried.actor,
            onBehalfOf: carried.onBehalfOf,
            grantedScope: carried.grantedScope,
            parentBindingId: carried.parentBindingId,
          },
          observations: [
            { channel: 'resume-ref', nativeKind: `native-${kind}`, value: `id-${kind}` },
            { channel: 'cwd', value: `/target/${kind}` },
            { channel: 'worktree-pin', value: `/target/${kind}` },
          ],
        },
      }),
    )
    expect(targetClaim).toMatchObject({
      sessionId: before.sessionId,
      claimantMachineId: machineB,
      state: 'adopting',
      attemptId: null,
    })
    // BORN-PIN: imported native and worktree observations exist before commit or launch.
    expect(targetClaim.observations.slice(-3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'cwd',
          value: `/target/${kind}`,
          source: 'handoff-import',
        }),
        expect.objectContaining({
          channel: 'worktree-pin',
          value: `/target/${kind}`,
          source: 'handoff-import',
        }),
      ]),
    )

    const sourceCommitted = applied(
      await source.transition({
        event: 'adopt',
        transitionId: `adopt:${kind}:source-commit`,
        sessionId: before.sessionId,
        machineAccess: 'allowed',
        transferId,
        role: 'source',
        phase: 'commit',
        fromMachineId: machineA,
        toMachineId: machineB,
        at: '2026-07-31T12:00:01.000Z',
      }),
    )
    const targetCommitted = applied(
      await target.transition({
        event: 'adopt',
        transitionId: `adopt:${kind}:target-commit`,
        sessionId: before.sessionId,
        machineAccess: 'allowed',
        transferId,
        role: 'target',
        phase: 'commit',
        fromMachineId: machineA,
        toMachineId: machineB,
        at: '2026-07-31T12:00:01.100Z',
      }),
    )
    expect(sourceCommitted).toMatchObject({ state: 'exported', attemptId: null })
    expect(targetCommitted).toMatchObject({ state: 'bound', claimantMachineId: machineB })
    expect(delegationOperand(targetCommitted)).toEqual(delegation)
    // The importing machine is Bob's. ADOPT has no importer identity input, so
    // importing Alice's session cannot turn Bob into its human.
    expect(JSON.stringify(targetCommitted.delegationHistory)).not.toContain('bob')
  })

  it('round-trip A→B→A reuses the terminal source row and advances observations', async () => {
    const a = await store()
    const b = await store()
    const original = await spawn(a, 'round-trip', 'codex')
    const delegation = a.currentDelegation(original)
    if (!delegation) throw new Error('delegation missing')
    const adopt = async (
      source: BindingStore,
      target: BindingStore,
      fromMachineId: typeof machineA,
      toMachineId: typeof machineA,
      transferId: string,
      generation: number,
      cwd: string,
    ) => {
      applied(
        await source.transition({
          event: 'adopt',
          transitionId: `${transferId}:source-claim`,
          sessionId: original.sessionId,
          machineAccess: 'allowed',
          transferId,
          role: 'source',
          phase: 'claim',
          fromMachineId,
          toMachineId,
          at: '2026-07-31T13:00:00.000Z',
        }),
      )
      applied(
        await target.transition({
          event: 'adopt',
          transitionId: `${transferId}:target-claim`,
          sessionId: original.sessionId,
          machineAccess: 'allowed',
          transferId,
          role: 'target',
          phase: 'claim',
          fromMachineId,
          toMachineId,
          at: '2026-07-31T13:00:00.100Z',
          adoption: {
            agentKind: 'codex',
            observationGeneration: generation,
            delegation: {
              actor: delegation.actor,
              onBehalfOf: delegation.onBehalfOf,
              grantedScope: delegation.grantedScope,
              parentBindingId: delegation.parentBindingId,
            },
            observations: [
              {
                channel: 'rollout-path',
                nativeKind: 'codex-thread',
                value: `${cwd}/rollout.jsonl`,
              },
              { channel: 'worktree-pin', value: cwd },
            ],
          },
        }),
      )
      applied(
        await source.transition({
          event: 'adopt',
          transitionId: `${transferId}:source-commit`,
          sessionId: original.sessionId,
          machineAccess: 'allowed',
          transferId,
          role: 'source',
          phase: 'commit',
          fromMachineId,
          toMachineId,
          at: '2026-07-31T13:00:00.200Z',
        }),
      )
      return applied(
        await target.transition({
          event: 'adopt',
          transitionId: `${transferId}:target-commit`,
          sessionId: original.sessionId,
          machineAccess: 'allowed',
          transferId,
          role: 'target',
          phase: 'commit',
          fromMachineId,
          toMachineId,
          at: '2026-07-31T13:00:00.300Z',
        }),
      )
    }
    const onB = await adopt(a, b, machineA, machineB, 'a-to-b', 2, '/b/worktree')
    const backOnA = await adopt(b, a, machineB, machineA, 'b-to-a', 3, '/a/stale-reused')
    expect(onB).toMatchObject({ claimantMachineId: machineB, observationGeneration: 2 })
    expect(backOnA).toMatchObject({
      claimantMachineId: machineA,
      observationGeneration: 3,
      state: 'bound',
    })
    expect(backOnA.observations.at(-1)).toMatchObject({
      channel: 'worktree-pin',
      value: '/a/stale-reused',
    })
    expect(delegationOperand(backOnA)).toEqual(delegationOperand(original))
  })

  it('post-crash arbitration is order-independent and authorization remains live', async () => {
    const sessionId = asSessionId('post-crash-race')
    const sourceClaim = {
      sessionId,
      machineId: machineA,
      transferId: 'transfer',
      role: 'source' as const,
      phase: 'claimed' as const,
    }
    const targetClaim = {
      sessionId,
      machineId: machineB,
      transferId: 'transfer',
      role: 'target' as const,
      phase: 'claimed' as const,
    }
    expect(arbitrateBindingOwnership(sourceClaim, targetClaim)).toBe(targetClaim)
    expect(arbitrateBindingOwnership(targetClaim, sourceClaim)).toBe(targetClaim)
    const unrelated = { ...sourceClaim, transferId: 'z-transfer', machineId: machineB }
    expect(arbitrateBindingOwnership(sourceClaim, unrelated)).toBe(unrelated)
    expect(arbitrateBindingOwnership(unrelated, sourceClaim)).toBe(unrelated)
    const aborted = { ...unrelated, transferId: 'zz-transfer', phase: 'aborted' as const }
    expect(arbitrateBindingOwnership(sourceClaim, aborted)).toBe(sourceClaim)
    expect(arbitrateBindingOwnership(aborted, sourceClaim)).toBe(sourceClaim)

    const target = await store()
    applied(
      await target.transition({
        event: 'adopt',
        transitionId: 'winner:claim',
        sessionId,
        machineAccess: 'allowed',
        transferId: 'transfer',
        role: 'target',
        phase: 'claim',
        fromMachineId: machineA,
        toMachineId: machineB,
        at: '2026-07-31T13:59:59.000Z',
        adoption: {
          agentKind: 'codex',
          observationGeneration: 2,
          delegation: {
            actor: asAgentIdentityId('post-crash-agent'),
            onBehalfOf: alice,
            grantedScope: { kind: 'all' },
            parentBindingId: null,
          },
          observations: [{ channel: 'worktree-pin', value: '/target/worktree' }],
        },
      }),
    )
    const denied = await target.transition({
      event: 'adopt',
      transitionId: 'winner:first-apply',
      sessionId,
      machineAccess: 'denied',
      transferId: 'transfer',
      role: 'target',
      phase: 'launch',
      fromMachineId: machineA,
      toMachineId: machineB,
      at: '2026-07-31T14:00:00.000Z',
      attemptId: 'attempt',
    })
    expect(denied).toEqual({
      status: 'denied',
      event: 'adopt',
      reason: 'machine-use-denied',
      terminal: true,
    })
    expect(await target.read(sessionId)).toMatchObject({ state: 'adopting', attemptId: null })
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

  it('RECEIPT CONFLICT appends a durable marker, keeps evidence pending, and is idempotent', async () => {
    const bindings = await store()
    const before = await spawn(bindings, 'receipt-conflict', 'codex')
    const observed = applied(
      await bindings.transition({
        event: 'hook-repin',
        transitionId: 'repin:receipt-conflict',
        sessionId: before.sessionId,
        evidenceSource: 'hook-receipt',
        value: 'thread-shared',
        nativeKind: 'codex-thread',
        observedAt: '2026-08-02T08:00:00.000Z',
        pendingServerAck: { nativeKind: 'codex-thread', value: 'thread-shared' },
      }),
    )

    const conflicted = await bindings.recordReceiptConflict({
      sessionId: before.sessionId,
      conflictId: 'conflict:shared',
      value: 'thread-shared',
      conflictingSessionIds: [asSessionId('sibling')],
      observedAt: '2026-08-02T08:00:01.000Z',
    })
    expect(conflicted).toMatchObject({
      state: 'conflicted',
      conflictHistory: [
        {
          conflictId: 'conflict:shared',
          channel: 'resume-ref',
          value: 'thread-shared',
          conflictingSessionIds: ['sibling'],
          resolvedAt: null,
        },
      ],
    })
    expect(conflicted?.observations).toEqual(observed.observations)

    await bindings.recordReceiptConflict({
      sessionId: before.sessionId,
      conflictId: 'conflict:shared',
      value: 'thread-shared',
      conflictingSessionIds: [asSessionId('sibling')],
      observedAt: '2026-08-02T08:00:02.000Z',
    })
    const restarted = await BindingStore.open({ dir: bindings.dir })
    const persisted = await restarted.read(before.sessionId)
    expect(persisted?.conflictHistory).toHaveLength(1)
    expect(
      persisted?.observations.some((entry) => entry.pendingServerAck?.value === 'thread-shared'),
    ).toBe(true)
  })

  it('RETIRE is terminal, idempotent, retains observations, and ends delegation', async () => {
    const bindings = await store()
    const before = await spawn(bindings, 'retire', 'claude-code', {
      attemptId: 'attempt-retire',
    })
    const bound = applied(
      await bindings.transition({
        event: 'hook-repin',
        transitionId: 'repin:retire',
        sessionId: before.sessionId,
        evidenceSource: 'hook-receipt',
        value: 'native-retire',
        nativeKind: 'claude-session',
        observedAt: '2026-08-02T09:00:00.000Z',
      }),
    )
    const retired = applied(
      await bindings.transition({
        event: 'retire',
        transitionId: `retire:${before.sessionId}`,
        sessionId: before.sessionId,
        retiredAt: '2026-08-02T09:01:00.000Z',
      }),
    )

    expect(retired).toMatchObject({
      state: 'retired',
      attemptId: null,
      retiredAt: '2026-08-02T09:01:00.000Z',
    })
    expect(retired.observations).toEqual(bound.observations)
    expect(retired.delegationHistory.at(-1)).toMatchObject({ retired: true })
    expect(bindings.currentDelegation(retired)).toBeNull()

    const repeated = await bindings.transition({
      event: 'retire',
      transitionId: `retire:${before.sessionId}`,
      sessionId: before.sessionId,
      retiredAt: '2026-08-02T09:01:00.000Z',
    })
    expect(repeated.status).toBe('unchanged')
    expect(applied(repeated).transitionHistory.map((entry) => entry.event)).toEqual([
      'spawn',
      'hook-repin',
      'retire',
    ])

    expect(
      await bindings.transition({
        event: 'reattach',
        transitionId: 'reattach:after-retire',
        sessionId: before.sessionId,
        claimantMachineId: machineA,
        machineAccess: 'allowed',
        sessionAccess: 'allowed',
        principal: { kind: 'user', userId: alice },
        requestedGeneration: 2,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'binding-retired' })
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
