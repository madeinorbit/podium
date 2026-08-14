import {
  FIRST_ADMIN_USER_ID,
  asDeliveryReceiptId,
  asIssueId,
  asMachineId,
  asRepoId,
  asShipAttemptId,
  asShipHoldId,
  asShipOrderId,
  asShipStepId,
  integrationReceiptMatchesOrder,
  type DeliveryReceipt,
  type ShipOrder,
} from '@podium/model'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { describe, expect, it } from 'vitest'
import { SessionStore } from './store'
import type { RootIntegrationReceiptStore } from './store/shipping'
import { shipOrderProjectionRows } from './modules/shipping/projection'
import { runDrizzleMigrations } from './migrations'
import { DRIZZLE_MIGRATIONS } from './migrations/drizzle-manifest.generated'

const base = () => ({
  id: asIssueId('iss_1'),
  repoPath: '/r',
  seq: 1,
  title: 'Fix login',
  description: 'desc',
  ownerUserId: FIRST_ADMIN_USER_ID,
  visibility: 'personal' as const,
  createdByActor: FIRST_ADMIN_USER_ID,
  createdByOnBehalfOf: FIRST_ADMIN_USER_ID,
  stage: 'backlog',
  worktreePath: null,
  branch: null,
  parentBranch: 'main',
  defaultAgent: 'claude-code',
  defaultModel: 'auto',
  defaultEffort: 'auto',
  linearId: null,
  linearIdentifier: null,
  linearUrl: null,
  activityNotes: null,
  notesUpdatedAt: null,
  suggestedStage: null,
  suggestedReason: null,
  blockedBy: [] as string[],
  dependencyNote: null,
  prUrl: null,
  priority: 2,
  type: 'task',
  assignee: null,
  parentId: null,
  design: null,
  acceptance: null,
  notes: null,
  dueAt: null,
  deferUntil: null,
  closedReason: null,
  closedAt: null,
  supersededBy: null,
  duplicateOf: null,
  pinned: false,
  estimateMin: null,
  needsHuman: false,
  humanQuestion: null,
  createdAt: 't0',
  updatedAt: 't0',
  archived: false,
})

