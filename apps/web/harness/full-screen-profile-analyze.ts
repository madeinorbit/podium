/** Offline CPU/timeline/commit analysis. Never runs or modifies the product.
 * bun apps/web/harness/full-screen-profile-analyze.ts --profile=all
 * All durations are clipped to speed:input → qualifying Paint end. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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
const root = resolve('.artifacts/full-screen-click-profile')
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
          ? parent.getStart(ast) : node.getStart(ast)
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
    let map: SourceMap
    try { map = await read<SourceMap>(resolve(buildDirectory, 'assets', name + '.map')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // Rolldown's tiny generated interop/preload helpers have no original map.
      // Keep their generated coordinates, explicitly labelled, rather than
      // fabricating an application source location or dropping their samples.
      const code = await readFile(resolve(buildDirectory, 'assets', name), 'utf8')
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
const manifest = await read<{ sourceSha: string; records: string[]; repetitions: number }>(resolve(directory, 'manifest.json'))
const maps = new Maps()
const raw = []
const generatedNames = new Map<string, Location | null>()
for (const file of manifest.records) {
  const profile = await read<Cpu>(resolve(directory, file + '.cpuprofile'))
  for (const node of profile.nodes) if (node.callFrame.url.endsWith('.js')) await maps.prepare(node.callFrame.url)
  for (const node of profile.nodes) {
    const source = maps.locate(node.callFrame)
    if (source && node.callFrame.functionName && !source.file.includes('mobx-react-lite') && source.name !== node.callFrame.functionName) {
      const key = `${node.callFrame.url}|${node.callFrame.functionName}`
      const previous = generatedNames.get(key)
      generatedNames.set(key, previous === null || (previous &&
        (previous.file !== source.file || previous.line !== source.line)) ? null : source)
    }
  }
  raw.push({ file, profile })
}
const components: Record<number, Map<number, Location & { runtimeName: string }>> = {}
for (const pilot of [0, 1]) {
  const entries = await read<(Frame & { id: number; name: string; wrappedFunctions?: (Omit<Frame, 'functionName'> & { name: string })[] })[]>(resolve(directory, `components-pilot-${pilot ? 'on' : 'off'}.json`))
  components[pilot] = new Map()
  for (const entry of entries) {
    await maps.prepare(entry.url)
    let source = maps.locate({ ...entry, functionName: entry.name })
    if (source?.file.includes('mobx-react-lite')) {
      const originals = new Map<string, Location>()
      for (const original of entry.wrappedFunctions ?? []) {
        await maps.prepare(original.url)
        const mapped = maps.locate({ ...original, functionName: original.name })
        if (mapped?.file.startsWith('apps/') || mapped?.file.startsWith('packages/'))
          originals.set(`${mapped.file}:${mapped.line}`, mapped)
      }
      source = originals.size === 1 ? [...originals.values()][0]!
        : (entry.name ? generatedNames.get(`${entry.url}|${entry.name}`) : null) ?? source
    }
    if (!source) throw new Error(`Unmapped component ${entry.id}: ${entry.name}`)
    components[pilot]!.set(entry.id, { ...source, runtimeName: entry.name })
  }
}
const summaries = []
for (const { file, profile } of raw) {
  const record = await read<{
    sourceSha: string; action: string; pilot: number; iteration: number; loadavg: number[]
    paint: { inputToPaintMs: number }; boundary: { input: number }
    react: { commits: { at: number; end: number; components: Record<number, number>; visited: number }[] }
  }>(resolve(directory, file + '.json'))
  if (record.sourceSha !== manifest.sourceSha) throw new Error('Mixed SHAs')
  const events = (await read<{ traceEvents: Event[] }>(resolve(directory, file + '.trace.json'))).traceEvents
  const input = events.filter((e) => e.name === 'speed:input')
  const dom = events.filter((e) => e.name === 'speed:dom')
  if (input.length !== 1 || dom.length !== 1) throw new Error(`${file}: missing/duplicate boundary marks`)
  const mark = input[0]!
  const paint = events.filter((e) => e.name === 'Paint' && e.ph === 'X' && e.ts >= dom[0]!.ts && e.pid === mark.pid)
    .sort((a, b) => a.ts - b.ts)[0]
  if (!paint || paint.tid !== mark.tid) throw new Error(`${file}: missing main-thread Paint`)
  const start = mark.ts, end = paint.ts + (paint.dur ?? 0), wall = (end - start) / 1000
  if (Math.abs(wall - record.paint.inputToPaintMs) > 0.001 || end <= start || dom[0]!.ts < start)
    throw new Error(`${file}: invalid paint window`)
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parents = new Map(profile.nodes.flatMap((node) => (node.children ?? []).map((child) => [child, node.id] as const)))
  const chains = new Map<number, { frame: Frame; source: Location | null }[]>()
  for (const node of profile.nodes) {
    const chain = []
    let cursor: number | undefined = node.id
    while (cursor !== undefined) {
      const frame = nodes.get(cursor)!.callFrame
      chain.push({ frame, source: maps.locate(frame) })
      cursor = parents.get(cursor)
    }
    chains.set(node.id, chain)
  }
  let clock = profile.startTime
  const points = profile.samples.map((id, i) => { clock += profile.timeDeltas[i]!; return { clock, id } }).sort((a, b) => a.clock - b.clock)
  const self: Record<string, number> = {}, inclusive: Record<string, number> = {}, buckets: Record<string, number> = {}
  const functions = new Map<string, { name: string; source: string | null; mappedLine?: number; generated: string }>()
  const windowSamples: number[] = [], windowDeltas: number[] = []
  let previous = profile.startTime, sampled = 0, reactMobxMs = 0, reactionInclusiveMs = 0
  for (const point of points) {
    const ms = Math.max(0, Math.min(point.clock, end) - Math.max(previous, start)) / 1000
    previous = point.clock
    if (!ms) continue
    windowSamples.push(point.id)
    windowDeltas.push(ms * 1000)
    sampled += ms
    const chain = chains.get(point.id)!
    const kind = bucket(chain)
    add(buckets, kind, ms)
    const hasMobxDerivation = chain.some(({ source }) => source && /mobx\/.+\/(derivation|computedvalue)\.ts$/.test(source.file))
    if (kind.startsWith('React render') && hasMobxDerivation) reactMobxMs += ms
    if (chain.some(({ source }) => source?.file.includes('mobx') && /runReaction_|runReactionsHelper/.test(source.name))) reactionInclusiveMs += ms
    const seen = new Set<string>()
    chain.forEach(({ frame, source }, index) => {
      if (frame.functionName === '(root)') return
      const label = source ? `${source.name} — ${source.file}:${source.line}` : frame.functionName || '(native/unmapped)'
      functions.set(label, { name: (source?.name ?? frame.functionName) || '(native/unmapped)',
        source: source ? `${source.file}:${source.line}` : null, mappedLine: source?.mappedLine, generated: frame.functionName })
      if (index === 0) add(self, label, ms)
      if (!seen.has(label)) { add(inclusive, label, ms); seen.add(label) }
    })
  }
  if (sampled > wall + 0.01 || sampled < wall * 0.98) throw new Error(`${file}: incomplete/overlapping CPU coverage ${sampled}/${wall}`)
  const hitCounts = new Map<number, number>()
  for (const id of windowSamples) hitCounts.set(id, (hitCounts.get(id) ?? 0) + 1)
  await writeFile(resolve(directory, file + '.window.cpuprofile'), JSON.stringify({
    ...profile, startTime: start, endTime: end, samples: windowSamples, timeDeltas: windowDeltas,
    nodes: profile.nodes.map(({ positionTicks: _ticks, ...node }) => ({ ...node, hitCount: hitCounts.get(node.id) ?? 0 })),
  }))
  const main = events.filter((e) => e.ph === 'X' && e.pid === mark.pid && e.tid === mark.tid && e.ts < end && e.ts + (e.dur ?? 0) > start)
  const intervals = (selected: Event[]) => selected.map((e) => [Math.max(start, e.ts), Math.min(end, e.ts + (e.dur ?? 0))] as [number, number])
  const timeline: Record<string, number> = {}
  for (const name of ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'EventDispatch', 'FunctionCall', 'FireAnimationFrame'])
    timeline[name] = union(intervals(main.filter((e) => e.name === name)))
  timeline['layoutPaintUnion'] = union(intervals(main.filter((e) => ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint'].includes(e.name))))
  const taskEventName = main.some(e => e.name === 'ThreadControllerImpl::RunTask')
    ? 'ThreadControllerImpl::RunTask' : 'RunTask'
  const tasks = main.filter((e) => e.name === taskEventName)
  if (!tasks.length) throw new Error(`${file}: trace has no top-level task boundaries`)
  const longTasks = tasks.filter((e) => Math.min(end, e.ts + (e.dur ?? 0)) - Math.max(start, e.ts) > 50_000)
    .map((e) => ({ windowMs: (Math.min(end, e.ts + e.dur!) - Math.max(start, e.ts)) / 1000,
      fullMs: e.dur! / 1000, offsetMs: (e.ts - start) / 1000 }))
    .sort((a, b) => b.windowMs - a.windowMs)
  const commits = record.react.commits.filter((_commit, index) => {
    const marker = events.find((e) => e.name === `speed:commit:${index}`)
    if (!marker) {
      // Reading state after Tracing.end can see later commits. They have no
      // trace mark and cannot belong to the already-ended first-Paint window.
      const estimated = start + (_commit.at - record.boundary.input) * 1000
      if (estimated > end) return false
      throw new Error(`${file}: missing in-window commit marker ${index}`)
    }
    return marker.ts >= start && marker.ts <= end
  })
  const rendered: Record<string, number> = {}
  for (const commit of commits) for (const [id, count] of Object.entries(commit.components)) {
    const component = components[record.pilot]!.get(Number(id))
    if (!component) throw new Error(`${file}: missing component ${id}`)
    const name = component.file.includes('lucide') ? component.runtimeName : component.name
    add(rendered, `${name} — ${component.file}:${component.line}`, count)
  }
  const ranked = (counts: Record<string, number>) => Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([label, ms]) => ({ label, ...functions.get(label), ms }))
  summaries.push({ file, action: record.action, pilot: record.pilot, iteration: record.iteration, loadavg: record.loadavg,
    window: { inputUs: start, domUs: dom[0]!.ts, paintEndUs: end, wallMs: wall, domMs: (dom[0]!.ts - start) / 1000 },
    sampledMs: sampled, exclusiveSampledMs: buckets, mobxDerivationWithinReactRenderMs: reactMobxMs,
    mobxReactionInclusiveMs: reactionInclusiveMs, timelineMs: timeline,
    tasks: { eventName: taskEventName, count: tasks.length, longCount: longTasks.length, longestMs: longTasks[0]?.windowMs ?? 0,
      occupiedMs: union(intervals(tasks)), longTasks },
    commits: { count: commits.length, observerMs: commits.reduce((sum, c) => sum + c.end - c.at, 0),
      renderedInstances: Object.values(rendered).reduce((sum, count) => sum + count, 0), components: rendered },
    self: ranked(self), inclusive: ranked(inclusive),
  })
}
const groups = []
for (const action of new Set(summaries.map((s) => s.action))) for (const pilot of [0, 1]) {
  const records = summaries.filter((s) => s.action === action && s.pilot === pilot)
  if (records.length !== manifest.repetitions || new Set(records.map((r) => r.iteration)).size !== manifest.repetitions)
    throw new Error(`Expected ${manifest.repetitions} distinct samples per action/arm`)
  const medians = (select: (r: typeof records[number]) => Record<string, number>) => Object.fromEntries(
    [...new Set(records.flatMap((r) => Object.keys(select(r))))].map((key) => [key, median(records.map((r) => select(r)[key] ?? 0))]),
  )
  const top = (key: 'self' | 'inclusive') => {
    const labels = [...new Set(records.flatMap((r) => r[key].map((f) => f.label)))]
    return labels.map((label) => ({ ...records.flatMap((r) => r[key]).find((f) => f.label === label)!,
      ms: records.reduce((sum, r) => sum + (r[key].find((f) => f.label === label)?.ms ?? 0), 0) / records.length }))
      .sort((a, b) => b.ms - a.ms)
  }
  groups.push({ action, pilot, wallSamplesMs: records.map((r) => r.window.wallMs), wallMedianMs: median(records.map((r) => r.window.wallMs)),
    exclusiveSampledMedianMs: medians((r) => r.exclusiveSampledMs), timelineMedianMs: medians((r) => r.timelineMs),
    mobxDerivationWithinReactRenderMedianMs: median(records.map((r) => r.mobxDerivationWithinReactRenderMs)),
    mobxReactionInclusiveMedianMs: median(records.map((r) => r.mobxReactionInclusiveMs)),
    tasks: records.map((r) => r.tasks), commitCounts: records.map((r) => r.commits.count),
    renderedInstanceCounts: records.map((r) => r.commits.renderedInstances),
    observerMs: records.map((r) => r.commits.observerMs),
    components: medians((r) => r.commits.components), self: top('self'), inclusive: top('inclusive'),
  })
}
await writeFile(resolve(directory, 'analysis.json'), JSON.stringify({
  sourceSha: manifest.sourceSha,
  generatedAssetsWithoutOriginalMap: maps.generatedAssets,
  definitions: {
    wall: 'trusted pointerdown (background feed delivery) through end of first main-thread Paint after expected DOM change',
    sampled: 'reconstructed 1ms V8 sample intervals clipped to the wall window; each interval counted once',
    self: `arithmetic mean of ${manifest.repetitions} samples per action/arm; leaf-only time by source function declaration`,
    inclusive: `arithmetic mean of ${manifest.repetitions} samples per action/arm; all descendant samples per function, recursive occurrences deduplicated within one stack; overlapping, never additive`,
    react: 'committed PerformedWork composite instances, excluding hosts/providers/bailouts; render restarts excluded from counts and included in CPU',
    timeline: 'union of clipped main-thread complete events per name; layoutPaintUnion merges style/layout/prepaint/paint; timeline overlaps stack samples',
    longTasks: 'ThreadControllerImpl::RunTask (legacy trace: RunTask) window intersection >50ms; fullMs additionally preserves the original task duration',
    observer: 'wall time spent in the measurement-only commit-hook tree walk',
    medians: `per-column medians of ${manifest.repetitions} recordings; independently computed medians need not add to the wall median`,
  }, groups, records: summaries,
}, null, 2) + '\n')
console.log(`${summaries.length} CPU/trace windows and committed component lists analyzed at ${manifest.sourceSha}; ${resolve(directory, 'analysis.json')}`)
