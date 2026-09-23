/**
 * POD-4564 (L6b) — P4, untracked state read inside a derivation: a
 * derivation reads plain state (a `Set`, a variable) that nothing tracks, so
 * its result carries the history of how it was evaluated.
 */

import { firing } from './run'
import type { Probe } from './probe'

const TABLES = `  readonly issues = new Map<string, { id: string; parentId?: string | null }>()
  readonly sessions = new Map<string, { sessionId: string; issueId?: string | null }>()
  readonly worktrees = new Map<string, { path: string }>()
`

const VISIBLE = (guard: string): string => `  /** Visible when its parent chain is. PLANTED (P4): a plain re-entrancy guard. */
  visible(id: string): boolean {
    if (${guard}.has(id)) return false
    ${guard}.add(id)
    try {
      const parentId = this.issues.get(id)?.parentId
      return parentId == null ? true : this.visible(parentId)
    } finally {
      ${guard}.delete(id)
    }
  }
`

export const untrackedState: Probe = {
  id: 'P4-untracked-state',
  title: 'Untracked state read inside a derivation',
  mistake:
    "A derivation reads the arm's own plain state — a `Set` used as a guard or cache, a module variable — that no invalidation tracks. The derived value then depends on the order and history of evaluation: a row that met the state caches a stale or default value with no dependency on what it deferred to.",
  provenance: [
    "Audit §3.3 (MobX): the visibility getter uses a plain `Set` as a re-entrancy guard read inside a computed; a row that hits the guard caches `false` with no tracked dependency on the row it deferred to — unexercised by any corpus",
    'K MobX exercise Table 2 row D: a plain module variable read by a computed; identical with enforcement ON and OFF (a plain read is not an observable read: nothing to warn about)',
    'Pitfall (j): untracked state read inside a derivation (a plain Set or variable)',
  ],
  referencePlant: 'guardSet',
  recipes: {
    mobx: {
      where:
        'Any derivation that runs inside a computed: a row-view part, or (from the worklist phase) the visible-set or roll-up recursion over declared relations.',
      patch: [
        "Audit shape: guard a recursive part with a plain `Set<string>` (an instance field, not observable): if the row is already in the set return a default (`false` / `0`) instead of recursing; add before, delete after. A row evaluated while its ancestor is on the stack caches the default.",
        'Deterministic shape (use it when the recursion does not exist yet): keep a plain `Set` of rows "already refreshed", filled when a row-view part recomputes and cleared only on a clock notification; a part whose row is in the set returns its previous value from a plain `Map` instead of recomputing.',
        'Keep the state out of MobX (no `observable`), as an instance field: at module scope the lint fence fires, and that is a separate record.',
      ],
      revert: 'Remove the set and its reads; re-run the probe.',
    },
    hand: {
      where: 'The row-view derivation or the dirty-row pass (whatever decides which rows re-derive after a feed event).',
      patch: [
        'Keep a plain `Set` of rows "already refreshed", consulted inside the derivation: a row in it keeps its previous view; fill it when a row re-derives on a feed event; clear it only on a locals notification (the clock or a click).',
        'Keep it as an instance field or closure (module scope is a separate lint record).',
      ],
      revert: 'Remove the set and its reads; re-run the probe.',
    },
  },
  behaviour: {
    test:
      "The arm's output is a function of its current inputs, never of its history: after every change of a sequence that changes one row twice with no tick or click between, the long-lived arm equals a fresh arm over the same feed and its own rebuild.",
    needs: ['history-check', 'gate'],
    steps: ['#2', '#4'],
    sequences: [
      {
        name: 'same row twice, nothing between',
        why: 'Steps 0 and 3 each change the title of the same visible row; the receipt and echo between them move no view and no local. The second change is the one a guard or stale cache swallows.',
        build: (t) => [
          { kind: 'edit', handle: 'p4a', id: t.visibleRootId, patch: { title: 'Probe first title' } },
          { kind: 'accept', handle: 'p4a' },
          { kind: 'echo', handle: 'p4a' },
          { kind: 'edit', handle: 'p4b', id: t.visibleRootId, patch: { title: 'Probe second title' } },
        ],
      },
      {
        name: 'same row twice, a tick between',
        why: 'The same two changes with a one-minute clock tick between them. It changes no row view, and it is the history the planted guard depends on: the reference plant PASSES this sequence and fails the one above (history, not inputs, decides).',
        build: (t) => [
          { kind: 'edit', handle: 'p4c', id: t.visibleRootId, patch: { title: 'Probe first title' } },
          { kind: 'clockTick', ms: 60_000 },
          { kind: 'edit', handle: 'p4d', id: t.visibleRootId, patch: { title: 'Probe second title' } },
        ],
      },
    ],
    failure: (run) => firing(run, 'history-check') ?? firing(run, 'gate'),
  },
  detectors: [
    {
      instrument: 'typecheck',
      mobx: 'silent',
      hand: 'silent',
      reference: 'not-run',
      control: 'not-run',
      why: 'A Set is well-typed.',
    },
    {
      instrument: 'lint-fence',
      mobx: { firesIf: 'the state is at module scope (`no-hidden-state`); silent as an instance field or a closure (measured)' },
      hand: { firesIf: 'the state is at module scope (`no-hidden-state`)' },
      reference: 'blind',
      control: 'blind',
      why: 'The rule sees declarations, not reads: an instance-field Set is invisible to it, as to the copy sweep.',
    },
    {
      instrument: 'commit-fence',
      mobx: 'silent',
      hand: 'silent',
      reference: 'silent',
      control: 'fires-unplanted',
      why: 'Each fence step is ONE change on a fresh engine: no history for the state to carry. The fixed scenarios cannot see P4 (the audit\'s point).',
    },
    {
      instrument: 'reads-fence',
      mobx: 'silent',
      hand: 'silent',
      reference: 'silent',
      control: 'fires-unplanted',
      why: 'The guard reads nothing extra.',
    },
    {
      instrument: 'parity',
      mobx: 'silent',
      hand: 'silent',
      reference: 'silent',
      control: 'silent',
      why: 'As for the commit fence: one change per engine.',
    },
    {
      instrument: 'gate',
      mobx: 'fires',
      hand: 'fires',
      reference: 'fires',
      control: 'silent',
      why: "The rebuild has no history: the second title change diverges. It needs a sequence that reaches the guard's path; random sequences may or may not.",
    },
    {
      instrument: 'relation-check',
      mobx: 'silent',
      hand: 'silent',
      reference: 'silent',
      control: 'blind',
      why: 'No relation moves.',
    },
    {
      instrument: 'history-check',
      mobx: 'fires',
      hand: 'fires',
      reference: 'fires',
      control: 'silent',
      why: 'A fresh arm has no guard contents: it shows the second title.',
    },
    {
      instrument: 'behaviour-test',
      mobx: 'fires',
      hand: 'fires',
      reference: 'fires',
      control: 'silent',
      why: 'Through the history check and the gate.',
    },
    {
      instrument: 'arm-tests',
      mobx: { firesIf: 'a test drives a row twice between ticks, or MobX enforcement is turned into a throw on a plain read (it cannot be: K MobX D, ON = OFF)' },
      hand: { firesIf: 'a test drives a row twice between ticks' },
      reference: 'not-run',
      control: 'not-run',
      why: 'Neither substrate has a runtime detector for a plain read; only a history-shaped test sees it.',
    },
  ],
  lintPlants: [
    {
      name: 'module-scope guard',
      substrate: 'both',
      file: 'store.ts',
      code: `/** PLANTED (P4): a guard at module scope. */
const visiting = new Set<string>()

/** The fixture pool: tables of borrowed rows. */
export class Pool {
${TABLES}
${VISIBLE('visiting')}}

export function createPool(): Pool {
  return new Pool()
}
`,
      expect: ['fence/no-hidden-state'],
    },
    {
      name: 'instance-field guard',
      substrate: 'both',
      file: 'store.ts',
      code: `/** The fixture pool: tables of borrowed rows. */
export class Pool {
${TABLES}  /** PLANTED (P4): a guard as a plain instance field. */
  private readonly visiting = new Set<string>()

${VISIBLE('this.visiting')}}

export function createPool(): Pool {
  return new Pool()
}
`,
      expect: [],
    },
  ],
}