describe('store issues', () => {
  it('round-trips an issue', () => {
    const s = new SessionStore(':memory:')
    s.issues.upsertIssue(base())
    const got = s.issues.getIssue('iss_1')
    expect(got?.title).toBe('Fix login')
    expect(got?.worktreePath).toBeNull()
    expect(got?.blockedBy).toEqual([])
    expect(got?.archived).toBe(false)
  })

  it('updates on conflict and preserves JSON blockedBy', () => {
    const s = new SessionStore(':memory:')
    s.issues.upsertIssue(base())
    s.issues.upsertIssue({
      ...base(),
      stage: 'planning',
      worktreePath: '/r/wt',
      branch: 'issue/1-x',
      blockedBy: ['iss_2'],
    })
    const got = s.issues.getIssue('iss_1')
    expect(got?.stage).toBe('planning')
    expect(got?.worktreePath).toBe('/r/wt')
    expect(got?.blockedBy).toEqual(['iss_2'])
  })

  it('lists by repo and increments seq per repo_id', () => {
    const s = new SessionStore(':memory:')
    const rid = (p: string) => s.repos.resolveRepoIdForPath(p)
    expect(s.issues.nextIssueSeq(rid('/r'))).toBe(1)
    s.issues.upsertIssue({
      ...base(),
      id: asIssueId('a'),
      repoPath: '/r',
      seq: 1,
    })
    s.issues.upsertIssue({
      ...base(),
      id: asIssueId('b'),
      repoPath: '/r',
      seq: 2,
    })
    s.issues.upsertIssue({
      ...base(),
      id: asIssueId('c'),
      repoPath: '/other',
      seq: 1,
    })
    expect(s.issues.nextIssueSeq(rid('/r'))).toBe(3)
    expect(s.issues.nextIssueSeq(rid('/other'))).toBe(2)
    expect(
      s.issues
        .listIssueRows('/r')
        .map((i) => i.id)
        .sort(),
    ).toEqual(['a', 'b'])
    expect(s.issues.listIssueRows().length).toBe(3)
  })

  it('allocates seq per repo_id — shared across checkout paths of one origin (#140)', () => {
    const s = new SessionStore(':memory:')
    const repoId = asRepoId('repo_shared_origin')
    // Two checkouts of the SAME repo at DIFFERENT paths (e.g. two machines).
    s.issues.upsertIssue({
      ...base(),
      id: asIssueId('a'),
      repoPath: '/home/alice/proj',
      repoId,
      seq: 1,
    })
    s.issues.upsertIssue({
      ...base(),
      id: asIssueId('b'),
      repoPath: '/home/bob/proj',
      repoId,
      seq: 2,
    })
    // One repo_id → one sequence; the next number is 3, not a per-path duplicate.
    expect(s.issues.nextIssueSeq(repoId)).toBe(3)
  })

  it('rejects colliding (repo_id, seq) at the SQL layer — UNIQUE index from migration 005 (#140)', () => {
    // On this branch collisions are unrepresentable through the facade: migration
    // 005 installed UNIQUE(repo_id, seq), so the upsert itself throws and the #140
    // heal has nothing to do on a live DB.
    const s = new SessionStore(':memory:')
    const repoId = asRepoId('repo_dup')
    s.issues.upsertIssue({
      ...base(),
      id: asIssueId('m4'),
      repoPath: '/home/user/p',
      repoId,
      seq: 4,
    })
    expect(() =>
      s.issues.upsertIssue({
        ...base(),
        id: asIssueId('t4'),
        repoPath: '/home/till/p',
        repoId,
        seq: 4,
      }),
    ).toThrow()
    expect(s.issues.renumberCollidingIssueSeqs()).toBe(0)
  })

  it('boot-heals colliding seqs restored from a pre-index database, idempotently (#140)', () => {
    // Emulate a database from main's pre-UNIQUE-index lineage: build it, drop the
    // 005 index out-of-band, plant a collision raw, then reopen through the store —
    // the per-boot renumberCollidingIssueSeqs heal renumbers the loser.
    const file = join(mkdtempSync(join(tmpdir(), 'podium-seq-heal-')), 'heal.db')
    const repoId = asRepoId('repo_dup')
    const s1 = new SessionStore(file)
    // Same origin, two paths; canonical (majority) path /home/user + a loser path
    // /home/till that minted colliding #4 (and a non-colliding #1).
    s1.issues.upsertIssue({
      ...base(),
      id: asIssueId('m3'),
      repoPath: '/home/user/p',
      repoId,
      seq: 3,
    })
    s1.issues.upsertIssue({
      ...base(),
      id: asIssueId('m4'),
      repoPath: '/home/user/p',
      repoId,
      seq: 4,
    })
    s1.issues.upsertIssue({
      ...base(),
      id: asIssueId('m5'),
      repoPath: '/home/user/p',
      repoId,
      seq: 5,
    })
    s1.issues.upsertIssue({
      ...base(),
      id: asIssueId('t4'),
      repoPath: '/home/till/p',
      repoId,
      seq: 99,
    })
    s1.issues.upsertIssue({
      ...base(),
      id: asIssueId('t1'),
      repoPath: '/home/till/p',
      repoId,
      seq: 1,
    })
    s1.close()
    const raw = openDatabase(file)
    raw.exec('DROP INDEX idx_issues_repo_id_seq')
    raw.prepare('UPDATE issues SET seq = 4 WHERE id = ?').run('t4')
    raw.close()
    const s2 = new SessionStore(file) // boot heal runs here
    expect(s2.issues.getIssue('m4')?.seq).toBe(4) // canonical path keeps #4
    expect(s2.issues.getIssue('t4')?.seq).toBe(6) // loser appended after max(5) => 6
    expect(s2.issues.getIssue('t1')?.seq).toBe(1) // non-colliding kept
    const seqs = s2.issues.listIssueRows().map((i) => i.seq)
    expect(new Set(seqs).size).toBe(seqs.length) // unique per repo_id
    expect(s2.issues.renumberCollidingIssueSeqs()).toBe(0) // idempotent
    s2.close()
  })

  it('deletes', () => {
    const s = new SessionStore(':memory:')
    s.issues.upsertIssue(base())
    s.issues.deleteIssue('iss_1')
    expect(s.issues.getIssue('iss_1')).toBeNull()
  })

  it('rejects an invalid stage on write but allows the auto defaultAgent sentinel', () => {
    const s = new SessionStore(':memory:')
    expect(() => s.issues.upsertIssue({ ...base(), stage: 'bogus' })).toThrow(/stage/i)
    // 'auto' is a legal defaultAgent (AgentChoice sentinel) — it must NOT be rejected;
    // it is resolved to a concrete kind only at spawn time.
    expect(() => s.issues.upsertIssue({ ...base(), defaultAgent: 'auto' })).not.toThrow()
  })

  it('normalizes a non-array blockedBy to [] on write', () => {
    const s = new SessionStore(':memory:')
    s.issues.upsertIssue({
      ...base(),
      blockedBy: 'nope' as unknown as string[],
    })
    expect(s.issues.getIssue('iss_1')?.blockedBy).toEqual([])
  })

  it('tolerates a corrupt blocked_by column instead of crashing the whole load', () => {
    // A row whose blocked_by holds non-JSON (legacy/externally-corrupted data) must
    // NOT throw out of mapIssueRow — that would abort listIssueRows, which runs in
    // IssueService's constructor at boot, crash-looping the server. Quarantine the
    // bad field (blockedBy -> []) and keep the row.
    const s = new SessionStore(':memory:')
    s.issues.upsertIssue(base())
    rawDb(s).prepare('UPDATE issues SET blocked_by = ? WHERE id = ?').run('{not json', 'iss_1')

    expect(() => s.issues.listIssueRows()).not.toThrow()
    expect(s.issues.getIssue('iss_1')?.blockedBy).toEqual([])
    expect(s.issues.listIssueRows().map((i) => i.id)).toContain('iss_1')
  })

  it('quarantines a non-array blocked_by JSON value', () => {
    const s = new SessionStore(':memory:')
    s.issues.upsertIssue(base())
    // Valid JSON, wrong shape (an object, not a string[]).
    rawDb(s).prepare('UPDATE issues SET blocked_by = ? WHERE id = ?').run('{"a":1}', 'iss_1')
    expect(s.issues.getIssue('iss_1')?.blockedBy).toEqual([])
  })

  // POD-568 — the finished-work projection the auto-hibernate sweep orders by.
  it('names closed issues by stage, close reason and tombstone', () => {
    const s = new SessionStore(':memory:')
    s.issues.upsertIssue({
      ...base(),
      id: asIssueId('open'),
      seq: 1,
      stage: 'in_progress',
    })
    s.issues.upsertIssue({
      ...base(),
      id: asIssueId('review'),
      seq: 2,
      stage: 'review',
    })
    s.issues.upsertIssue({
      ...base(),
      id: asIssueId('done'),
      seq: 3,
      stage: 'done',
    })
    // Closed for a reason WITHOUT reaching done — the half isIssueClosed exists for.
    s.issues.upsertIssue({
      ...base(),
      id: asIssueId('duped'),
      seq: 4,
      stage: 'backlog',
      closedReason: 'duplicate',
    })
    s.issues.upsertIssue({
      ...base(),
      id: asIssueId('gone'),
      seq: 5,
      stage: 'planning',
    })
    rawDb(s).prepare('UPDATE issues SET deleted_at = ? WHERE id = ?').run('t1', 'gone')

    expect([...s.issues.closedIssueIds()].sort()).toEqual(['done', 'duped', 'gone'])
  })
})

