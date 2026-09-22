/**
 * POD-4563 (L6a) — the lint fence can say NO and YES.
 *
 * Every rule fires on a planted file and stays quiet on its clean twin, at the
 * same path in the fixture arm (`fixtures/arms/planted/`, which lints clean as
 * a whole). The real config over the real `arms/` lints clean, and plants into
 * a real folder fire through the real config — so the rules the package's
 * `lint` script runs are the ones proven here.
 */
import { join } from 'node:path'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { fenceConfig } from './fence-plugin.mjs'

const PACKAGE_DIR = process.cwd().endsWith(join('packages', 'worklist-proto'))
  ? process.cwd()
  : join(process.cwd(), 'packages', 'worklist-proto')
const FIXTURES = 'harness/lint/fixtures/arms'
const PLANTED = `${FIXTURES}/planted`

const fixtureLint = new ESLint({
  cwd: PACKAGE_DIR,
  overrideConfigFile: true,
  overrideConfig: fenceConfig({ root: FIXTURES, frozen: [] }),
})
const realLint = new ESLint({ cwd: PACKAGE_DIR, overrideConfigFile: join(PACKAGE_DIR, 'eslint.config.mjs') })

async function problems(code: string, filePath: string, eslint = fixtureLint): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(PACKAGE_DIR, filePath) })
  return (result?.messages ?? []).map((message) => `${message.ruleId ?? 'parse'}: ${message.message}`)
}

const ROW = `import type { ReactElement } from 'react'
import type { RowProps } from '../../../../../shared/src/row-shell'
import { label } from './format'

export function Row({ row }: RowProps): ReactElement {
  return <div data-issue-row={row.id}>{label(row.displayRef, row.title)}</div>
}
`

const LIST = `import type { ReactElement } from 'react'
import { RowShell } from '../../../../../shared/src/row-shell'
import type { RowView } from '../../../../../shared/src/row-view'
import { Row } from './row'
import type { Pool } from './store'

export function List({ pool, views }: { pool: Pool; views: RowView[] }): ReactElement {
  return (
    <div data-rows={pool.issues.size}>
      {views.map((view) => (
        <RowShell key={view.id} row={view} component={Row} />
      ))}
    </div>
  )
}
`

describe('clean', () => {
  it('the fixture arm lints clean as a whole (the rules can say YES)', async () => {
    const results = await fixtureLint.lintFiles([`${PLANTED}/**/*.{ts,tsx}`])
    expect(results.length).toBeGreaterThanOrEqual(6)
    expect(results.flatMap((result) => result.messages.map((m) => `${result.filePath}: ${m.ruleId}: ${m.message}`))).toEqual([])
  })

  it('the real arms lint clean through the package config', async () => {
    const results = await realLint.lintFiles(['arms/**/*.{ts,tsx}'])
    expect(results.length).toBeGreaterThan(20)
    expect(results.flatMap((result) => result.messages.map((m) => `${result.filePath}: ${m.ruleId}: ${m.message}`))).toEqual([])
  })
})

describe('store in a row or component (L1b addendum)', () => {
  it('PLANTED: a row module importing the store is red; the same file without the import passes', async () => {
    const planted = `import { createPool } from './store'\n${ROW}\nexport const pool = createPool\n`
    expect(await problems(planted, `${PLANTED}/row.tsx`)).toEqual([
      expect.stringMatching(/^fence\/no-store-in-component: row module imports the store: '\.\/store' reaches store\.ts/),
    ])
    expect(await problems(ROW, `${PLANTED}/row.tsx`)).toEqual([])
  })

  it('PLANTED: a row reaching the store through a helper is red, naming the chain', async () => {
    const planted = ROW.replace("import { label } from './format'", "import { label } from './format'\nimport { usePool } from './hooks'") + '\nvoid usePool\n'
    expect(await problems(planted, `${PLANTED}/row.tsx`)).toEqual([
      expect.stringMatching(/reaches hooks\.ts → store\.ts/),
    ])
  })

  it('PLANTED: a component file (JSX) importing the store by value is red; `import type` passes', async () => {
    const planted = LIST.replace("import type { Pool } from './store'", "import { Pool } from './store'")
    expect(await problems(planted, `${PLANTED}/list.tsx`)).toEqual([
      expect.stringMatching(/component file imports the store/),
    ])
    expect(await problems(LIST, `${PLANTED}/list.tsx`)).toEqual([])
  })
})

describe('table walk outside the enumeration module', () => {
  const walks: [string, string][] = [
    ['.values()', 'for (const issue of pool.issues.values()) n += issue.id.length'],
    ['.keys()', 'for (const id of pool.sessions.keys()) n += id.length'],
    ['.entries()', "for (const [id] of pool['worktrees'].entries()) n += id.length"],
    ['.forEach()', 'pool.issues.forEach(() => { n += 1 })'],
    ['for…of', 'for (const entry of pool.issues) n += entry.length'],
    ['spread', 'n += [...pool.issues].length'],
    ['Array.from', 'n += Array.from(pool.sessions).length'],
  ]
  it.each(walks)('PLANTED: %s over a shared table in a component is red', async (how, walk) => {
    const planted = LIST.replace('  return (\n', `  let n = 0\n  ${walk}\n  return (\n`).replace('data-rows={pool.issues.size}', 'data-rows={n}')
    const found = await problems(planted, `${PLANTED}/list.tsx`)
    expect(found).toEqual([expect.stringMatching(new RegExp(`^fence/no-table-walk: ${how.replace(/[.()[\]]/g, '\\$&')} over shared table`))])
  })

  it('the same walk inside the declared enumeration module passes', async () => {
    const code = `import type { Pool } from './store'\nexport function count(pool: Pool): number {\n  let n = 0\n  for (const id of pool.issues.keys()) n += id.length\n  return n\n}\n`
    expect(await problems(code, `${PLANTED}/visible.ts`)).toEqual([])
    expect(await problems(code, `${PLANTED}/other.ts`)).toEqual([
      expect.stringMatching(/^fence\/no-table-walk: \.keys\(\) over shared table "issues" outside the enumeration module \(visible\.ts\)/),
    ])
  })

  it('a walk over a per-row relation (not a table) passes', async () => {
    const code = `export function sum(children: Iterable<string>): number {\n  let n = 0\n  for (const id of children) n += id.length\n  return n\n}\n`
    expect(await problems(code, `${PLANTED}/other.ts`)).toEqual([])
  })
})

