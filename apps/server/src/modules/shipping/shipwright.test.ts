import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asAccountId,
  asMachineId,
  asSessionId,
  asUserId,
  DEFAULT_SHIPWRIGHT_BUDGET,
  ShipwrightEvidenceRef,
  ShipwrightPatchContract,
  shipRepairRef,
} from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '../../store'
import {
  ShippingEvidenceRegistry,
  ShipwrightService,
  type ShipwrightContextInput,
  type ShipwrightEvidenceMaterializer,
  validateShipwrightPatch,
} from './shipwright'

describe('bounded shipwright patch contract', () => {
  it('accepts an exact text patch and marks test changes for Inspector review', () => {
    const contract = ShipwrightPatchContract.parse({
      kind: 'patch',
      summary: 'keep the assertion aligned with the implementation',
      behaviorImpact: 'none',
      touchedPaths: ['src/value.test.ts'],
      patch:
        'diff --git a/src/value.test.ts b/src/value.test.ts\n' +
        '--- a/src/value.test.ts\n+++ b/src/value.test.ts\n@@ -1 +1 @@\n-expect(1)\n+expect(2)\n',
    })
    expect(validateShipwrightPatch(contract)).toEqual({
      ok: true,
      paths: ['src/value.test.ts'],
      risky: true,
    })
  })

  it('rejects undeclared, binary, policy, traversal, and oversized changes', () => {
    const base = {
      kind: 'patch' as const,
      summary: 'repair',
      behaviorImpact: 'none' as const,
      concerns: [],
    }
    expect(
      validateShipwrightPatch({
        ...base,
        touchedPaths: ['src/b.ts'],
        patch: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n',
      }).ok,
    ).toBe(false)
    expect(
      validateShipwrightPatch({
        ...base,
        touchedPaths: ['asset.png'],
        patch: 'diff --git a/asset.png b/asset.png\nGIT binary patch\n',
      }).ok,
    ).toBe(false)
    expect(
      validateShipwrightPatch({
        ...base,
        touchedPaths: ['AGENTS.md'],
        patch: 'diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n',
      }).ok,
    ).toBe(false)
    expect(
      validateShipwrightPatch({
        ...base,
        touchedPaths: ['../secret'],
        patch: 'diff --git a/../secret b/../secret\n--- a/../secret\n+++ b/../secret\n',
      }).ok,
    ).toBe(false)
    expect(
      validateShipwrightPatch(
        {
          ...base,
          touchedPaths: ['src/a.ts'],
          patch: `diff --git a/src/a.ts b/src/a.ts\n${'x'.repeat(2_000)}`,
        },
        { ...DEFAULT_SHIPWRIGHT_BUDGET, maxPatchBytes: 1_024 },
      ).ok,
    ).toBe(false)
  })

  it('mints only attempt and generation scoped refs', () => {
    expect(shipRepairRef('order:one', 'attempt:one/two', 7, 'c'.repeat(64))).toBe(
      `refs/podium/ship-repair/order-one/attempt-one-two/7/${'c'.repeat(64)}`,
    )
  })

  it('accepts only opaque durable evidence references', () => {
    expect(ShipwrightEvidenceRef.safeParse('artifact://validation/gate-log').success).toBe(true)
    expect(ShipwrightEvidenceRef.safeParse('/tmp/gate.log').success).toBe(false)
    expect(ShipwrightEvidenceRef.safeParse('the gate failed here').success).toBe(false)
    expect(ShipwrightEvidenceRef.safeParse('log:api-key-secret').success).toBe(false)
    expect(ShipwrightEvidenceRef.safeParse('artifact://validation/../secret').success).toBe(false)
  })

  it('persists immutable custody-bound bytes across a fresh server store and caps reads', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-shipwright-evidence-'))
    const dbPath = join(root, 'podium.db')
    const firstStore = new SessionStore(dbPath)
    const registry = new ShippingEvidenceRegistry(
      firstStore.shipping,
      () => '2026-08-14T05:10:00.000Z',
    )
    const input = {
      order: { id: 'order:evidence' },
      attempt: {
        id: 'attempt:evidence',
        leaseGeneration: 3,
        machineId: asMachineId('machine:evidence'),
      },
      custody: {
        attemptId: 'attempt:evidence',
        generation: 3,
        machineId: asMachineId('machine:evidence'),
      },
      authority: {
        jobId: 'job:evidence',
        requestDigest: 'a'.repeat(64),
        operation: 'validate',
      },
    }
    const ref = registry.materialize({
      ...input,
      sourceRef: `artifact://shipping/${'b'.repeat(64)}`,
      content: 'bounded evidence',
    } as never)
    expect(
      registry.materialize({
        ...input,
        sourceRef: `artifact://shipping/${'b'.repeat(64)}`,
        content: 'bounded evidence',
      } as never),
    ).toBe(ref)
    firstStore.close()

    const restartedStore = new SessionStore(dbPath)
    const restarted = new ShippingEvidenceRegistry(restartedStore.shipping)
    expect(
      restarted.resolve({
        ...input,
        sourceRef: `artifact://shipping/${'b'.repeat(64)}`,
      } as never),
    ).toBe(ref)
    expect(restarted.read({ ...input, failure: { artifactRefs: [ref] } } as never, ref, 7)).toBe(
      'bounded',
    )
    expect(() =>
      restarted.read(
        {
          ...input,
          custody: { ...input.custody, generation: 4 },
          failure: { artifactRefs: [ref] },
        } as never,
        ref,
        100,
      ),
    ).toThrow(/custody mismatch/)
    expect(() =>
      restarted.materialize({
        ...input,
        sourceRef: `artifact://shipping/${'b'.repeat(64)}`,
        content: 'changed evidence',
      } as never),
    ).toThrow(/immutable collision/)
    restartedStore.close()
    rmSync(root, { recursive: true, force: true })
  })
})