const shipOrder = (overrides: Partial<ShipOrder> = {}): ShipOrder => ({
  id: asShipOrderId('order-1'),
  issueId: asIssueId('iss_1'),
  descendantManifest: [],
  repoId: asRepoId('repo-1'),
  targetBranch: 'main',
  destination: 'origin/main',
  approvedBaseSha: 'approved-base',
  approvedHeadSha: 'approved-head',
  deliveryDependsOn: [],
  requestedBy: {
    actor: { kind: 'user', id: FIRST_ADMIN_USER_ID },
    onBehalfOf: FIRST_ADMIN_USER_ID,
  },
  requestedAt: '2026-08-12T10:00:00.000Z',
  policyId: 'default',
  closeMode: 'after-destination',
  state: 'queued',
  stateChangedAt: '2026-08-12T10:00:00.000Z',
  ...overrides,
})

describe('shipping durable store', () => {
  it('migrates legacy verifying issues without changing their stage', () => {
    const db = openDatabase(':memory:')
    const shippingMigrationIndex = DRIZZLE_MIGRATIONS.findIndex((migration) =>
      migration.name.endsWith('_shipping-durable-model'),
    )
    if (shippingMigrationIndex < 0) {
      throw new Error('shipping migration must be present in the audited manifest')
    }
    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS.slice(0, shippingMigrationIndex), {
      skipSchemaRepair: true,
    })
    db.prepare(
      `INSERT INTO issues
        (id, repo_path, seq, title, description, stage, parent_branch, default_agent,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'legacy-verifying',
      '/r',
      99,
      'Legacy verification',
      '',
      'verifying',
      'main',
      'auto',
      't0',
      't0',
    )

    runDrizzleMigrations(db, DRIZZLE_MIGRATIONS, { skipSchemaRepair: true })

    const row = db.prepare('SELECT stage FROM issues WHERE id = ?').get('legacy-verifying') as {
      stage: string
    }
    expect(row.stage).toBe('verifying')
    db.close()
  })

  it('fences active orders, attempts, idempotent steps, holds, and immutable receipts', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-shipping-store-')), 'shipping.db')
    const s = new SessionStore(file)
    s.issues.upsertIssue(base())
    const order = shipOrder()
    expect(s.shipping.createOrder(order)).toEqual(order)
    expect(() =>
      s.shipping.createOrder(
        shipOrder({ id: asShipOrderId('order-not-queued'), state: 'preflight' }),
      ),
    ).toThrow(/created queued/)
    expect(() => s.shipping.createOrder(shipOrder({ id: asShipOrderId('order-other') }))).toThrow(
      /already has active ship order/,
    )
    expect(() =>
      rawDb(s)
        .prepare(
          `INSERT INTO ship_orders
            (id, issue_id, repo_id, target_branch, destination, approved_base_sha,
             approved_head_sha, descendant_manifest, delivery_depends_on, provider_ref,
             requested_by_actor_kind, requested_by_actor_id, requested_by_on_behalf_of,
             requested_at, policy_id, close_mode, state, state_changed_at, hold_code)
           SELECT ?, issue_id, repo_id, target_branch, destination, approved_base_sha,
             approved_head_sha, descendant_manifest, delivery_depends_on, provider_ref,
             requested_by_actor_kind, requested_by_actor_id, requested_by_on_behalf_of,
             requested_at, policy_id, close_mode, state, state_changed_at, hold_code
           FROM ship_orders WHERE id = ?`,
        )
        .run('order-raw-active', order.id),
    ).toThrow()
    expect(() =>
      rawDb(s)
        .prepare('UPDATE ship_orders SET target_branch = ? WHERE id = ?')
        .run('dev', order.id),
    ).toThrow(/approval is immutable/)

    const attempt = {
      id: asShipAttemptId('attempt-1'),
      orderId: order.id,
      expectedSourceBaseSha: order.approvedBaseSha,
      approvedHeadSha: order.approvedHeadSha,
      expectedTargetSha: 'target-before',
      machineId: asMachineId('machine-1'),
      leaseGeneration: 3,
      startedAt: '2026-08-12T10:01:00.000Z',
      submittedHeadSha: order.approvedHeadSha,
    }
    s.shipping.createAttempt(attempt)
    const stepFence = {
      sourceBaseSha: attempt.expectedSourceBaseSha,
      approvedHeadSha: attempt.approvedHeadSha,
      targetSha: attempt.expectedTargetSha,
    }
    const plannedStep = {
      id: asShipStepId('step-planned'),
      orderId: order.id,
      attemptId: attempt.id,
      effectKey: 'validation:approved-head',
      idempotencyKey: 'validate:approved-head',
      generation: attempt.leaseGeneration,
      inputFence: stepFence,
      kind: 'validation',
      state: 'planned' as const,
      summary: 'store shard planned',
      recordedAt: '2026-08-12T10:02:00.000Z',
    }
    const runningStep = {
      ...plannedStep,
      id: asShipStepId('step-running'),
      idempotencyKey: 'validate:approved-head:running',
      state: 'running' as const,
      summary: 'store shard running',
      startedAt: '2026-08-12T10:02:00.000Z',
      recordedAt: '2026-08-12T10:02:30.000Z',
    }
    const finishedStep = {
      ...runningStep,
      id: asShipStepId('step-finished'),
      idempotencyKey: 'validate:approved-head:finished',
      state: 'succeeded' as const,
      outcome: 'passed',
      summary: 'store shard passed',
      artifactRef: 'artifact://validation/1',
      finishedAt: '2026-08-12T10:03:00.000Z',
      recordedAt: '2026-08-12T10:03:00.000Z',
    }
    expect(s.shipping.appendStep(plannedStep)).toEqual(plannedStep)
    expect(s.shipping.appendStep(plannedStep)).toEqual(plannedStep)
    expect(() =>
      s.shipping.appendStep({
        ...plannedStep,
        id: asShipStepId('step-collision'),
        summary: 'different',
      }),
    ).toThrow(/idempotency collision/)
    expect(s.shipping.appendStep(runningStep)).toEqual(runningStep)
    expect(s.shipping.appendStep(finishedStep)).toEqual(finishedStep)
    expect(s.shipping.latestStepForEffect(attempt.id, plannedStep.effectKey)).toEqual(finishedStep)
    expect(() =>
      s.shipping.appendStep({
        ...plannedStep,
        id: asShipStepId('step-stale-generation'),
        idempotencyKey: 'stale-generation',
        generation: 2,
      }),
    ).toThrow(/generation fence/)

    expect(() =>
      s.shipping.raiseHold({
        id: asShipHoldId('hold-stale'),
        orderId: order.id,
        generation: 2,
        reasonCode: 'validation-failed',
        headline: 'Validation needs a decision',
        detail: 'The configured validation profile failed.',
        evidenceRefs: ['artifact://validation/1'],
        actions: ['retry'],
        raisedAt: '2026-08-12T10:04:00.000Z',
      }),
    ).toThrow(/expected 1/)
    s.shipping.raiseHold({
      id: asShipHoldId('hold-1'),
      orderId: order.id,
      generation: 1,
      reasonCode: 'validation-failed',
      headline: 'Validation needs a decision',
      detail: 'The configured validation profile failed.',
      evidenceRefs: ['artifact://validation/1'],
      actions: ['retry'],
      raisedAt: '2026-08-12T10:04:00.000Z',
    })
    expect(() =>
      rawDb(s)
        .prepare(
          `INSERT INTO ship_holds
            (id, order_id, generation, reason_code, headline, detail, evidence_refs,
             actions, raised_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'hold-raw-open',
          order.id,
          2,
          'dependency-blocked',
          'Still held',
          '',
          '[]',
          '["retry"]',
          '2026-08-12T10:04:30.000Z',
        ),
    ).toThrow()
    expect(() =>
      s.shipping.raiseHold({
        id: asShipHoldId('hold-second-open'),
        orderId: order.id,
        generation: 2,
        reasonCode: 'dependency-blocked',
        headline: 'Still held',
        detail: '',
        evidenceRefs: [],
        actions: ['retry'],
        raisedAt: '2026-08-12T10:04:30.000Z',
      }),
    ).toThrow()
    expect(() =>
      s.shipping.resolveHold(order.id, 2, 'retry', 'queued', '2026-08-12T10:05:00.000Z'),
    ).toThrow(/generation fence/)
    expect(() =>
      s.shipping.resolveHold(order.id, 1, 'retry', 'repairing', '2026-08-12T10:05:00.000Z'),
    ).toThrow(/cannot transition/)
    expect(
      s.shipping.resolveHold(order.id, 1, 'retry', 'queued', '2026-08-12T10:05:00.000Z'),
    ).toMatchObject({ generation: 1, resolution: 'retry' })

    expect(() =>
      s.shipping.finishAttempt(attempt.id, 2, {
        finishedAt: '2026-08-12T10:06:00.000Z',
        outcome: 'succeeded',
      }),
    ).toThrow(/generation fence/)
    expect(() =>
      s.shipping.transitionOrder(order.id, 'queued', 'verifying', '2026-08-12T10:06:30.000Z'),
    ).toThrow(/illegal ship order transition/)
    s.shipping.transitionOrder(order.id, 'queued', 'preflight', '2026-08-12T10:06:10.000Z')
    s.shipping.transitionOrder(order.id, 'preflight', 'composing', '2026-08-12T10:06:20.000Z')
    s.shipping.transitionOrder(order.id, 'composing', 'validating', '2026-08-12T10:06:30.000Z')
    s.shipping.transitionOrder(order.id, 'validating', 'landing', '2026-08-12T10:06:40.000Z')
    s.shipping.transitionOrder(order.id, 'landing', 'verifying', '2026-08-12T10:07:00.000Z')
    const receipt: DeliveryReceipt = {
      id: asDeliveryReceiptId('receipt-1'),
      orderId: order.id,
      approvedBaseSha: order.approvedBaseSha,
      approvedHeadSha: order.approvedHeadSha,
      testedIntegrationSha: 'tested-integration',
      landedRefSha: 'landed-ref',
      destinationSha: 'destination-tip',
      validationProfileId: 'default',
      validationResult: 'passed',
      destination: order.destination,
      completedAt: '2026-08-12T10:08:00.000Z',
    }
    expect(() => s.shipping.completeVerifiedOrder(receipt)).toThrow(/successful proof/)
    const finished = s.shipping.finishAttempt(attempt.id, 3, {
      finishedAt: '2026-08-12T10:07:30.000Z',
      outcome: 'succeeded',
      testedIntegrationSha: 'tested-integration',
      landedRefSha: 'landed-ref',
      destinationSha: 'destination-tip',
      validationProfileId: 'default',
      validationResult: 'passed',
    })
    expect(finished).toMatchObject({
      approvedHeadSha: 'approved-head',
      testedIntegrationSha: 'tested-integration',
      landedRefSha: 'landed-ref',
      destinationSha: 'destination-tip',
      validationProfileId: 'default',
      validationResult: 'passed',
    })
    expect(s.shipping.completeVerifiedOrder(receipt)).toEqual(receipt)
    expect(s.shipping.completeVerifiedOrder(receipt)).toEqual(receipt)
    expect(() =>
      s.shipping.completeVerifiedOrder({
        ...receipt,
        destinationSha: 'different-proof',
      }),
    ).toThrow(/different immutable receipt/)
    expect(() => s.shipping.transitionOrder(order.id, 'shipped', 'queued', 'later')).toThrow(
      /terminal ship order.*immutable/,
    )
    expect(() =>
      rawDb(s).prepare('UPDATE ship_steps SET summary = ? WHERE id = ?').run('x', finishedStep.id),
    ).toThrow(/append-only/)
    expect(() =>
      rawDb(s).prepare('DELETE FROM ship_steps WHERE id = ?').run(finishedStep.id),
    ).toThrow(/append-only/)
    expect(() => rawDb(s).prepare('DELETE FROM ship_orders WHERE id = ?').run(order.id)).toThrow(
      /ship order .*immutable/,
    )
    expect(() =>
      rawDb(s).prepare('DELETE FROM ship_attempts WHERE id = ?').run(attempt.id),
    ).toThrow(/ship attempt .*immutable/)
    expect(() =>
      rawDb(s).prepare('DELETE FROM ship_holds WHERE id = ?').run(asShipHoldId('hold-1')),
    ).toThrow(/ship hold .*immutable/)
    expect(() =>
      rawDb(s)
        .prepare('UPDATE delivery_receipts SET destination_sha = ? WHERE id = ?')
        .run('other', receipt.id),
    ).toThrow(/delivery receipt is immutable/)
    expect(() =>
      rawDb(s).prepare('DELETE FROM delivery_receipts WHERE id = ?').run(receipt.id),
    ).toThrow(/delivery receipt is immutable/)

    expect(() => s.shipping.createOrder(shipOrder({ id: asShipOrderId('order-2') }))).not.toThrow()
    s.close()
    const restarted = new SessionStore(file)
    expect(restarted.shipping.getOrder(order.id)).toMatchObject({
      state: 'shipped',
    })
    expect(restarted.shipping.receiptForOrder(order.id)).toEqual(receipt)
    expect(restarted.shipping.stepsForAttempt(attempt.id)).toEqual([
      plannedStep,
      runningStep,
      finishedStep,
    ])
    expect(restarted.shipping.listHolds()).toContainEqual(
      expect.objectContaining({
        id: asShipHoldId('hold-1'),
        resolution: 'retry',
      }),
    )
    restarted.close()
  })

  it('omits cancelled orders from the routine compact projection', () => {
    const cancelled = shipOrder({ state: 'cancelled' })
    expect(shipOrderProjectionRows([cancelled], [], [])).toEqual([])
  })

  it('settles a queued dependency from its shipped train covering proof', () => {
    const s = new SessionStore(':memory:')
    const lowerIssue = asIssueId('iss_lower')
    const coveringIssue = asIssueId('iss_covering')
    s.issues.upsertIssue({ ...base(), id: lowerIssue, seq: 40 })
    s.issues.upsertIssue({ ...base(), id: coveringIssue, seq: 41 })
    const lower = shipOrder({
      id: asShipOrderId('order-lower'),
      issueId: lowerIssue,
      approvedHeadSha: 'lower-head',
    })
    const covering = shipOrder({
      id: asShipOrderId('order-covering'),
      issueId: coveringIssue,
      approvedHeadSha: 'covering-head',
      deliveryDependsOn: [lower.id],
    })
    s.shipping.createOrder(lower)
    s.shipping.createOrder(covering)
    const claimed = s.shipping.claimAttempt({
      orderId: covering.id,
      expectedState: 'queued',
      expectedAttemptId: null,
      expectedGeneration: 0,
      machineId: asMachineId('machine-1'),
      startedAt: '2026-08-12T10:01:00.000Z',
    })
    for (const [from, to] of [
      ['preflight', 'composing'],
      ['composing', 'validating'],
      ['validating', 'landing'],
      ['landing', 'publishing'],
      ['publishing', 'verifying'],
    ] as const) {
      s.shipping.transitionOrder(covering.id, from, to, '2026-08-12T10:02:00.000Z')
    }
    s.shipping.finishAttempt(claimed.attempt.id, claimed.attempt.leaseGeneration, {
      finishedAt: '2026-08-12T10:03:00.000Z',
      outcome: 'succeeded',
      testedIntegrationSha: 'covering-head',
      landedRefSha: 'covering-head',
      destinationSha: 'covering-head',
      validationProfileId: 'default',
      validationResult: 'passed',
    })
    const coveringReceipt = {
      id: asDeliveryReceiptId('receipt-covering'),
      orderId: covering.id,
      approvedBaseSha: covering.approvedBaseSha,
      approvedHeadSha: covering.approvedHeadSha,
      testedIntegrationSha: 'covering-head',
      landedRefSha: 'covering-head',
      destinationSha: 'covering-head',
      validationProfileId: 'default',
      validationResult: 'passed' as const,
      destination: covering.destination,
      completedAt: '2026-08-12T10:04:00.000Z',
    }
    s.shipping.completeVerifiedOrder(coveringReceipt)
    const lowerReceipt = {
      ...coveringReceipt,
      id: asDeliveryReceiptId('receipt-lower'),
      orderId: lower.id,
      approvedHeadSha: lower.approvedHeadSha,
      landedRefSha: lower.approvedHeadSha,
    }

    expect(s.shipping.completeCoveredOrder(lowerReceipt, covering.id)).toEqual(lowerReceipt)
    expect(s.shipping.getOrder(lower.id)?.state).toBe('shipped')
    s.close()
  })

  it('exposes a CAS-only issue custody seam for atomic admission and settlement', () => {
    const s = new SessionStore(':memory:')
    const issue = { ...base(), stage: 'review' as const }
    s.issues.upsertIssue(issue)
    s.transact(() => {
      s.issues.transitionShippingStage(issue.id, 'review', 'shipping', 't1')
      s.shipping.createOrder(shipOrder())
    })
    expect(s.issues.getIssue(issue.id)?.stage).toBe('shipping')
    expect(() => s.issues.transitionShippingStage(issue.id, 'review', 'shipping', 't2')).toThrow(
      /stage fence/,
    )
    s.issues.transitionShippingStage(issue.id, 'shipping', 'review', 't3')
    expect(s.issues.getIssue(issue.id)?.stage).toBe('review')
  })

  it('persists typed root integration receipts as immutable pre-admission proof', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-root-integration-')), 'shipping.db')
    const childA = {
      issueId: asIssueId('iss_child_a'),
      approvedHeadSha: 'sha-a',
    }
    const childB = {
      issueId: asIssueId('iss_child_b'),
      approvedHeadSha: 'sha-b',
    }
    const receipt = {
      rootIssueId: asIssueId('iss_1'),
      approvedHeadSha: 'integrated-root-head',
      descendants: [childB, childA],
    }
    const canonical = { ...receipt, descendants: [childA, childB] }
    const s = new SessionStore(file)
    s.issues.upsertIssue(base())

    expect(s.shipping.recordRootIntegrationReceipt(receipt)).toEqual(canonical)
    expect(s.shipping.recordRootIntegrationReceipt(canonical)).toEqual(canonical)
    expect(s.shipping.rootIntegrationReceipt(receipt.rootIssueId, receipt.approvedHeadSha)).toEqual(
      canonical,
    )
    expect(s.shipping.rootIntegrationReceipt(receipt.rootIssueId, 'other-head')).toBeNull()
    expect(() =>
      s.shipping.recordRootIntegrationReceipt({
        ...receipt,
        descendants: [childA],
      }),
    ).toThrow(/different descendants/)
    expect(() =>
      rawDb(s)
        .prepare('UPDATE root_integration_receipts SET descendants = ? WHERE root_issue_id = ?')
        .run('[]', receipt.rootIssueId),
    ).toThrow(/root integration receipt is immutable/)
    expect(() =>
      rawDb(s)
        .prepare('DELETE FROM root_integration_receipts WHERE root_issue_id = ?')
        .run(receipt.rootIssueId),
    ).toThrow(/root integration receipt is immutable/)

    s.close()
    const restarted = new SessionStore(file)
    expect(
      restarted.shipping.rootIntegrationReceipt(receipt.rootIssueId, receipt.approvedHeadSha),
    ).toEqual(canonical)
    restarted.close()
  })

  it('exposes exact current proof through the typed admission retrieval port', () => {
    const s = new SessionStore(':memory:')
    const rootIssueId = asIssueId('iss_1')
    const childA = {
      issueId: asIssueId('iss_child_a'),
      approvedHeadSha: 'sha-a',
    }
    const childB = {
      issueId: asIssueId('iss_child_b'),
      approvedHeadSha: 'sha-b',
    }
    s.issues.upsertIssue(base())
    s.shipping.recordRootIntegrationReceipt({
      rootIssueId,
      approvedHeadSha: 'integrated-root-head',
      descendants: [childA, childB],
    })

    const admissionProofs: RootIntegrationReceiptStore = s.shipping
    const current = admissionProofs.rootIntegrationReceipt(rootIssueId, 'integrated-root-head')
    expect(current).not.toBeNull()
    if (!current) throw new Error('expected typed integration proof')
    expect(
      integrationReceiptMatchesOrder(current, {
        issueId: rootIssueId,
        approvedHeadSha: 'integrated-root-head',
        descendantManifest: [childB, childA],
      }),
    ).toBe(true)
    expect(
      integrationReceiptMatchesOrder(current, {
        issueId: rootIssueId,
        approvedHeadSha: 'integrated-root-head',
        descendantManifest: [childA],
      }),
    ).toBe(false)
  })

  it('persists evidenceManifestRef and a typed current integration receipt', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-shipping-evidence-')), 'shipping.db')
    const childA = {
      issueId: asIssueId('iss_child_a'),
      approvedHeadSha: 'sha-a',
    }
    const childB = {
      issueId: asIssueId('iss_child_b'),
      approvedHeadSha: 'sha-b',
    }
    const evidenced = shipOrder({
      evidenceManifestRef: 'evidence://manifest/1',
      descendantManifest: [childA, childB],
      currentIntegrationReceipt: {
        rootIssueId: asIssueId('iss_1'),
        approvedHeadSha: 'approved-head',
        descendants: [childB, childA],
      },
    })
    const s = new SessionStore(file)
    s.issues.upsertIssue(base())
    expect(s.shipping.createOrder(evidenced)).toEqual(evidenced)
    expect(s.shipping.createOrder(evidenced)).toEqual(evidenced)
    expect(() =>
      s.shipping.createOrder({
        ...evidenced,
        currentIntegrationReceipt: {
          ...evidenced.currentIntegrationReceipt!,
          approvedHeadSha: 'stale-head',
        },
      }),
    ).toThrow()
    expect(() =>
      s.shipping.createOrder(
        shipOrder({
          id: asShipOrderId('order-missing-receipt'),
          descendantManifest: [childA],
        }),
      ),
    ).toThrow()
    expect(() =>
      rawDb(s)
        .prepare('UPDATE ship_orders SET evidence_manifest_ref = ? WHERE id = ?')
        .run('evidence://other', evidenced.id),
    ).toThrow(/approval is immutable/)
    expect(() =>
      rawDb(s)
        .prepare('UPDATE ship_orders SET current_integration_receipt = ? WHERE id = ?')
        .run('{}', evidenced.id),
    ).toThrow(/approval is immutable/)
    s.close()
    const restarted = new SessionStore(file)
    expect(restarted.shipping.getOrder(evidenced.id)).toEqual(evidenced)
    restarted.close()
  })
})

/** White-box seam: reach the store's own SQLite connection to inject corrupt rows. */
function rawDb(s: SessionStore): {
  prepare(q: string): { run(...a: unknown[]): unknown }
} {
  return (
    s as unknown as {
      db: { prepare(q: string): { run(...a: unknown[]): unknown } }
    }
  ).db
}
