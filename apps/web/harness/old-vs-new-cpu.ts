/** OLD/NEW offline sampled CPU attribution; shared mapping logic from the full-screen profile. Never runs or modifies the product.
 * bun apps/web/harness/full-screen-profile-analyze.ts --profile=all
 * All durations are clipped to speed:input → qualifying Paint end. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import ts from '../node_modules/typescript/lib/typescript.js'

type Frame = { functionName: string; url: string; lineNumber: number; columnNumber: number }
type Cpu = {
  startTime: number; endTime: number
  nodes: { id: number; callFrame: Frame; children?: number[]; hitCount?: number; positionTicks?: unknown[] }[]
  samples: number[]; timeDeltas: number[]
}
type Event = { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: { data?: { type?: string } } }
type Location = { file: string; line: number; column: number; name: string; mappedLine: number }
type Segment = { column: number; source: number; line: number; originalColumn: number }
type SourceMap = { sources: string[]; sourcesContent: (string | null)[]; mappings: string }
type Source = { ast: ts.SourceFile; functions: { start: number; entryStart: number; end: number; name: string; line: number }[] }
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const root = resolve('.artifacts/old-vs-new')
const directory = resolve(root, 'profiles', arg('profile', 'all'))
const buildDirectory = resolve(arg('build-dir', resolve(root, 'build')))
const read = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8'))
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function values(raw: string) {
  const out: number[] = []
  let value = 0, shift = 0
  for (const character of raw) {
    const digit = alphabet.indexOf(character)
    if (digit < 0) throw new Error('Invalid source map VLQ')
    value += (digit & 31) << shift
    if (digit & 32) shift += 5
    else { out.push(value & 1 ? -(value >> 1) : value >> 1); value = shift = 0 }
  }
  return out
}
function sourceName(path: string) {
  path = path.replaceAll('\\', '/')
  const dependency = path.lastIndexOf('/node_modules/')
  if (dependency >= 0) return path.slice(dependency + 1)
  for (const prefix of ['apps/', 'packages/', 'node_modules/']) {
    const index = path.indexOf(prefix)
    if (index >= 0) return path.slice(index)
  }
  return path
}
function functionName(node: ts.Node, ast: ts.SourceFile): string {
  if ('name' in node && node.name && ts.isIdentifier(node.name as ts.Node))
    return (node.name as ts.Identifier).text
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
    return parent.name.getText(ast)
  if (ts.isCallExpression(parent)) {
    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
    const called = parent.expression.getText(ast)
    let outer = parent.parent
    while (outer && !ts.isFunctionLike(outer)) outer = outer.parent
    const owner = outer ? functionName(outer, ast) : ''
    return `${owner ? owner + ' / ' : ''}${called.slice(-90)} callback@${line}`
  }
  return `<anonymous@${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}>`
}
class Maps {
  private maps = new Map<string, { map: SourceMap; lines: Segment[][] } | null>()
  private sources = new Map<string, Source>()
  readonly generatedAssets: string[] = []
  private source(file: string, code: string) {
    if (this.sources.has(file)) return
    const ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
    const functions: Source['functions'] = []
    const visit = (node: ts.Node) => {
      if (ts.isFunctionLike(node) && 'body' in node && node.body) {
        const parent = node.parent
        const entryStart = ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)
          ? parent.getStart(ast)
          // Hook/callback entries can map to the call before their arrow.
          // Keep those frames on the callback rather than its enclosing hook.
          : ts.isCallExpression(parent) && parent.arguments[0] === node
            ? ast.getPositionOfLineAndCharacter(ast.getLineAndCharacterOfPosition(parent.getStart(ast)).line, 0)
            : node.getStart(ast)
        functions.push({ start: node.getStart(ast), entryStart, end: node.end, name: functionName(node, ast),
          line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 })
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    this.sources.set(file, { ast, functions })
  }
  async prepare(url: string) {
    const name = url.split('/').pop()!
    if (!name.endsWith('.js') || this.maps.has(name)) return
    const pathname = new URL(url).pathname.replace(/^\/mobile\//, '').replace(/^\//, '')
    const asset = resolve(buildDirectory, pathname)
    let map: SourceMap
    try { map = await read<SourceMap>(asset + '.map') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // Rolldown's tiny generated interop/preload helpers have no original map.
      // Keep their generated coordinates, explicitly labelled, rather than
      // fabricating an application source location or dropping their samples.
      const code = await readFile(asset, 'utf8')
      this.source(`generated/assets/${name}`, code)
      this.generatedAssets.push(name)
      this.maps.set(name, null)
      return
    }
    let source = 0, line = 0, originalColumn = 0
    const lines = map.mappings.split(';').map((rawLine) => {
      let column = 0
      const segments: Segment[] = []
      for (const raw of rawLine.split(',')) {
        if (!raw) continue
        const v = values(raw)
        column += v[0]!
        if (v.length >= 4) {
          source += v[1]!; line += v[2]!; originalColumn += v[3]!
          segments.push({ column, source, line, originalColumn })
        }
      }
      return segments
    })
    this.maps.set(name, { map, lines })
    map.sources.forEach((path, i) => {
      const file = sourceName(path)
      if (this.sources.has(file) || !map.sourcesContent[i]) return
      this.source(file, map.sourcesContent[i]!)
    })
  }
  locate(frame: Frame): Location | null {
    const name = frame.url.split('/').pop()!
    const data = this.maps.get(name)
    if (data === null && frame.lineNumber >= 0) {
      const file = `generated/assets/${name}`, source = this.sources.get(file)!
      const position = source.ast.getPositionOfLineAndCharacter(frame.lineNumber, frame.columnNumber)
      const symbol = source.functions.filter(f => f.entryStart <= position && position < f.end)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]
      return { file, line: symbol?.line ?? frame.lineNumber + 1, column: frame.columnNumber + 1,
        mappedLine: frame.lineNumber + 1, name: symbol?.name ?? frame.functionName }
    }
    if (!data || frame.lineNumber < 0) return null
    const segments = data.lines[frame.lineNumber]
    if (!segments) return null
    let low = 0, high = segments.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (segments[middle]!.column <= frame.columnNumber) low = middle + 1
      else high = middle
    }
    const segment = segments[low - 1]
    if (!segment) return null
    const file = sourceName(data.map.sources[segment.source]!)
    const source = this.sources.get(file)
    let symbol: Source['functions'][number] | undefined
    if (source) {
      const position = source.ast.getPositionOfLineAndCharacter(segment.line, segment.originalColumn)
      // A minified function's entry often maps to its property/variable name,
      // before the arrow itself (e.g. `get: (...) => ...`). Include that entry
      // span so the enclosing factory does not absorb the accessor's samples.
      symbol = source.functions.filter((f) => f.entryStart <= position && position < f.end)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]
      // Some function-entry mappings point at the declaration immediately before
      // the arrow/function. Accept only a same-line declaration, never another body.
      if (!symbol) symbol = source.functions.find((f) => f.start >= position &&
        f.start - position < 100 && f.line === segment.line + 1)
    }
    return { file, line: symbol?.line ?? segment.line + 1, column: segment.originalColumn + 1,
      mappedLine: segment.line + 1, name: symbol?.name ?? frame.functionName }
  }
}
function union(intervals: [number, number][]) {
  const merged: [number, number][] = []
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    if (end <= start) continue
    const previous = merged.at(-1)
    if (previous && start <= previous[1]) previous[1] = Math.max(end, previous[1])
    else merged.push([start, end])
  }
  return merged.reduce((sum, [start, end]) => sum + end - start, 0) / 1000
}
const add = (map: Record<string, number>, key: string, ms: number) => { map[key] = (map[key] ?? 0) + ms }
function bucket(chain: { frame: Frame; source: Location | null }[]) {
  const names = chain.map(({ frame, source }) => source?.name ?? frame.functionName)
  const paths = chain.map(({ source }) => source?.file ?? '')
  if (names.includes('onCommitFiberRoot')) return 'measurement commit observer'
  if (names.includes('(garbage collector)')) return 'garbage collection'
  if (names.includes('(idle)')) return 'idle'
  if (names.some((name, i) => /renderRootSync|renderRootConcurrent|renderWithHooks/.test(name) && paths[i]!.includes('react-dom')))
    return 'React render (including called app/derivation code)'
  if (names.some((name, i) => /flushPassiveEffects|commitPassiveMount|commitPassiveUnmount/.test(name) && paths[i]!.includes('react-dom')))
    return 'React passive effects'
  if (names.some((name, i) => /commitRoot|flushMutationEffects|flushLayoutEffects|flushSpawnedWork|commitLayoutEffect/.test(name) && paths[i]!.includes('react-dom')))
    return 'React commit/layout effects (including native calls)'
  if (names.some((name, i) => /runReaction_|runReactionsHelper/.test(name) && paths[i]!.includes('mobx')))
    return 'MobX reactions outside React render/commit'
  if (paths.some((path) => path.includes('/mobx/') || path.includes('/mobx-react-lite/')))
    return 'other MobX tracking/computed/scheduling'
  return 'other JS/native/program'
}

const runFile = resolve(arg('run', 'run.json'))
const run = await read<{actions: {profiled: boolean; cpu: string | null; action: string; trace: string}[]}>(runFile)
const maps = new Maps()
const summaries = []
for (const action of run.actions) {
  if (!action.profiled || !action.cpu) continue
  const profile = await read<Cpu>(resolve(runFile, '..', action.cpu))
  for (const node of profile.nodes) if (node.callFrame.url.endsWith('.js')) await maps.prepare(node.callFrame.url)
  const nodes = new Map(profile.nodes.map(n => [n.id, n]))
  const parents = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)
  const buckets: Record<string, number> = {}
  const events: Event[] = JSON.parse(gunzipSync(await readFile(resolve(runFile, '..', action.trace))).toString())
  const input = events.find(e => e.name === 'comparison:input')!
  const dom = events.find(e => e.name === 'comparison:dom')!
  const paint = events.filter(e => e.name === 'Paint' && e.ph === 'X' && e.pid === input.pid && e.ts >= dom.ts).sort((a,b) => a.ts-b.ts)[0]!
  const end = paint.ts + (paint.dur ?? 0)
  let cursor = profile.startTime
  let sampledMs = 0, storeDeriveInclusiveMs = 0, unmappedMs = 0
  for (let index = 0; index < profile.samples.length; index++) {
    const next = cursor + profile.timeDeltas[index]!
    const ms = Math.max(0, Math.min(next, end) - Math.max(cursor, input.ts)) / 1000
    cursor = next
    if (ms === 0) continue
    const chain: {frame: Frame; source: Location | null}[] = []
    let id: number | undefined = profile.samples[index]
    while (id !== undefined) {
      const node = nodes.get(id)!
      chain.push({frame: node.callFrame, source: maps.locate(node.callFrame)})
      id = parents.get(id)
    }
    const kind = bucket(chain)
    add(buckets, kind, ms); sampledMs += ms
    if (chain.some(({source}) => source && /packages\/client-core\/(engine|viewmodels|replica)|packages\/client-graph\//.test(source.file))) storeDeriveInclusiveMs += ms
    if (chain.some(({frame, source}) => frame.url.endsWith('.js') && !source)) unmappedMs += ms
  }
  summaries.push({action:action.action,cpu:action.cpu,sampledMs,buckets,storeDeriveInclusiveMs,unmappedMs})
}
await writeFile(resolve(runFile, '..', 'cpu-attribution.json'), JSON.stringify({method:'V8 sampled stack wall time at 100 microsecond requested interval; inclusive store/derive overlaps React categories, never add them. Profiles are clipped to trusted input through qualifying Paint; sampled time is approximate wall-time attribution, not hardware CPU. Idle/program/unmapped samples remain explicit.',summaries},null,2)+'\n')
console.log(`Attributed ${summaries.length} action profiles`)
