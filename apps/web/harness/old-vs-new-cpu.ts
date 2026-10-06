/** OLD/NEW offline sampled CPU attribution; maps from the full-screen profiler.
 * bun apps/web/harness/old-vs-new-cpu.ts --run=.../run.json --build-dir=apps/web/dist
 * All durations are clipped to input → qualifying Paint end. */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import ts from '../node_modules/typescript/lib/typescript.js'

type Frame = { functionName: string; url: string; lineNumber: number; columnNumber: number }
type Cpu = {
  startTime: number; endTime: number
  nodes: { id: number; callFrame: Frame; children?: number[]; hitCount?: number; positionTicks?: unknown[] }[]
  samples: number[]; timeDeltas: number[]
}
type Event = { name: string; ph: string; ts: number; dur?: number; tts?: number; tdur?: number; pid: number; tid: number; args?: { data?: { type?: string; callTime?: number } } }
type Location = { file: string; line: number; column: number; name: string; mappedLine: number }
type Segment = { column: number; source: number; line: number; originalColumn: number }
type SourceMap = { sources: string[]; sourcesContent: (string | null)[]; mappings: string }
type Source = { ast: ts.SourceFile; functions: { start: number; entryStart: number; end: number; name: string; line: number }[] }
const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const root = resolve('.artifacts/old-vs-new')
const directory = resolve(root, 'profiles', arg('profile', 'all'))
const buildDirectory = resolve(arg('build-dir', resolve(root, 'build')))
const boundariesOnly = process.argv.includes('--boundaries-only')
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

