import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type Census,
  type CensusEntry,
  checkCensus,
  INTERACTION_ROOTS,
  MANIFEST,
  productionFiles,
  type Scan,
  scanRepository,
  scanSources,
} from './check-interaction-scans'

const WEB = 'apps/web/src/interaction.tsx'
const hits = (source: string, file = WEB) => scanSources({ [file]: source })
function census(scans: Scan[]): Census {
  return {
    version: 1,
    roots: [...INTERACTION_ROOTS],
    entries: scans.map(({ lines: _lines, ...scan }) => ({
      ...scan,
      classification: 'REQUIRED REPAIR',
      owner: 'POD-5530',
      trigger: 'Interaction',
      bound: 'Unbounded collection',
      reason: 'Replace with addressed work',
      guard: 'Exact census only; not a fix',
    })),
  }
}
function changed(before: string, after: string): string[] {
  return checkCensus(hits(after), census(hits(before)))
}

describe('interaction scan census', () => {
  it('catches consumers independently of an unchanged broad acquisition', () => {
    const before = 'const rows = pool.queries.ids({kind: "commandIssues"});'
    const after = `${before} const found = rows.find(id => id === "POD-42");`
    expect(hits(before).some((hit) => hit.rule === 'question:commandIssues')).toBe(true)
    expect(changed(before, after).some((error) => error.includes('NEW/CHANGED'))).toBe(true)
    expect(hits(after).some((hit) => hit.rule === 'consume:find')).toBe(true)
  })
  it('tracks aliases, assignments, casts, brackets, optional access and destructuring', () => {
    for (const source of [
      'const raw=reader.issues(); const alias=(raw as any); alias?.["filter"](i=>i.stage==="open");',
      'const { issues: alias } = reader.issues(); alias.map(i=>i.title);',
      'const raw=reader.sessions(); let alias; alias=raw; alias.some(i=>i.id==="x");',
      'const raw=store.tables["issue"]; const {values}=raw; const alias=values(); alias.find(i=>i.id==="x");',
      'const raw=reader.issues(); const {filter: scan}=raw; scan(i=>i.id==="x");',
      'const {tables:t}=pool; const {issue:raw}=t; raw.values().filter(i=>i.live);',
      'const method="filter"; const rows=reader.issues(); rows[method](i=>i.live);',
      'const rows=reader.issues(); rows[dynamic](read);',
    ])
      expect(
        hits(source).some((hit) => hit.rule.startsWith('consume:')),
        source,
      ).toBe(true)
  })
  it('tracks generic helper returns and closures', () => {
    const source =
      'function identity(x){return x;} const rows=reader.issues(); const read=()=>identity(rows); read().flatMap(i=>i.labels);'
    expect(hits(source).some((hit) => hit.rule === 'consume:flatMap')).toBe(true)
  })
  it('fingerprints generic helper bodies even when consumers do not affect the return', () => {
    const before = 'function consume(x){return 0;} const rows=reader.issues(); consume(rows);'
    const after =
      'function consume(x){x.filter(i=>i.stage==="open"); return 0;} const rows=reader.issues(); consume(rows);'
    expect(changed(before, after).some((error) => error.includes('NEW/CHANGED'))).toBe(true)
    expect(
      changed(after, after.replace('"open"', '"done"')).some((error) =>
        error.includes('NEW/CHANGED'),
      ),
    ).toBe(true)
  })
  it('carries old exported hook origins into a new cross-file consumer and re-export', () => {
    const shared = {
      'packages/client-graph/src/shared/enumerate.ts': 'export const acquire=()=>reader.issues();',
      'packages/client-graph/src/index.ts':
        'export {acquire as allRows} from "./shared/enumerate";',
      'apps/mobile/src/client/hook.ts':
        'import {allRows} from "@podium/client-graph"; function read(fn){return fn();} export function useOldRows(){return read(allRows);}',
      'apps/mobile/src/client/index.ts': 'export * from "./hook";',
    }
    const old = {
      ...shared,
      'apps/mobile/app/index.tsx':
        'import {useOldRows as useRows} from "../src/client"; const rows=useRows();',
    }
    const next = {
      ...old,
      'apps/mobile/app/index.tsx': `${old['apps/mobile/app/index.tsx']} rows.find(i=>i.ref==="POD-4");`,
    }
    const scans = scanSources(next)
    expect(
      scans.some((hit) => hit.file === 'apps/mobile/app/index.tsx' && hit.rule === 'consume:find'),
    ).toBe(true)
    expect(
      checkCensus(scans, census(scanSources(old))).some((error) => error.includes('NEW/CHANGED')),
    ).toBe(true)
  })
  it('carries broad hook output through opaque React subscription state', () => {
    const shared = {
      'apps/mobile/src/client/hook.ts':
        'const read=()=>reader.issues(); function subscribe(fn){fn(); return opaqueState;} export function useOldRows(){return subscribe(read);}',
      'apps/mobile/app/index.tsx':
        'import {useOldRows} from "../src/client/hook"; useOldRows().filter(i=>i.stage==="done");',
    }
    expect(
      scanSources(shared).some(
        (hit) => hit.file === 'apps/mobile/app/index.tsx' && hit.rule === 'consume:filter',
      ),
    ).toBe(true)
  })
  it('resolves namespace imports, returned object methods and getters', () => {
    const scans = scanSources({
      'packages/client-graph/src/shared/enumerate.ts':
        'export const make=()=>({read(){return source.sessions()}, get rows(){return source.issues()}});',
      [WEB]:
        'import * as shared from "@podium/client-graph/shared/enumerate"; const reader=shared.make(); reader.read().filter(s=>s.live); reader.rows.map(i=>i.title);',
    })
    expect(scans.filter((hit) => hit.file === WEB && hit.rule.startsWith('consume:')).length).toBe(
      2,
    )
  })
  it('fails closed on dynamic/unknown question kinds and tracks literal aliases', () => {
    for (const expression of [
      'question',
      '{kind: dynamic}',
      '{kind:"futureIssues"}',
      '{kind: flag?"commandIssues":"commandSessions"}',
    ])
      expect(
        hits(`pool.queries.ids(${expression});`).some((hit) => /question/.test(hit.rule)),
      ).toBe(true)
    expect(
      hits('const query={kind:"commandIssues"} as const; pool.queries.ids(query).sort();').some(
        (hit) => hit.rule === 'question:commandIssues',
      ),
    ).toBe(true)
    expect(
      hits('const {ids}=pool.queries; ids(dynamic);').some(
        (hit) => hit.rule === 'dynamic-question',
      ),
    ).toBe(true)
  })
  it('tracks resident/known/all enumerators and collection input surfaces', () => {
    for (const source of [
      'knownIds(pool,"issue").sort();',
      'residentIds(pool,"session").map(read);',
      'allIssues().some(read);',
      'function paint(allSessions){return allSessions.filter(s=>s.live)}',
      'function paint(rows: readonly Issue[]){return rows.every(read)}',
    ])
      expect(
        hits(source).some((hit) => hit.rule.startsWith('consume:')),
        source,
      ).toBe(true)
  })
  it('tracks collections, tables, store enumerations, spreads and constructors', () => {
    for (const source of [
      'replica.collection("issues").filter(read);',
      'store.values().filter(read);',
      'Object.keys(store).map(read);',
      'reader.sessions().sessions.map(read);',
      'Object.values(state.issues).filter(read);',
      'store.tables.issue.forEach(read);',
      'const alias=pool.tables[entity]; [...alias.keys()];',
      'const alias=state.sessions; for(const row of alias) visit(row);',
      'Array.from(store.issues);',
      'new Map(store.issues);',
      'new Set(state.sessions);',
      'const rows=reader.issues(); for(let i=0;i<rows.length;i++) paint(rows[i]);',
    ])
      expect(
        hits(source).some((hit) => /consume:|spread|materialize:|loop/.test(hit.rule)),
        source,
      ).toBe(true)
  })
  it('retains predicates and control gates while ignoring comments, whitespace and lines', () => {
    const original =
      'function onOpen(){if (!open) return []; return reader.issues().filter(i=>i.stage === "open");}'
    expect(changed(original, `// a comment\n\n${original.replaceAll(' ', '  ')}`)).toEqual([])
    expect(changed(original, original.replace('"open"', '"done"')).length).toBeGreaterThan(0)
    expect(changed(original, original.replace('if (!open) return [];', '')).length).toBeGreaterThan(
      0,
    )
    expect(changed(original, original.replace('!open', '!visible')).length).toBeGreaterThan(0)
    for (const gate of [
      'return open ? reader.issues() : []',
      'return open && reader.issues()',
      'switch(open){case true:return reader.issues();default:return []}',
    ])
      expect(hits(`function get(){${gate};}`).some((hit) => hit.gate.length > 0)).toBe(true)
  })
  it('changes fingerprints when aliased predicates or caps change', () => {
    const predicate =
      'const stage="open"; const rows=reader.issues(); rows.filter(i=>i.stage===stage);'
    expect(changed(predicate, predicate.replace('"open"', '"done"')).length).toBeGreaterThan(0)
    const cap = 'const cap=3; const rows=reader.sessions(); rows.slice(0,cap).map(read);'
    expect(changed(cap, cap.replace('cap=3', 'cap=30')).length).toBeGreaterThan(0)
  })
  it('counts identical repeated scans as a multiset', () => {
    const one = 'function click(){reader.issues();}'
    const two = 'function click(){reader.issues();reader.issues();}'
    expect(hits(two)[0]?.count).toBe(2)
    expect(changed(one, two).some((error) => error.includes('multiplicity'))).toBe(true)
    expect(changed(two, one).some((error) => error.includes('multiplicity'))).toBe(true)
  })
  it('rejects new, changed, removed, duplicate, forged and malformed entries', () => {
    const scans = hits('function click(){reader.issues().filter(i=>i.live)}')
    const manifest = census(scans)
    expect(checkCensus(scans, manifest)).toEqual([])
    expect(checkCensus([], manifest).some((error) => error.includes('stale'))).toBe(true)
    expect(
      checkCensus(scans, { ...manifest, entries: [...manifest.entries, manifest.entries[0]] }).some(
        (error) => error.includes('duplicate'),
      ),
    ).toBe(true)
    for (const patch of [
      { count: 0 },
      { classification: 'waiver' },
      { reason: '' },
      { owner: 'nobody' },
      { origin: [] },
      { file: '*.tsx' },
      { tokens: 'forged' },
      { extra: 'waiver' },
    ])
      expect(
        checkCensus(scans, { ...manifest, entries: [{ ...manifest.entries[0], ...patch }] }).length,
      ).toBeGreaterThan(0)
    for (const malformed of [
      null,
      {},
      { ...manifest, version: 2 },
      { ...manifest, roots: ['apps/web/src'] },
      { ...manifest, entries: {} },
    ])
      expect(checkCensus(scans, malformed).length).toBeGreaterThan(0)
  })
  it('keeps lexical shadowing and unrelated local collections clean', () => {
    for (const source of [
      'function issues(){return []} issues().map(read);',
      'function knownIds(){return [1,2]} knownIds().filter(read);',
      'const reader={issues(){return []}, sessions(){return []}}; reader.issues().map(read); reader.sessions().filter(read);',
      'const rows=reader.issues(); function click(rows){return rows.map(read)}',
      'const rows=reader.sessions(); {const rows=[]; rows.filter(read)}',
      'const rows=reader.issues(); function click(){let rows=[]; rows.every(read)}',
      'const rows=reader.issues(); try{}catch(rows){rows.map(read)}',
      'const rows=reader.issues(); for(const rows of []) rows.map(read);',
      'const Object={keys:()=>[]}; Object.keys(state.issues).map(read);',
    ])
      expect(
        hits(source).filter((hit) => hit.rule.startsWith('consume:')),
        source,
      ).toEqual([])
  })
  it('keeps addressed questions, scalar reads, bounded queues, static fields and comments clean', () => {
    for (const source of [
      'pool.queries.ids({kind:"commandIssueSessions",issueId}).map(read);',
      'const q={kind:"sessionReference",ref}; pool.queries.ids(q);',
      'pool.queries.count({kind:"commandIssues"}); pool.row("issue",id); const table=new Map(); table.get(id); knownIssue(pool,id);',
      'const queue=[]; queue.push(work); while(queue.length<10) queue.shift();',
      'Object.keys(IssueWire.shape).filter(k=>k!=="id");',
      'const config={enabled:true}; Object.entries(config).map(read);',
      'pool.tables.issue.get(id); pool.tables.session.has(id); pool.tables.issue.size;',
      'function count(rows: readonly Issue[]){return rows.length} function read(table){return table.get(id)} read(pool.tables.issue);',
      '// reader.issues().filter(read)\nconst text="pool.queries.ids(dynamic)";',
    ])
      expect(hits(source), source).toEqual([])
  })
  it('records the numeric slicing acquisition without tainting bounded local work', () => {
    const scans = hits('const window=reader.issues().slice(0,20); window.map(read);')
    expect(scans.some((hit) => hit.rule === 'zero-arg:issues')).toBe(true)
    expect(scans.some((hit) => hit.rule === 'bounded-window')).toBe(true)
    expect(scans.some((hit) => hit.rule === 'consume:map')).toBe(false)
  })
  it('scans every root, including shared/enumerate and mobile app, and refuses missing roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'interaction-scans-'))
    try {
      expect(() => productionFiles(root)).toThrow('Missing production root')
      for (const directory of INTERACTION_ROOTS) {
        mkdirSync(join(root, directory), { recursive: true })
        writeFileSync(join(root, directory, 'sample.ts'), 'reader.issues();')
      }
      mkdirSync(join(root, 'packages/client-graph/src/shared'))
      writeFileSync(
        join(root, 'packages/client-graph/src/shared/enumerate.ts'),
        'reader.sessions();',
      )
      writeFileSync(join(root, 'apps/web/src/sample.test.ts'), 'reader.issues();')
      expect(productionFiles(root).length).toBe(INTERACTION_ROOTS.length + 1)
      expect(scanRepository(root).length).toBe(INTERACTION_ROOTS.length + 1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('keeps the reviewed production census exact with no broad path waivers', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), MANIFEST), 'utf8'))
    expect(checkCensus(scanRepository(), manifest)).toEqual([])
    const entries = manifest.entries as CensusEntry[]
    expect(
      entries.filter((entry) => entry.classification === 'REQUIRED REPAIR').length,
    ).toBeGreaterThan(0)
    expect(entries.every((entry) => !!entry.owner && !!entry.bound && !!entry.guard)).toBe(true)
  })
  it('wires the census into ordinary lint and the normal test gate', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    expect(pkg.scripts.lint).toContain('bun run lint:interaction-scans')
    expect(pkg.scripts.test).toContain('bun run lint:interaction-scans')
    expect(pkg.scripts['lint:interaction-scans']).toBe('bun scripts/check-interaction-scans.ts')
  })
})


