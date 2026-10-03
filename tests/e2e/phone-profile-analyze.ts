/** POD-5391 offline attribution of the phone warm-start traces. Never runs the
 * product. bun tests/e2e/phone-profile-analyze.ts [--dir=.artifacts/POD-5391]
 * [--dist=apps/mobile/dist] [--prefix=warm-]
 *
 * Window: the session document's navigationStart → `phone:settled` mark, on the
 * renderer main thread that loaded it. V8 samples come from the trace's
 * ProfileChunk events; each sample is charged its interval to the next sample,
 * clipped to the window. Frames are source-mapped through the export's
 * external maps. "Self" = leaf only; "inclusive" counts a frame/file once per
 * sample. Numbers are sampled-time estimates, not call counts. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const directory = resolve(arg('dir', '.artifacts/POD-5391'))
const dist = resolve(arg('dist', 'apps/mobile/dist'))
const prefix = arg('prefix', 'warm-')
const repo = resolve(import.meta.dirname, '../..')

interface Event {
  name: string
  cat: string
  ph: string
  ts: number
  dur?: number
  pid: number
  tid: number
  id?: string
  args?: { data?: Record<string, unknown>; name?: string }
}
interface CallFrame {
  functionName: string
  url: string
  lineNumber: number
  columnNumber: number
}
interface Node {
  id: number
  parent?: number
  callFrame: CallFrame
}

// ---- source maps -----------------------------------------------------------
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const digits = new Int8Array(128).fill(-1)
for (let index = 0; index < alphabet.length; index++) digits[alphabet.charCodeAt(index)] = index
type Segment = [column: number, source: number, line: number, originalColumn: number]
interface Map {
  sources: string[]
  content: (string[] | null)[]
  lines: Segment[][]
}
const maps = new globalThis.Map<string, Map | null>()
function decode(raw: { sources: string[]; sourcesContent?: (string | null)[]; mappings: string }) {
  const lines: Segment[][] = []
  let source = 0,
    line = 0,
    originalColumn = 0
  for (const text of raw.mappings.split(';')) {
    const segments: Segment[] = []
    let column = 0
    for (const part of text.split(',')) {
      if (!part) continue
      const values: number[] = []
      let value = 0,
        shift = 0
      for (let index = 0; index < part.length; index++) {
        const digit = digits[part.charCodeAt(index)]!
        value += (digit & 31) << shift
        if (digit & 32) shift += 5
        else {
          values.push(value & 1 ? -(value >> 1) : value >> 1)
          value = shift = 0
        }
      }
      column += values[0]!
      if (values.length >= 4) {
        source += values[1]!
        line += values[2]!
        originalColumn += values[3]!
        segments.push([column, source, line, originalColumn])
      }
    }
    lines.push(segments)
  }
  return {
    sources: raw.sources,
    content: raw.sources.map((_, index) => raw.sourcesContent?.[index]?.split('\n') ?? null),
    lines,
  }
}
function mapFor(url: string): Map | null {
  if (maps.has(url)) return maps.get(url)!
  let result: Map | null = null
  try {
    const path = new URL(url).pathname.replace(/^\/mobile/, '')
    const file = resolve(dist, `.${path}.map`)
    if (existsSync(file)) result = decode(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    result = null
  }
  maps.set(url, result)
  return result
}
function sourceName(path: string) {
  path = path.replaceAll('\\', '/')
  const dependency = path.lastIndexOf('/node_modules/')
  if (dependency >= 0) return path.slice(dependency + 1)
  for (const marker of ['apps/', 'packages/']) {
    const index = path.indexOf(marker)
    if (index >= 0) return path.slice(index)
  }
  return path
}
const snippets = new globalThis.Map<string, string[] | null>()
function sourceLine(map: Map, source: number, line: number) {
  let text = map.content[source]
  if (!text) {
    const name = map.sources[source]!
    if (!snippets.has(name)) {
      const candidates = [name, resolve(repo, sourceName(name)), resolve(repo, 'apps/mobile', name)]
      const found = candidates.find((candidate) => existsSync(candidate))
      snippets.set(name, found ? readFileSync(found, 'utf8').split('\n') : null)
    }
    text = snippets.get(name) ?? null
  }
  return text?.[line]?.trim().slice(0, 90) ?? ''
}
interface Located {
  file: string
  fn: string
}
const located = new globalThis.Map<string, Located>()
function locate(frame: CallFrame): Located {
  const key = `${frame.url}:${frame.lineNumber}:${frame.columnNumber}:${frame.functionName}`
  const cached = located.get(key)
  if (cached) return cached
  let result: Located
  if (!frame.url) {
    const name = frame.functionName || '(anonymous native)'
    result = { file: name.startsWith('(') ? name : '(native)', fn: name }
  } else {
    const map = mapFor(frame.url)
    const segments = map?.lines[frame.lineNumber]
    let found: Segment | undefined
    if (segments) {
      let low = 0,
        high = segments.length - 1
      while (low <= high) {
        const middle = (low + high) >> 1
        if (segments[middle]![0] <= frame.columnNumber) {
          found = segments[middle]
          low = middle + 1
        } else high = middle - 1
      }
    }
    if (map && found) {
      const file = sourceName(map.sources[found[1]]!)
      result = {
        file,
        fn: `${file}:${found[2] + 1} ${frame.functionName || '(anonymous)'} — ${sourceLine(map, found[1], found[2])}`,
      }
    } else {
      const file = new URL(frame.url).pathname
      result = { file, fn: `${file}:${frame.lineNumber + 1}:${frame.columnNumber} ${frame.functionName}` }
    }
  }
  located.set(key, result)
  return result
}

// ---- trace -----------------------------------------------------------------
interface Analysis {
  file: string
  pool: boolean
  windowMs: number
  busyMs: number
  settledMs: number
  domMs: number
  sampledMs: number
  selfByFile: Record<string, number>
  inclusiveByFile: Record<string, number>
  selfByFn: Record<string, number>
  inclusiveByFn: Record<string, number>
  tasks: { count: number; totalMs: number; longest: number; long: { startMs: number; ms: number; top: [string, number][] }[] }
}

function analyze(name: string): Analysis {
  const events = (JSON.parse(gunzipSync(readFileSync(resolve(directory, name))).toString()) as { traceEvents: Event[] }).traceEvents
  const window = arg('window', 'navigation')
  let start: Event, settled: Event, dom: Event, from: number, to: number, busyEnd: number
  const isTask = (e: Event) =>
    (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') && e.ph === 'X' && e.pid === start.pid && e.tid === start.tid
  if (window === 'navigation') {
    const starts = events.filter(
      (e) =>
        e.name === 'navigationStart' &&
        String(e.args?.data?.documentLoaderURL ?? '').includes('/mobile/session/'),
    )
    if (starts.length !== 1) throw new Error(`${name}: expected one session navigationStart, saw ${starts.length}`)
    start = starts[0]!
    const settledMark = events.find((e) => e.name === 'phone:settled' && e.pid === start.pid)
    const domMark = events.find((e) => e.name === 'phone:dom' && e.pid === start.pid)
    if (!settledMark || !domMark) throw new Error(`${name}: missing phone:settled/phone:dom marks`)
    settled = settledMark
    dom = domMark
    from = start.ts
    // Busy end: settled, or the end of the last >50 ms main-thread task up to
    // 5 s later (work the screen did not wait for still blocks the next input).
    busyEnd = events
      .filter((e) => isTask(e) && (e.dur ?? 0) > 50_000 && e.ts + (e.dur ?? 0) <= settled.ts + 5_000_000)
      .reduce((latest, e) => Math.max(latest, e.ts + (e.dur ?? 0)), settled.ts)
    // Attribute everything up to 3 s after settling: pool work the screen did not
    // wait for still runs on the same main thread. Idle is reported separately.
    to = Math.max(busyEnd, settled.ts + Number(arg('after-ms', '3000')) * 1000)
  } else {
    // marks,<start>,<end>[,paint] — user-timing marks on the page's main thread;
    // `paint` extends the end to the first main-renderer Paint after <end>.
    const [, startName, endName, paint] = window.split(',')
    const startMark = events.filter((e) => e.name === startName)
    const endMark = events.filter((e) => e.name === endName)
    if (startMark.length !== 1 || endMark.length !== 1) throw new Error(`${name}: expected one ${startName} and one ${endName}`)
    start = startMark[0]!
    dom = endMark[0]!
    const painted = paint
      ? events
          .filter((e) => e.name === 'Paint' && e.ph === 'X' && e.pid === start.pid && e.ts >= dom.ts)
          .sort((a, b) => a.ts - b.ts)[0]
      : undefined
    if (paint && !painted) throw new Error(`${name}: no Paint after ${endName}`)
    settled = painted ? { ...painted, ts: painted.ts + (painted.dur ?? 0) } : dom
    from = start.ts
    busyEnd = settled.ts
    to = settled.ts
  }
  const profiles = events.filter((e) => e.name === 'Profile' && e.pid === start.pid && e.tid === start.tid)
  if (profiles.length === 0) throw new Error(`${name}: no V8 profile on the page main thread`)
  const nodes = new globalThis.Map<number, Node>()
  const times: number[] = [],
    ids: number[] = []
  for (const profile of profiles) {
    let time = Number(profile.args?.data?.startTime)
    for (const chunk of events.filter((e) => e.name === 'ProfileChunk' && e.pid === profile.pid && e.id === profile.id)) {
      const data = chunk.args?.data as { cpuProfile?: { nodes?: Node[]; samples?: number[] }; timeDeltas?: number[] }
      for (const node of data.cpuProfile?.nodes ?? []) nodes.set(node.id, node)
      const samples = data.cpuProfile?.samples ?? [],
        deltas = data.timeDeltas ?? []
      for (let index = 0; index < samples.length; index++) {
        time += deltas[index] ?? 0
        times.push(time)
        ids.push(samples[index]!)
      }
    }
  }
  const order = times.map((_, index) => index).sort((a, b) => times[a]! - times[b]!)
  const stacks = new globalThis.Map<number, Located[]>()
  const stackOf = (id: number) => {
    let stack = stacks.get(id)
    if (stack) return stack
    stack = []
    for (let node = nodes.get(id); node; node = node.parent === undefined ? undefined : nodes.get(node.parent)) {
      if (node.callFrame.functionName === '(root)') continue
      stack.push(locate(node.callFrame))
    }
    stacks.set(id, stack)
    return stack
  }
  const add = (record: Record<string, number>, key: string, value: number) => {
    record[key] = (record[key] ?? 0) + value
  }
  const result: Analysis = {
    file: name,
    pool: name.includes('-on-'),
    windowMs: (to - from) / 1000,
    busyMs: (busyEnd - from) / 1000,
    settledMs: (settled.ts - from) / 1000,
    domMs: (dom.ts - from) / 1000,
    sampledMs: 0,
    selfByFile: {},
    inclusiveByFile: {},
    selfByFn: {},
    inclusiveByFn: {},
    tasks: { count: 0, totalMs: 0, longest: 0, long: [] },
  }
  const tasks = events
    .filter((e) => (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') && e.ph === 'X' && e.pid === start.pid && e.tid === start.tid)
    .map((e) => ({ from: Math.max(e.ts, from), to: Math.min(e.ts + (e.dur ?? 0), to) }))
    .filter((t) => t.to > t.from)
  const perTask = tasks.map(() => ({} as Record<string, number>))
  for (let position = 0; position < order.length; position++) {
    const index = order[position]!
    const at = times[index]!,
      next = position + 1 < order.length ? times[order[position + 1]!]! : at
    const lo = Math.max(at, from),
      hi = Math.min(next, to)
    if (hi <= lo) continue
    const ms = (hi - lo) / 1000
    const stack = stackOf(ids[index]!)
    result.sampledMs += ms
    const leaf = stack[0] ?? { file: '(empty)', fn: '(empty)' }
    add(result.selfByFile, leaf.file, ms)
    add(result.selfByFn, leaf.fn, ms)
    const seenFile = new Set<string>(),
      seenFn = new Set<string>()
    for (const frame of stack) {
      if (!seenFile.has(frame.file)) {
        seenFile.add(frame.file)
        add(result.inclusiveByFile, frame.file, ms)
      }
      if (!seenFn.has(frame.fn)) {
        seenFn.add(frame.fn)
        add(result.inclusiveByFn, frame.fn, ms)
      }
    }
    const task = tasks.findIndex((t) => lo >= t.from && lo < t.to)
    if (task >= 0) {
      // Outermost app (non-dependency) frame below the event loop names the task.
      const app = [...stack].reverse().find((frame) => frame.file.startsWith('packages/') || frame.file.startsWith('apps/'))
      add(perTask[task]!, app?.fn ?? leaf.fn, ms)
    }
  }
  result.tasks.count = tasks.length
  result.tasks.totalMs = tasks.reduce((sum, t) => sum + (t.to - t.from) / 1000, 0)
  for (const [index, task] of tasks.entries()) {
    const ms = (task.to - task.from) / 1000
    result.tasks.longest = Math.max(result.tasks.longest, ms)
    if (ms > 50)
      result.tasks.long.push({
        startMs: (task.from - from) / 1000,
        ms,
        top: Object.entries(perTask[index]!).sort((a, b) => b[1] - a[1]).slice(0, 4),
      })
  }
  return result
}

// ---- report ----------------------------------------------------------------
const files = readdirSync(directory).filter((file) => file.startsWith(prefix) && file.endsWith('.trace.json.gz')).sort()
if (files.length === 0) throw new Error(`No ${prefix}*.trace.json.gz in ${directory}`)
const analyses = files.map(analyze)
const mean = (pool: boolean, pick: (a: Analysis) => Record<string, number>) => {
  const arm = analyses.filter((a) => a.pool === pool)
  const out: Record<string, number> = {}
  for (const a of arm) for (const [key, value] of Object.entries(pick(a))) out[key] = (out[key] ?? 0) + value / arm.length
  return out
}
const fmt = (n: number) => n.toFixed(1)
const lines: string[] = []
const table = (heading: string, pick: (a: Analysis) => Record<string, number>, limit = 25) => {
  const off = mean(false, pick),
    on = mean(true, pick)
  const keys = [...new Set([...Object.keys(off), ...Object.keys(on)])]
  lines.push(`\n## ${heading}\n`, '| ON−OFF ms | OFF ms | ON ms | Frame |', '| ---: | ---: | ---: | --- |')
  for (const key of keys.sort((a, b) => (on[b] ?? 0) - (off[b] ?? 0) - ((on[a] ?? 0) - (off[a] ?? 0))).slice(0, limit))
    lines.push(`| ${fmt((on[key] ?? 0) - (off[key] ?? 0))} | ${fmt(off[key] ?? 0)} | ${fmt(on[key] ?? 0)} | ${key.replaceAll('|', '\\|')} |`)
  lines.push('', `Top ON by absolute ms:`, '')
  for (const [key, value] of Object.entries(on).sort((a, b) => b[1] - a[1]).slice(0, 15))
    lines.push(`- ${fmt(value)} ms (OFF ${fmt(off[key] ?? 0)}) ${key}`)
}
lines.push(`# Phone ${prefix.replace(/-$/, '')} trace attribution`, '', arg('window', 'navigation') === 'navigation' ? 'Window = session navigationStart → settled + 3 s (or the busy end if later). Busy end = end of the last >50 ms main-thread task within 5 s after settled.' : `Window = ${arg('window', '')} (start mark → end mark, or the first main-renderer Paint end after it).`, '', '| Trace | Pool | Window ms | Settled ms | Busy end ms | DOM ms | Sampled ms | Tasks | Task ms | Longest task ms |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
for (const a of analyses)
  lines.push(`| ${a.file} | ${a.pool ? 'ON' : 'OFF'} | ${fmt(a.windowMs)} | ${fmt(a.settledMs)} | ${fmt(a.busyMs)} | ${fmt(a.domMs)} | ${fmt(a.sampledMs)} | ${a.tasks.count} | ${fmt(a.tasks.totalMs)} | ${fmt(a.tasks.longest)} |`)
table('Inclusive by source file (mean per arm)', (a) => a.inclusiveByFile, 30)
table('Self by source file (mean per arm)', (a) => a.selfByFile, 25)
table('Inclusive by function (mean per arm)', (a) => a.inclusiveByFn, 40)
table('Self by function (mean per arm)', (a) => a.selfByFn, 30)
lines.push('\n## Long tasks (>50 ms) and their dominant app frames\n')
for (const a of analyses) {
  lines.push(`### ${a.file}`)
  for (const task of a.tasks.long)
    lines.push(`- at ${fmt(task.startMs)} ms, ${fmt(task.ms)} ms: ${task.top.map(([fn, ms]) => `${fmt(ms)} ${fn}`).join(' · ')}`)
}
writeFileSync(resolve(directory, `${prefix}analysis.md`), `${lines.join('\n')}\n`)
writeFileSync(resolve(directory, `${prefix}analysis.json`), `${JSON.stringify(analyses, null, 1)}\n`)
console.log(lines.slice(0, 20).join('\n'))