const maps = new Maps()
async function analyze(runFile: string) {
const run = await read<{actions: {profiled: boolean; cpu: string | null; action: string; trace: string; mainThreadCpuMs: number | null}[]}>(runFile)
const summaries = []
const boundaries: Record<string, {mainThreadCpuMs: number; layoutCpuMs: number; cpuBoundary: string}> = {}
for(const action of run.actions) {
  if(action.mainThreadCpuMs!==null)continue
  const events: Event[]=JSON.parse(gunzipSync(await readFile(resolve(runFile,'..',action.trace))).toString())
  const input=events.find(event=>event.name==='comparison:input')!,dom=events.find(event=>event.name==='comparison:dom')!
  const frame=events.filter(event=>['DrawFrame','FramePresented'].includes(event.name) && event.pid===input.pid && event.ts>=dom.ts).sort((a,b)=>a.ts-b.ts)[0]
  if(!frame || input.tts===undefined)continue
  const endWall=frame.ts+(frame.dur??0)
  const completed=events.filter(event=>event.ph==='X' && event.pid===input.pid && event.tid===input.tid && event.tts!==undefined && event.tdur!==undefined && event.ts+(event.dur??0)<=endWall && event.tts+event.tdur>=input.tts!)
  if(!completed.length)continue
  const endCpu=Math.max(...completed.map(event=>event.tts!+event.tdur!))
  const layout=completed.filter(event=>['Layout','UpdateLayoutTree'].includes(event.name)).map(event=>[Math.max(input.tts!,event.tts!),Math.min(endCpu,event.tts!+event.tdur!)] as [number,number])
  boundaries[action.trace]={mainThreadCpuMs:(endCpu-input.tts)/1000,layoutCpuMs:union(layout),cpuBoundary:'last completed main-thread event before compositor frame (lower bound)'}
}
await writeFile(resolve(runFile,'..','cpu-boundaries.json'),JSON.stringify({method:'For composited transitions without a raster Paint, thread clock from input handler to last completed main-thread event before qualifying DrawFrame. A conservative lower bound if a task overlaps the frame; no wall time is relabelled CPU.',actions:boundaries},null,2)+'\n')
if (boundariesOnly) {
  console.log(`Recovered ${Object.keys(boundaries).length} compositor CPU lower bounds`)
  return
}
for (const action of run.actions) {
  if (!action.profiled || !action.cpu) continue
  const profile = await read<Cpu>(resolve(runFile, '..', action.cpu))
  for (const node of profile.nodes) if (node.callFrame.url.endsWith('.js')) await maps.prepare(node.callFrame.url)
  const nodes = new Map(profile.nodes.map(n => [n.id, n]))
  const parents = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)
  const locations = new Map(profile.nodes.map(node => [node.id, maps.locate(node.callFrame)]))
  const classifications = new Map<number, { kind: string; storeDerive: boolean; unmapped: boolean }>()
  const classify = (sample: number) => {
    const cached = classifications.get(sample)
    if (cached) return cached
    const chain: {frame: Frame; source: Location | null}[] = []
    let id: number | undefined = sample
    while (id !== undefined) {
      const node = nodes.get(id)!
      chain.push({frame: node.callFrame, source: locations.get(id) ?? null})
      id = parents.get(id)
    }
    const classification = {
      kind: bucket(chain),
      storeDerive: chain.some(({source}) => source && /packages\/client-core\/(?:src\/)?(engine|viewmodels|replica|store)|packages\/client-graph\/|tests\/worklist\/shared\/src\/|apps\/(?:web|mobile)\/src\/.*store/.test(source.file)),
      unmapped: chain.some(({frame, source}) => frame.url.endsWith('.js') && !source),
    }
    classifications.set(sample, classification)
    return classification
  }
  const buckets: Record<string, number> = {}
  const events: Event[] = JSON.parse(gunzipSync(await readFile(resolve(runFile, '..', action.trace))).toString())
  const input = events.find(e => e.name === (action.action.startsWith('app-')?'comparison:navigation-start':'comparison:input'))!
  const dom = events.find(e => e.name === (action.action.startsWith('app-')?'comparison:startup-dom':'comparison:dom'))!
  const paint = events.filter(e => e.name === 'Paint' && e.ph === 'X' && e.pid === input.pid && e.ts >= dom.ts).sort((a,b) => a.ts-b.ts)[0] ?? events.filter(e=>['DrawFrame','FramePresented'].includes(e.name) && e.pid===input.pid && e.ts>=dom.ts).sort((a,b)=>a.ts-b.ts)[0]
  if(!paint){summaries.push({action:action.action,cpu:action.cpu,unavailable:'No frame boundary for source attribution'});continue}
  const end = paint.ts + (paint.dur ?? 0)
  // The latency mark is backdated to the trusted event time. Its thread clock
  // is sampled when the recorder actually runs; align stack attribution with
  // that execution time so queued work is not allocated to handler CPU.
  const profileStart = input.args?.data?.callTime ?? input.ts
  let cursor = profile.startTime
  let sampledMs = 0, storeDeriveInclusiveMs = 0, unmappedMs = 0
  for (let index = 0; index < profile.samples.length; index++) {
    const next = cursor + profile.timeDeltas[index]!
    const ms = Math.max(0, Math.min(next, end) - Math.max(cursor, profileStart)) / 1000
    cursor = next
    if (ms === 0) continue
    const {kind, storeDerive, unmapped} = classify(profile.samples[index]!)
    add(buckets, kind, ms); sampledMs += ms
    if (storeDerive) storeDeriveInclusiveMs += ms
    if (unmapped) unmappedMs += ms
  }
  const activeSampledMs=sampledMs-(buckets.idle??0)
  const hardwareCpuMs=action.mainThreadCpuMs??boundaries[action.trace]?.mainThreadCpuMs??null
  const cpuPerWall=hardwareCpuMs!==null && activeSampledMs>0?hardwareCpuMs/activeSampledMs:null
  const cpuEstimates=Object.fromEntries(Object.entries(buckets).filter(([name])=>name!=='idle').map(([name,ms])=>[name,cpuPerWall===null?null:ms*cpuPerWall]))
  summaries.push({action:action.action,cpu:action.cpu,mainThreadCpuMs:hardwareCpuMs,cpuBoundary:boundaries[action.trace]?.cpuBoundary??'Paint end',profileStartBasis:input.args?.data?.callTime!==undefined?'performance mark callTime, aligned with thread-clock start':'recorded mark timestamp fallback',inputQueueMs:(profileStart-input.ts)/1000,sampledMs,buckets,storeDeriveInclusiveMs,unmappedMs,storeDeriveCpuEstimateMs:cpuPerWall===null?null:storeDeriveInclusiveMs*cpuPerWall,cpuEstimates})
}
await writeFile(resolve(runFile, '..', 'cpu-attribution.json'), JSON.stringify({method:'V8 sampled stack wall time at 100 microsecond requested interval; inclusive store/derive overlaps React categories, never add them. Profiles are clipped from the performance-mark callTime (actual recorder execution, matching thread-clock start) through qualifying Paint, excluding queued work before the handler. A timestamp fallback is explicitly labelled if callTime is absent. Sampled time is approximate wall-time attribution, not hardware CPU. CPU estimates multiply measured thread CPU by each category’s non-idle sampled wall-time share; OS descheduling and sampling bias limit these estimates. Idle/program/unmapped samples remain explicit.',summaries},null,2)+'\n')
console.log(`Attributed ${summaries.length} action profiles`)

}
if(process.argv.includes('--all')) {
  const surface=arg('surface','web'),head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
  const sha=arg('source-sha',head)
  if(sha!==head) {
    // A later checkout can analyze preserved older builds without rebuilding
    // them or disturbing a pinned timing arm. The maps contain their source.
    const manifest=await read<{sha:string}>(resolve(buildDirectory,'..','manifest.json'))
    if(manifest.sha!==sha)throw Error('Preserved build manifest does not match requested source SHA')
  }
  let analyzed=0
  for(const entry of await readdir(root,{withFileTypes:true})) {
    if(!entry.isDirectory() || !entry.name.startsWith('timing-'))continue
    const path=resolve(root,entry.name,'run.json')
    const run=await read<{mode:string;purpose:string;status:string;surface:string;sha:string;actionPhaseComplete?:boolean}>(path)
    if(run.mode!=='timing' || run.purpose!=='measurement' || (run.status!=='complete' && !run.actionPhaseComplete) || run.surface!==surface || run.sha!==sha)continue
    await analyze(path);analyzed++
  }
  if(!analyzed)throw Error('No completed measurement captures for requested source and surface')
  console.log(`Analyzed ${analyzed} runs ${boundariesOnly ? 'for hardware-clock compositor boundaries only' : 'with reused matching source maps'}`)
} else await analyze(resolve(arg('run','run.json')))
