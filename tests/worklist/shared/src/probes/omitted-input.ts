import { here } from '@podium/client-graph/lookup'
/**
 * POD-4564 (L6b) — P1, omitted input: a derivation reads an input its
 * invalidation does not know about.
 */

import type { Probe } from './probe'
import { firing } from './run'

const HOLDER = `/** The fixture pool: tables of borrowed rows. */
export class Pool {
  readonly issues = new Map<string, { id: string; title: string; stage: string; parentId?: string | null }>()
  readonly sessions = new Map<string, { sessionId: string; issueId?: string | null }>()
  readonly worktrees = new Map<string, { path: string }>()
`

export const omittedInput: Probe = {
  id: 'P1-omitted-input',
  title: 'Omitted input',
  mistake:
    "A row view reads an input (here the issue's own title) that the arm's invalidation does not list or track, so a change to that input alone leaves the row stale until some other input of the same row moves and heals it.",
  provenance: [
    'K MobX exercise Table 2 row D and K hand exercise row D (docs/decisions/4441-k-*-exercise.md): a new input the arm never declared; silent on typecheck, lint and parity, caught only by an input-shaped behaviour test',
    'Audit §3.3: the hand arm reads the clock in its roll-up while `ClockChanged` is a no-op (an input read but not subscribed)',
    'Pitfall (i): a hand-maintained list of dependencies under another name (sensitivity sets, input inventories)',
    'L1c §5 / write contract S2–S3: a rejection rewinds to the latest server value and a remote update lands on a pending field; both are title-only changes to the row',
  ],
  referencePlant: 'omittedInput',
  recipes: {
    mobx: {
      where:
        "The row view's own-row part: the computed on the issue model that builds the L1b own-row fields (`title`, `band`, `repoKey`, …) from the borrowed issue row (schema doc §2; row view contract §2).",
      patch: [
        'Give the displayed title its own computed (or reuse the part that already derives it) and read the row through `untracked(() => here(pool.issue(id))?.title)`, so the computed has no tracked dependency on the row it reads.',
        'Equivalent forms (plant ONE): copy `row.title` into a plain field at ingest and read the copy; or give the part a custom `equals` that ignores `title`.',
        'Do not touch any other part: other fields must stay tracked, so the row still redraws when they move (the heal the probe must see through).',
      ],
      revert:
        'Remove the `untracked` wrapper (or the copy, or the comparer) and re-run the probe: the behaviour test and the gate go green.',
    },
    hand: {
      where:
        "The per-row invalidation map: the declaration of which feed fields dirty which row-view part (the arm's input list for its own-row part; L1b row view contract §2 names the inputs).",
      patch: [
        'Remove `title` from the fields that dirty the own-row part (or from whatever list decides that an issue update needs its row re-derived).',
        'If the arm types that map exhaustively over the row fields, the patch will not compile: record that (typecheck FIRED) and plant the runtime form instead: filter `title` out where the changed fields are computed.',
      ],
      revert: 'Restore the field in the map and re-run the probe.',
    },
  },
  behaviour: {
    test: "Every input a row reads reaches the row: after a change to one input alone (a session's phase #2, the selection #3, the title #4, the clock across a deadline #8b; a title edit accepted and echoed, a second edit rejected after a remote update landed on it), the arm's snapshot equals the oracle's and its own rebuild.",
    needs: ['parity', 'gate'],
    steps: ['#2', '#3', '#4', '#8b'],
    sequences: [
      {
        name: 'title through the write path',
        why: 'Steps 0, 3 and 5 each change only the title of one visible row: an optimistic edit (then its receipt and echo, which move nothing), a second edit, and its rejection after a remote update landed on the pending field, which rewinds to the remote value (write contract S2/S3). The rejection comes last because a refused title parks its partition for good (kernel outbox). The tick moves the clock input.',
        build: (t) => [
          { kind: 'edit', handle: 'p1a', id: t.visibleRootId, patch: { title: 'Probe title A' } },
          { kind: 'accept', handle: 'p1a' },
          { kind: 'echo', handle: 'p1a' },
          { kind: 'edit', handle: 'p1b', id: t.visibleRootId, patch: { title: 'Probe title B' } },
          { kind: 'remoteOnPending', handle: 'p1b', value: 'Probe title C (remote)' },
          { kind: 'reject', handle: 'p1b' },
          { kind: 'clockTick', ms: 25 * 60 * 60 * 1000 },
        ],
      },
    ],
    failure: (run) => firing(run, 'parity') ?? firing(run, 'gate'),
  },
  detectors: [
    {
      instrument: 'typecheck',
      mobx: 'silent',
      hand: {
        firesIf:
          'the arm types its input map exhaustively over the row fields (K hand D: the never-check fires when a kind is added unhandled)',
      },
      reference: 'not-run',
      control: 'not-run',
      why: 'An untracked read and a shorter list are both well-typed; only an exhaustive map turns the omission into a type error.',
    },
    {
      instrument: 'lint-fence',
      mobx: 'silent',
      hand: 'silent',
      reference: 'blind',
      control: 'blind',
      why: 'No lint rule names a missing dependency (measured on both shapes in harness/lint/probes-lint.test.ts). The control is outside `arms/`.',
    },
    {
      instrument: 'commit-fence',
      mobx: 'fires',
      hand: 'fires',
      reference: 'fires',
      control: 'fires-unplanted',
      why: 'The renamed row changes view and does not redraw (#4 under-commit). The control over-commits on every step with no plant.',
    },
    {
      instrument: 'reads-fence',
      mobx: 'silent',
      hand: 'silent',
      reference: 'silent',
      control: 'fires-unplanted',
      why: 'Reading less is never over budget. The control walks the corpus on every change.',
    },
    {
      instrument: 'parity',
      mobx: 'fires',
      hand: 'fires',
      reference: 'fires',
      control: 'silent',
      why: "The arm's snapshot keeps the old title (#4). The control projects the store fresh, so it passes.",
    },
    {
      instrument: 'gate',
      mobx: 'fires',
      hand: 'fires',
      reference: 'fires',
      control: 'silent',
      why: 'The rebuild reads the current title: the first title-only change diverges and shrinks to that one change.',
    },
    {
      instrument: 'relation-check',
      mobx: 'silent',
      hand: 'silent',
      reference: 'silent',
      control: 'blind',
      why: 'No relation moves. The control hands the fence no relation accessor.',
    },
    {
      instrument: 'history-check',
      mobx: 'fires',
      hand: 'fires',
      reference: 'fires',
      control: 'silent',
      why: 'A fresh arm reads the title at creation; the long-lived one kept the old value.',
    },
    {
      instrument: 'behaviour-test',
      mobx: 'fires',
      hand: 'fires',
      reference: 'fires',
      control: 'silent',
      why: 'Parity on #4 and the gate on the write-path sequence.',
    },
    {
      instrument: 'arm-tests',
      mobx: {
        firesIf:
          'the suite has a title-only change on a row it asserts (round two: none did, the input rode no corpus row)',
      },
      hand: { firesIf: 'the suite has a title-only change on a row it asserts' },
      reference: 'not-run',
      control: 'not-run',
      why: 'K D: the only detector was a behaviour test written for the input; an arm suite without one is blind.',
    },
  ],
  lintPlants: [
    {
      name: 'hand: the input list omits title',
      substrate: 'hand',
      file: 'store.ts',
      code: `${HOLDER}}

/** Fields whose change re-derives a row's own part. PLANTED (P1): \`title\` omitted. */
export const OWN_INPUTS = ['stage', 'parentId'] as const

export function createPool(): Pool {
  return new Pool()
}
`,
      expect: [],
    },
    {
      name: 'mobx: the title read untracked',
      substrate: 'mobx',
      file: 'store.ts',
      code: `import { computed, untracked } from 'mobx'

${HOLDER}
  /** PLANTED (P1): the title is read outside the tracked graph. */
  titleOf(id: string) {
    return computed(() => untracked(() => this.issues.get(id)?.title))
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