it('traces collection callbacks through the shared MobX helper barrel', () => {
  const scans = scanSources({
    'packages/client-graph/src/example.ts': `
      import { keyedComputed } from '@podium/mobx-helpers'
      const read = keyedComputed('rows', (key) => pool.queries.ids({ kind: 'boardIssues' }))
      export function question() { return read('one').filter(id => id !== '') }
    `,
    'packages/mobx-helpers/src/index.ts': "export { keyedComputed } from './keyed-computed'",
    'packages/mobx-helpers/src/keyed-computed.ts': `
      export function keyedComputed(name, fn) { return key => fn(key) }
    `,
  })
  expect(scans.some(scan => scan.file === 'packages/client-graph/src/example.ts' && scan.rule === 'consume:filter')).toBe(true)
})

it.each([
  'return (...args) => fn.apply(undefined, args)',
  'return (key, read) => fn.call(undefined, key, read)',
])('traces forwarded callback arguments through the helper: %s', body => {
  const scans = scanSources({
    'packages/client-graph/src/example.ts': `
      import { keyedComputed } from '@podium/mobx-helpers'
      const read = keyedComputed('rows', (_key, query) => query())
      export function question() { return read('one', () => pool.queries.ids({ kind: 'boardIssues' })).filter(id => id !== '') }
    `,
    'packages/mobx-helpers/src/index.ts': "export { keyedComputed } from './keyed-computed'",
    'packages/mobx-helpers/src/keyed-computed.ts': `export function keyedComputed(name, fn) { ${body} }`,
  })
  expect(scans.some(scan => scan.file === 'packages/client-graph/src/example.ts' && scan.rule === 'consume:filter')).toBe(true)
  expect(scans.some(scan => scan.file === 'packages/mobx-helpers/src/keyed-computed.ts' && scan.rule === 'reader-summary')).toBe(true)
})
