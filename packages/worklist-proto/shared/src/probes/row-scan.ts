/**
 * POD-4564 (L6b) — P3, O(N) scan inside a row: a row component walks a whole
 * entity table on every draw.
 */

import { firing } from './run'
import type { Probe } from './probe'

const ROW_HEAD = `import type { ReactElement } from 'react'
import { useContext } from 'react'
import type { RowProps } from '../../../../../shared/src/row-shell'
`

export const rowScan: Probe = {
  id: 'P3-row-scan',
  title: 'O(N) scan inside a row',
  mistake:
    "A row component reaches the pool (a context the list provides, or an import) and walks an entity table while it renders — here, counting the row's children by iterating every issue — so every redraw of one row costs the whole corpus.",
  provenance: [
    'K MobX exercise Table 2 row F: `for (const [, m] of store.issues) … m.row` in the observer row; LOUD in exact commit counts (the untouched sibling commits), silent in typecheck, lint, parity and derivation counts',
    'K hand exercise row F: the same scan is silent everywhere automated (plain React subscribes to nothing it walks)',
    'L1b row view contract addendum: a row gets its `RowView` and nothing else; the lint fence enforces it syntactically (`no-store-in-component`, `no-table-walk`)',
    'Pitfall (e): whole-table walks hidden in helpers',
  ],
  referencePlant: 'rowScan',
  recipes: {
    mobx: {
      where:
        'The row component (L1b: `Row({ row })`, rendered through `RowShell`; the module the arm\'s `fence.json` lists under `rows`).',
      patch: [
        "Give the row a way to the pool: a React context the list provides (`createContext` in a module that imports the pool type only), read with `useContext` in the row.",
        "Inside the row's render, walk an entity table the pool exposes (`for (const issue of table.values()) if (issue.parentId === row.id) children += 1`) and render the count.",
        'Keep the row an `observer`: the walk then subscribes the row to every issue (K MobX F).',
        'Write the walk over a local alias (`const table = pool.<issue table>`) so the lint fence\'s syntactic rule does not see it; record separately whether the direct form (`pool.<table>.values()`) is caught.',
      ],
      revert: 'Remove the context read and the walk; re-run the probe.',
    },
    hand: {
      where: 'The row component (L1b), as for MobX.',
      patch: [
        'Same patch: a context carrying the pool (or its issue table), read in the row, and the walk inside render. A plain React row subscribes to nothing it walks.',
      ],
      revert: 'Remove the context read and the walk; re-run the probe.',
    },
  },
  behaviour: {
    test:
      'A row draw reads only its row: on a change that redraws one row (#2 its session\'s phase, #4 its title), the reads per change stay within the step\'s budget and exactly the changed row redraws.',
    needs: ['reads-fence', 'commit-fence'],
    steps: ['#2', '#4'],
    sequences: [],
    failure: (run) => firing(run, 'reads-fence') ?? firing(run, 'commit-fence'),
  },
  detectors: [
    {
      instrument: 'typecheck',
      mobx: 'silent',
      hand: 'silent',
      reference: 'not-run',
      control: 'not-run',
      why: 'A context read and a loop are well-typed.',
    },
    {
      instrument: 'lint-fence',
      mobx: { firesIf: 'the walk is written over the declared table name, or the row imports a store module by value (measured: both fire on the direct shape, neither on an alias through a type-only context module)' },
      hand: { firesIf: 'as for MobX: the rule is syntactic' },
      reference: 'blind',
      control: 'blind',
      why: 'harness/lint/README.md "What the lint does not see": an alias passes `no-table-walk`.',
    },
    {
      instrument: 'commit-fence',
      mobx: 'fires',
      hand: 'silent',
      reference: 'silent',
      control: 'fires-unplanted',
      why: 'MobX: the observer row now depends on every issue, so a change to one redraws the others (K MobX F). Plain React (hand, and the reference arm): nothing subscribes, only the changed row redraws.',
    },
    {
      instrument: 'reads-fence',
      mobx: 'fires',
      hand: 'fires',
      reference: 'fires',
      control: 'fires-unplanted',
      why: 'Every redrawn row reads every issue through the fenced table: thousands against a budget of 3 (#4) or 3 per level (#2). The control reads the corpus unplanted.',
    },
    {
      instrument: 'parity',
      mobx: 'silent',
      hand: 'silent',
      reference: 'silent',
      control: 'silent',
      why: 'The screen is right; only the cost is wrong.',
    },
    {
      instrument: 'gate',
      mobx: 'silent',
      hand: 'silent',
      reference: 'silent',
      control: 'silent',
      why: 'The snapshot is right (checked against the rebuild after each step).',
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
      instrument: 'behaviour-test',
      mobx: 'fires',
      hand: 'fires',
      reference: 'fires',
      control: 'fires-unplanted',
      why: 'Through the reads fence. The control fails it with no plant: the baseline is that the control reads the corpus on every change.',
    },
    {
      instrument: 'arm-tests',
      mobx: { firesIf: 'the suite asserts exact commitsByRow on a change (K MobX F: `mobx.ui.test.tsx` did)' },
      hand: 'silent',
      reference: 'not-run',
      control: 'not-run',
      why: 'K hand F: nothing in the hand suite saw it; a hand arm is blind without the reads fence.',
    },
  ],
  lintPlants: [
    {
      name: 'direct: the row imports the store and walks the declared table',
      substrate: 'both',
      file: 'row.tsx',
      code: `${ROW_HEAD}import { PoolContext } from './store'

export function Row({ row }: RowProps): ReactElement {
  const pool = useContext(PoolContext)
  let children = 0
  for (const issue of pool.issues.values()) if (issue.parentId === row.id) children += 1
  return <div data-issue-row={row.id}>{children}</div>
}
`,
      expect: ['fence/no-store-in-component', 'fence/no-table-walk'],
    },
    {
      name: 'aliased: a type-only context module and a local alias',
      substrate: 'both',
      file: 'row.tsx',
      code: `${ROW_HEAD}import { PoolContext } from './context'

export function Row({ row }: RowProps): ReactElement {
  const pool = useContext(PoolContext)
  const table = pool === null ? new Map<string, { parentId?: string | null }>() : pool.issues
  let children = 0
  for (const issue of table.values()) if (issue.parentId === row.id) children += 1
  return <div data-issue-row={row.id}>{children}</div>
}
`,
      expect: [],
    },
  ],
}
