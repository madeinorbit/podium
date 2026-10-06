/**
 * POD-4564 (L6b) — P5, missing inverse on a declared relation: an update
 * moves the reference and leaves the inverse collection where it was.
 */

import type { Probe } from './probe'
import { firing } from './run'

export const missingInverse: Probe = {
  id: 'P5-missing-inverse',
  title: 'Missing inverse on a declared relation',
  mistake:
    "When an update changes a relation's declared inputs (a `belongsTo` foreign key, or a field its `where` reads), the pool rewrites the reference on the row but does not move the row between the old and the new target's inverse collections: `child.parent` says the new parent, the new parent's `children` lacks it, the old one's still holds it.",
  provenance: [
    'New in round three (brief): relations are declared once with their inverse and the pool maintains both directions (audit §7, Linear); this is the mistake that declaration exists to prevent',
    'Schema doc §4.2 (update): detach from the old and attach to the new, both endpoints, for every relation whose declared inputs changed, including every `where` field ("the one round two got wrong three times")',
    'Audit §3.3: every round-two arm hand-wrote relationship maintenance inside its derivations, where most bugs went',
  ],
  referencePlant: 'oneWayRelation',
  recipes: {
    mobx: {
      where:
        "The pool's update path (schema doc §4.2): relation maintenance for a row whose declared inputs changed (for a schema-driven pool, the generic function every relation goes through).",
      patch: [
        "When the row already existed and still exists (an update, not an insert or a delete), write the new forward reference and return BEFORE detaching the row from the old target's inverse collection and attaching it to the new one.",
        'Plant it for `issue.parent` → `children` at least; leave insert and delete maintaining both directions.',
      ],
      revert: 'Remove the early return and re-run the probe.',
    },
    hand: {
      where:
        'The update handler (schema doc §4.2): the detach-then-attach step for a relation whose foreign key or `where` fields changed.',
      patch: [
        'Update the forward reference only; skip the inverse-collection move, for `issue.parent` → `children` at least.',
      ],
      revert: 'Restore the move and re-run the probe.',
    },
  },
  behaviour: {
    test: 'Both directions of every declared relation agree after every change that moves an edge: a reparent (#7; to a new parent, to root, back), and an archive and unarchive (a `where` field of `issue.parent`).',
    needs: ['relation-check'],
    steps: ['#7'],
    sequences: [
      {
        name: 'reparent there and back, archive and unarchive',
        why: 'Steps 0–2 move one visible child to another parent, to the root and back to its original parent (each an update of `parentId`); steps 3–4 archive and unarchive it, which changes no foreign key but must drop and restore the parent edge (`where`, R1).',
        build: (t, corpus) => {
          const original = (
            corpus.issues as ReadonlyArray<{ id: string; parentId?: string | null }>
          ).find((issue) => issue.id === t.reparentId)?.parentId
          if (original == null) throw new Error(`[P5] ${t.reparentId} has no parent in the corpus`)
          return [
            { kind: 'reparent', id: t.reparentId, parentId: t.reparentToId },
            { kind: 'reparent', id: t.reparentId, parentId: null },
            { kind: 'reparent', id: t.reparentId, parentId: original },
            { kind: 'archive', id: t.reparentId, archived: true },
            { kind: 'archive', id: t.reparentId, archived: false },
          ]
        },
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
      why: 'A skipped move is well-typed.',
    },
    {
      instrument: 'lint-fence',
      mobx: 'silent',
      hand: 'silent',
      reference: 'blind',
      control: 'blind',
      why: 'No rule inspects maintenance completeness (measured).',
    },
    {
      instrument: 'commit-fence',
      mobx: {
        firesIf:
          "a row view reads the inverse collection (a parent's roll-up or nesting over `children`, the worklist phase): the old parent keeps and the new parent lacks the moved child",
      },
      hand: { firesIf: 'a row view reads the inverse collection' },
      reference: 'silent',
      control: 'fires-unplanted',
      why: "The reference arm's views never read the graph: fail-soft, only the relation check sees it.",
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
      mobx: { firesIf: 'a row view reads the inverse collection' },
      hand: { firesIf: 'a row view reads the inverse collection' },
      reference: 'silent',
      control: 'silent',
      why: 'As for the commit fence.',
    },
    {
      instrument: 'gate',
      mobx: {
        firesIf:
          'a row view reads the inverse collection (the rebuild resolves relations from scratch)',
      },
      hand: { firesIf: 'a row view reads the inverse collection' },
      reference: 'silent',
      control: 'silent',
      why: 'The gate compares snapshots, not the graph.',
    },
    {
      instrument: 'relation-check',
      mobx: 'fires',
      hand: 'fires',
      reference: 'fires',
      control: 'blind',
      why: '`one-way: issue:<child>.parent = issue:<new>, but issue:<new>.children does not hold <child>` after #7 and each sequence step. The control has no relation accessor.',
    },
    {
      instrument: 'history-check',
      mobx: { firesIf: 'a row view reads the inverse collection' },
      hand: { firesIf: 'a row view reads the inverse collection' },
      reference: 'silent',
      control: 'silent',
      why: 'A fresh arm builds both directions; it differs on screen only when the screen reads them.',
    },
    {
      instrument: 'behaviour-test',
      mobx: 'fires',
      hand: 'fires',
      reference: 'fires',
      control: 'blind',
      why: 'Through the relation check. On the control it passes BLIND.',
    },
    {
      instrument: 'arm-tests',
      mobx: {
        firesIf:
          'the suite checks relations against a from-scratch resolution after updates (the MobX pool gate does, POD-4566/4567 `diffRelations`)',
      },
      hand: { firesIf: 'the suite checks both directions after an update' },
      reference: 'not-run',
      control: 'not-run',
      why: "The arm-private form of this probe's relation check.",
    },
  ],
  lintPlants: [
    {
      name: 'both: the update moves the reference only',
      substrate: 'both',
      file: 'store.ts',
      code: `/** The fixture pool: tables of borrowed rows. */
export class Pool {
  readonly issues = new Map<string, { id: string; parentId?: string | null }>()
  readonly sessions = new Map<string, { sessionId: string; issueId?: string | null }>()
  readonly worktrees = new Map<string, { path: string }>()
  /** issue.parent (forward) and issue.children (inverse). */
  readonly parentOf = new Map<string, string>()
  readonly children = new Map<string, Set<string>>()

  /** PLANTED (P5): the inverse collections are not moved. */
  reparent(id: string, parentId: string): void {
    this.parentOf.set(id, parentId)
  }
}

export function createPool(): Pool {
  return new Pool()
}
`,
      expect: [],
    },
  ],
}