describe('durable shipwright model results', () => {
  const owner = asUserId('user:shipwright')
  const machineId = asMachineId('machine:shipwright')
  const order = {
    id: 'order:shipwright',
    requestedBy: { actor: { kind: 'user', id: owner }, onBehalfOf: owner },
  }
  const attempt = { id: 'attempt:shipwright', machineId, leaseGeneration: 4 }
  const issue = {
    id: 'issue:shipwright',
    repoPath: '/repo',
    title: 'Repair a gate',
    description: 'Keep behavior stable.',
  }
  const failure = {
    operation: 'validate' as const,
    classification: 'validation-failed',
    summary: 'named gate failed',
    artifactRefs: ['/executor/journal/gate.log'],
  }

  function fixture(
    output: string | string[],
    budget?: typeof DEFAULT_SHIPWRIGHT_BUDGET,
    materialize?: ShipwrightEvidenceMaterializer['materialize'],
    readContext?: (input: ShipwrightContextInput) => Promise<{
      output: string
      relevantDiff: string
    }>,
    nativeAccountId: ConstructorParameters<typeof ShipwrightService>[0]['nativeAccountId'] = () =>
      asAccountId('native:claude-code:fingerprint-1'),
  ) {
    const sessions = new Map<string, Record<string, unknown>>()
    const creates: Record<string, unknown>[] = []
    const turns: Record<string, unknown>[] = []
    const acknowledgements: {
      sessionId: string
      turnId: string
      requestDigest: string
      accountId: string
    }[] = []
    let quotaReads = 0
    let outputIndex = 0
    const service = new ShipwrightService({
      headless: {
        headlessSession: (sessionId) => sessions.get(sessionId) as never,
        createHeadlessSession: (input) => {
          creates.push(input)
          if (!sessions.has(input.sessionId as string)) {
            sessions.set(input.sessionId as string, {
              ...input,
              sessionId: input.sessionId,
              headless: true,
            })
          }
          return { sessionId: input.sessionId ?? asSessionId('unexpected') }
        },
        headlessTurn: async (input) => {
          turns.push(input)
          const selected = Array.isArray(output)
            ? output[Math.min(outputIndex++, output.length - 1)]
            : output
          return {
            ok: true,
            output: selected,
            requestDigest: 'd'.repeat(64),
            accountId: asAccountId('native:claude-code:fingerprint-1'),
          }
        },
        headlessTurnAck: (sessionId, turnId, requestDigest, accountId) => {
          acknowledgements.push({ sessionId, turnId, requestDigest, accountId })
        },
      },
      settingsFor: () =>
        normalizeSettings({
          roles: {
            shipwright: {
              accountId: 'native:claude-code',
              harness: 'claude-code',
              model: 'repair-model',
              effort: 'high',
            },
          },
        }),
      modelCatalog: () => ({
        machineId,
        fetchedAt: 1,
        byAgent: {
          'claude-code': [{ value: 'repair-model', label: 'Repair model', efforts: ['high'] }],
        },
      }),
      quota: async () => {
        quotaReads += 1
        return []
      },
      nativeAccountId,
      validationProfile: () => ({ id: 'gate' }) as never,
      evidence: {
        materialize:
          materialize ??
          (async ({ source }) =>
            ShipwrightEvidenceRef.array().parse(
              source === 'failure'
                ? ['artifact://validation/gate-log']
                : ['artifact://repair/applied-patch'],
            )),
      },
      context:
        readContext ?? (async () => ({ output: 'failure output', relevantDiff: 'diff context' })),
      applyPatch: async () => ({
        ok: true,
        candidateHeadSha: 'candidate-sha',
        evidenceRefs: ['/executor/journal/applied.patch'],
      }),
      ...(budget ? { budget } : {}),
    })
    return {
      service,
      creates,
      turns,
      acknowledgements,
      get quotaReads() {
        return quotaReads
      },
    }
  }

  it('fails closed when the materializer returns a raw executor path', async () => {
    const h = fixture('{}', undefined, async () => ['/executor/journal/gate.log'] as never)
    const result = await h.service.consider({
      order,
      attempt,
      issue,
      failure,
      custody: { attemptId: attempt.id, generation: 4, machineId },
      contextDigest: 'c'.repeat(64),
      authority: {} as never,
    } as never)

    expect(result).toMatchObject({
      kind: 'needs-decision',
      reasonCode: 'policy-refused',
      evidenceRefs: [],
      actions: ['retry', 'return-to-issue'],
    })
    expect(h.turns).toHaveLength(0)
  })

  it('does not advertise open repair when no personal model owner can dispatch', async () => {
    const h = fixture('{}')
    const result = await h.service.consider({
      order: {
        ...order,
        requestedBy: { actor: order.requestedBy.actor, onBehalfOf: undefined },
      },
      attempt,
      issue,
      failure,
      custody: { attemptId: attempt.id, generation: 4, machineId },
      contextDigest: 'c'.repeat(64),
      authority: {} as never,
    } as never)

    expect(result).toMatchObject({
      kind: 'needs-decision',
      reasonCode: 'policy-refused',
      actions: ['retry', 'return-to-issue'],
    })
    expect(h.turns).toHaveLength(0)
  })

  it('does not advertise open repair when no model account is available before dispatch', async () => {
    const h = fixture('{}', undefined, undefined, undefined, () => null)
    const result = await h.service.consider({
      order,
      attempt,
      issue,
      failure,
      custody: { attemptId: attempt.id, generation: 4, machineId },
      contextDigest: 'c'.repeat(64),
      authority: {} as never,
    } as never)

    expect(result).toMatchObject({
      kind: 'needs-decision',
      actions: ['retry', 'return-to-issue'],
    })
    expect(h.turns).toHaveLength(0)
  })

  it('refuses a cross-context artifact lookup without exposing the raw executor path', async () => {
    const seen: ShipwrightContextInput[] = []
    const h = fixture('{}', undefined, undefined, async (input) => {
      seen.push(input)
      throw new Error('artifact custody belongs to another attempt')
    })
    const result = await h.service.consider({
      order,
      attempt,
      issue,
      failure,
      custody: { attemptId: attempt.id, generation: 4, machineId },
      contextDigest: 'c'.repeat(64),
      authority: {} as never,
    } as never)

    expect(seen).toEqual([
      expect.objectContaining({
        order,
        attempt,
        custody: { attemptId: attempt.id, generation: 4, machineId },
        authority: {} as never,
        failure: expect.objectContaining({
          artifactRefs: ['artifact://validation/gate-log'],
        }),
      }),
    ])
    expect(JSON.stringify(seen)).not.toContain('/executor/journal/gate.log')
    expect(result).toMatchObject({
      kind: 'needs-decision',
      reasonCode: 'policy-refused',
      evidenceRefs: ['artifact://validation/gate-log'],
    })
    expect(h.turns).toHaveLength(0)
  })

  it('replays the attempt-scoped result and acknowledges it only after durable consumption', async () => {
    const h = fixture(
      JSON.stringify({
        kind: 'patch',
        summary: 'repair the assertion',
        behaviorImpact: 'none',
        touchedPaths: ['src/value.ts'],
        patch:
          'diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-old\n+new\n',
        concerns: [],
      }),
    )
    const input = {
      order,
      attempt,
      issue,
      failure,
      custody: { attemptId: attempt.id, generation: 4, machineId },
      contextDigest: 'c'.repeat(64),
      authority: {} as never,
    } as never

    const first = await h.service.consider(input)
    const replay = await h.service.consider(input)
    expect(first).toEqual(replay)
    expect(first).toMatchObject({
      kind: 'patched',
      repairRef: `refs/podium/ship-repair/order-shipwright/attempt-shipwright/4/${'c'.repeat(64)}`,
      candidateHeadSha: 'candidate-sha',
      resultToken: expect.stringMatching(/^shipwright-result:/),
    })
    expect(h.creates[0]).toMatchObject({
      sessionId: 'shipwright:attempt:shipwright:4:mechanic:0',
      ownerUserId: owner,
      createdBy: order.requestedBy,
      issueId: issue.id,
      accountId: 'native:claude-code:fingerprint-1',
      requireNoTools: true,
    })
    expect(h.turns[0]).toMatchObject({ toolPolicy: 'none' })
    expect(h.quotaReads).toBe(1)
    expect(h.acknowledgements).toEqual([])
    if (first.kind !== 'patched') throw new Error('expected a patch result')
    await h.service.acknowledge({
      resultToken: first.resultToken,
      orderId: order.id,
      attemptId: attempt.id,
      generation: 4,
      contextDigest: 'c'.repeat(64),
      candidate: {
        repairRef: `refs/podium/ship-repair/order-shipwright/attempt-shipwright/4/${'c'.repeat(64)}`,
        candidateHeadSha: 'candidate-sha',
      },
    } as never)
    expect(h.acknowledgements).toEqual([
      {
        sessionId: 'shipwright:attempt:shipwright:4:mechanic:0',
        turnId: 'shipwright:attempt:shipwright:4:mechanic:0',
        requestDigest: 'd'.repeat(64),
        accountId: 'native:claude-code:fingerprint-1',
      },
    ])
  })

  it('keeps free-form model concerns out of typed hold evidence', async () => {
    const h = fixture(
      JSON.stringify({
        kind: 'patch',
        summary: 'two behaviors are possible',
        behaviorImpact: 'ambiguous',
        touchedPaths: ['src/value.ts'],
        patch:
          'diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-old\n+new\n',
        concerns: ['model-authored concern must not become an evidence ref'],
      }),
    )
    const result = await h.service.consider({
      order,
      attempt,
      issue,
      failure,
      custody: { attemptId: attempt.id, generation: 4, machineId },
      contextDigest: 'c'.repeat(64),
      authority: {} as never,
    } as never)
    expect(result).toMatchObject({
      kind: 'needs-decision',
      headline: 'Needs your decision',
      evidenceRefs: ['artifact://validation/gate-log'],
    })
  })

  it('uses the full bounded Inspector allowance before applying a risky repair', async () => {
    const patch = JSON.stringify({
      kind: 'patch',
      summary: 'repair the assertion',
      behaviorImpact: 'none',
      touchedPaths: ['src/value.test.ts'],
      patch:
        'diff --git a/src/value.test.ts b/src/value.test.ts\n--- a/src/value.test.ts\n+++ b/src/value.test.ts\n@@ -1 +1 @@\n-old\n+new\n',
      concerns: [],
    })
    const h = fixture(
      [
        patch,
        '{"kind":"inspection","verdict":"safe"}',
        JSON.stringify({
          kind: 'inspection',
          verdict: 'safe',
          summary: 'bounded test-only repair',
          concerns: [],
        }),
      ],
      {
        ...DEFAULT_SHIPWRIGHT_BUDGET,
        maxTurns: 3,
        maxMechanicTurns: 1,
        maxSolverTurns: 0,
        maxInspectorTurns: 2,
      },
    )
    const result = await h.service.consider({
      order,
      attempt,
      issue,
      failure,
      custody: { attemptId: attempt.id, generation: 4, machineId },
      contextDigest: 'c'.repeat(64),
      authority: {} as never,
    } as never)
    expect(result.kind).toBe('patched')
    expect(h.turns.map((turn) => turn.turnId)).toEqual([
      'shipwright:attempt:shipwright:4:mechanic:0',
      'shipwright:attempt:shipwright:4:inspector:1',
      'shipwright:attempt:shipwright:4:inspector:2',
    ])
  })

  it('holds a risky repair when the Inspector budget is zero', async () => {
    const h = fixture(
      JSON.stringify({
        kind: 'patch',
        summary: 'repair the assertion',
        behaviorImpact: 'none',
        touchedPaths: ['src/value.test.ts'],
        patch:
          'diff --git a/src/value.test.ts b/src/value.test.ts\n--- a/src/value.test.ts\n+++ b/src/value.test.ts\n@@ -1 +1 @@\n-old\n+new\n',
        concerns: [],
      }),
      {
        ...DEFAULT_SHIPWRIGHT_BUDGET,
        maxTurns: 1,
        maxMechanicTurns: 1,
        maxSolverTurns: 0,
        maxInspectorTurns: 0,
      },
    )
    const result = await h.service.consider({
      order,
      attempt,
      issue,
      failure,
      custody: { attemptId: attempt.id, generation: 4, machineId },
      contextDigest: 'c'.repeat(64),
      authority: {} as never,
    } as never)
    expect(result).toMatchObject({
      kind: 'needs-decision',
      reasonCode: 'policy-refused',
      headline: 'Needs your decision',
    })
  })
})
