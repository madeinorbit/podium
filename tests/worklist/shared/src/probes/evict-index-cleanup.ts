/**
 * POD-4564 (L6b) — P2, missing index cleanup on eviction: a deleted or
 * evicted row stays in the collections that held it.
 */

import type { Probe } from './probe'
import { firing } from './run'

const STORE = (body: string): string => `/** The fixture pool: tables of borrowed rows. */
export class Pool {
  readonly issues = new Map<string, { id: string; parentId?: string | null }>()
  readonly sessions = new Map<string, { sessionId: string; issueId?: string | null }>()
  readonly worktrees = new Map<string, { path: string }>()
  /** issue.children: parent id → child ids (the inverse collection). */
  readonly children = new Map<string, Set<string>>()
${body}}

export function createPool(): Pool {
  return new Pool()
}
`

export const evictIndexCleanup: Probe = {
  id: 'P2-evict-index-cleanup',
  title: 'Missing index cleanup on eviction',
  mistake:
    "A row arriving with `value: undefined` (a delete or an eviction) is removed from its table but left in the inverse collections that held it, so a parent's `children` still names a row the pool no longer has.",
  provenance: [
    'K MobX exercise Table 2 row E: orphan-block and session-seat deletes removed; the screen stays right (every read re-checks the table), only the bucket-level unit test `removal disposes buckets` (mobx.test.ts:375) fires',
    'K hand exercise row E: the same omission shows a ghost row on screen',
    'Audit §3.3: the hand arm re-adds an evicted row and never re-seats its relations (the generator shape `evictThenReAdd`)',
    'Schema doc §4.3 (delete): the pool removes the instance from the inverse collection on the other side; others keep the reference id',
  ],
  referencePlant: 'evictKeepsIndex',
  recipes: {
    mobx: {
      where:
        "The pool's delete path (schema doc §4.3): the relation maintenance the pool runs after the table write for a row arriving with `value: undefined` (for a schema-driven pool, the one generic maintenance function every relation goes through).",
      patch: [
        "When the incoming value is undefined, return from relation maintenance after the table delete, BEFORE the row is removed from its targets' inverse collections (for `issue.parent`: leave its id in the parent's `children`).",
        'Keep every other step: the table delete, the forward reference removal, the insert and update paths.',
      ],
      revert: 'Remove the early return and re-run the probe.',
    },
    hand: {
      where:
        "The delete handler (schema doc §4.3): the walk over the deleted row's declared relations that removes it from each target's inverse collection.",
      patch: [
        'Skip the inverse-collection removal for the deleted row (keep the table delete and the forward entry removal), for at least `issue.parent` → `children`.',
      ],
      revert: 'Restore the removal and re-run the probe.',
    },
  },
  behaviour: {
    test: 'An evicted or deleted row leaves every collection that held it, and a re-added row is found again: after every eviction (#6c, #6d; a child, a parent with children), re-add and deletion, no collection yields a row the feed does not hold, both directions of every relation agree, and the snapshot equals its rebuild and the oracle.',
    needs: ['relation-check'],
    steps: ['#6c', '#6d'],
    sequences: [
      {
        name: 'evict, re-add, delete',
        why: "Step 0 evicts a child (its parent's `children` must drop it), step 1 re-adds it (re-seated), steps 2–3 evict and re-add a parent with children (the children keep the reference id and are found again: audit §3.3), step 4 deletes a child for good.",
        build: (t) => [
          { kind: 'evict', id: t.keeperLeafId },
          { kind: 'reAdd', id: t.keeperLeafId },
          { kind: 'evict', id: t.visibleRootId },
          { kind: 'reAdd', id: t.visibleRootId },
          { kind: 'remove', entity: 'issue', id: t.reparentId },
        ],
      },
    ],
    failure: (run) => firing(run, 'relation-check') ?? firing(run, 'gate'),
  },
  detectors: [
    {
      instrument: 'typecheck',
      mobx: 'silent',
      hand: 'silent',
      reference: 'not-run',
      control: 'not-run',
      why: 'A skipped map operation is well-typed.',
    },
    {
      instrument: 'lint-fence',
      mobx: 'silent',
      hand: 'silent',
      reference: 'blind',
      control: 'blind',
      why: 'No rule inspects maintenance completeness (measured in harness/lint/probes-lint.test.ts).',
    },
    {
      instrument: 'commit-fence',
      mobx: {
        firesIf:
          'a row view reads the collection without re-checking the table (the hand ghost, K hand E); K MobX E: silent, every read guards',
      },
      hand: {
        firesIf:
          'a row view reads the collection without re-checking the table (K hand E: it does)',
      },
      reference: 'silent',
      control: 'fires-unplanted',
      why: 'The reference arm fails SOFT: its views never read the index, the variant only a graph check sees.',
    },
    {
      instrument: 'reads-fence',
      mobx: 'silent',
      hand: 'silent',
      reference: 'silent',
      control: 'fires-unplanted',
      why: 'Skipping work reads less.',
    },
    {
      instrument: 'parity',
      mobx: { firesIf: 'a row view reads the collection unguarded' },
      hand: { firesIf: 'a row view reads the collection unguarded' },
      reference: 'silent',
      control: 'silent',
      why: 'Fail-soft arms keep the screen right.',
    },
    {
      instrument: 'gate',
      mobx: {
        firesIf:
          'a row view reads the collection unguarded (the rebuild resolves relations from scratch)',
      },
      hand: { firesIf: 'a row view reads the collection unguarded' },
      reference: 'silent',
      control: 'silent',
      why: 'The gate compares snapshots, not buckets: a fail-soft arm passes it.',
    },
    {
      instrument: 'relation-check',
      mobx: 'fires',
      hand: 'fires',
      reference: 'fires',
      control: 'blind',
      why: "`ghost: issue:<parent>.children holds issue:<child>, which the feed no longer has` after #6d and the sequence's step 0. The control has no relation accessor.",
    },
    {
      instrument: 'history-check',
      mobx: { firesIf: 'a row view reads the collection unguarded' },
      hand: { firesIf: 'a row view reads the collection unguarded' },
      reference: 'silent',
      control: 'silent',
      why: 'A fresh arm has no ghost; it differs on screen only when the screen reads the ghost.',
    },
    {
      instrument: 'behaviour-test',
      mobx: 'fires',
      hand: 'fires',
      reference: 'fires',
      control: 'blind',
      why: 'Through the relation check. On the control it passes BLIND (nothing to check).',
    },
    {
      instrument: 'arm-tests',
      mobx: {
        firesIf:
          'the suite asserts buckets after a removal (K MobX E: `removal disposes buckets` did)',
      },
      hand: { firesIf: 'the suite asserts buckets after a removal' },
      reference: 'not-run',
      control: 'not-run',
      why: 'K MobX §6.3: index-bucket tests are the only arm tests that price the index.',
    },
  ],
  lintPlants: [
    {
      name: 'both: the delete leaves the bucket',
      substrate: 'both',
      file: 'store.ts',
      code: STORE(`
  /** PLANTED (P2): the parent's children bucket keeps the removed id. */
  remove(id: string): void {
    this.issues.delete(id)
  }
`),
      expect: [],
    },
  ],
}