describe('RowShell component at module scope (L1b addendum)', () => {
  it('PLANTED: an inline closure is red', async () => {
    const planted = LIST.replace('component={Row}', 'component={(p) => <Row row={p.row} />}')
    expect(await problems(planted, `${PLANTED}/list.tsx`)).toEqual([
      expect.stringMatching(/^fence\/row-component-module-scope: RowShell component must be an identifier/),
    ])
  })

  it('PLANTED: a component declared inside the list (a memoised closure over its props) is red', async () => {
    const planted = LIST.replace(
      '  return (\n',
      '  const Bound = ({ row }: { row: RowView }) => <Row row={row} key={pool.issues.size} />\n  return (\n',
    ).replace('component={Row}', 'component={Bound}')
    expect(await problems(planted, `${PLANTED}/list.tsx`)).toEqual([
      expect.stringMatching(/RowShell component "Bound" is declared inside a function/),
    ])
  })

  it('PLANTED: createElement(RowShell, { component: inline }) is red', async () => {
    const code = `import { createElement } from 'react'\nimport { RowShell } from '../../../../../shared/src/row-shell'\nimport { Row } from './row'\nexport const make = (view: never) => createElement(RowShell, { row: view, component: (p: never) => createElement(Row, p) })\n`
    expect(await problems(code, `${PLANTED}/make.ts`)).toEqual([expect.stringMatching(/must be an identifier/)])
  })
})

describe('wall clock', () => {
  it('PLANTED: Date.now in an arm is red, in source and in tests, in frozen arms too', async () => {
    const code = 'export const now = (): number => Date.now()\n'
    expect(await problems(code, `${PLANTED}/clock.ts`)).toEqual([expect.stringMatching(/^fence\/no-wall-clock/)])
    expect(await problems(code, `${PLANTED}/clock.test.ts`)).toEqual([expect.stringMatching(/^fence\/no-wall-clock/)])
    expect(await problems(code, 'arms/hand/clock.ts', realLint)).toEqual([expect.stringMatching(/^fence\/no-wall-clock/)])
    expect(await problems('export const t = new Date()\n', `${PLANTED}/clock.ts`)).toEqual([
      expect.stringMatching(/new Date\(\) reads it too/),
    ])
    expect(await problems('export const t = new Date(0)\n', `${PLANTED}/clock.ts`)).toEqual([])
  })
})

describe('hidden state (the copy sweep cannot see it)', () => {
  it('PLANTED: module-scope let, new Map and observable() are red; a module-scope constant passes', async () => {
    expect(await problems('export let cache = 0\n', `${PLANTED}/state.ts`)).toEqual([expect.stringMatching(/module-scope `let`/)])
    expect(await problems('export const rows = new Map<string, object>()\n', `${PLANTED}/state.ts`)).toEqual([
      expect.stringMatching(/module-scope new Map\(\)/),
    ])
    expect(await problems("import { observable } from 'mobx'\nexport const box = observable.box(0)\n", `${PLANTED}/state.ts`)).toEqual([
      expect.stringMatching(/module-scope observable/),
    ])
    expect(await problems('export const LIMIT = 3\n', `${PLANTED}/state.ts`)).toEqual([])
  })

  it('PLANTED: a #private field is red; a TypeScript private field passes', async () => {
    expect(await problems('export class Pool {\n  #rows = new Map()\n  size(): number { return this.#rows.size }\n}\n', `${PLANTED}/pool.ts`)).toEqual([
      expect.stringMatching(/#private field hides state/),
    ])
    expect(await problems('export class Pool {\n  private rows = new Map()\n  size(): number { return this.rows.size }\n}\n', `${PLANTED}/pool.ts`)).toEqual([])
  })
})

describe('the manifest', () => {
  it('PLANTED: an arm folder without fence.json is red (a new arm cannot skip the fence)', async () => {
    expect(await problems('export const x = 1\n', `${FIXTURES}/bare/index.ts`)).toEqual([
      expect.stringMatching(/^fence\/arm-manifest: arm folder "bare" has no fence\.json/),
    ])
    expect(await problems('export const x = 1\n', 'arms/newarm/index.ts', realLint)).toEqual([
      expect.stringMatching(/arm folder "newarm" has no fence\.json/),
    ])
  })

  it('PLANTED: a README that does not name the enumeration module is red', async () => {
    expect(await problems('export const x = 1\n', `${FIXTURES}/noreadme/index.ts`)).toEqual([
      expect.stringMatching(/README\.md must name the enumeration module "visible\.ts"/),
    ])
  })
})
