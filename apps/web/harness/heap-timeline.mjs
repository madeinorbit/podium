/**
 * POD-7115 — where a cold start's heap goes, over time and by allocating code.
 *
 * `cold-start.mjs --mode=memory --heap-timeline` arms this before the cold
 * navigation. Until `stop()` it records, every 250 ms, the page's V8 heap
 * (`Runtime.getHeapUsage`, which waits for the main thread) and every
 * renderer's resident set and peak from /proc (which does not). Named marks
 * give the collector's phases. A V8 sampling heap profile that keeps objects
 * later collected by either GC (so garbage counts too) is cut at every mark,
 * one profile per phase. The requests to the sync routes and the page's
 * console messages are kept with their times, to show a reload or a retry.
 *
 * `summarize()` folds each profile by allocating frame (self) and by frame on
 * the stack (total), with the production bundle's frames resolved through its
 * hidden source maps (`apps/<app>/dist/assets/*.js.map`).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const pause = (ms) => new Promise((done) => setTimeout(done, ms))

export async function startHeapTimeline({ cdp, page, context, rendererMemory }) {
  const t0 = Date.now()
  const at = () => Date.now() - t0
  const samples = [],
    marks = [],
    requests = [],
    consoles = [],
    profiles = []
  context.on('request', (request) => {
    const url = new URL(request.url())
    if (/sync|collection|trpc/.test(url.pathname))
      requests.push({
        ms: at(),
        method: request.method(),
        path: (url.pathname + url.search).slice(0, 240),
      })
  })
  page.on('console', (message) => {
    if (consoles.length < 4000)
      consoles.push({ ms: at(), type: message.type(), text: message.text().slice(0, 400) })
  })
  const sampling = {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  }
  await cdp.send('HeapProfiler.enable')
  await cdp.send('HeapProfiler.startSampling', sampling)
  let phase = 'navigation',
    phaseStart = 0,
    stopped = false
  const loop = (async () => {
    while (!stopped) {
      const ms = at(),
        renderers = rendererMemory()
      let heap = null
      try {
        heap = await Promise.race([cdp.send('Runtime.getHeapUsage'), pause(2000).then(() => null)])
      } catch {}
      samples.push({
        ms,
        heapMs: at(),
        phase,
        heapUsed: heap?.usedSize ?? null,
        heapTotal: heap?.totalSize ?? null,
        renderers: renderers.map((x) => ({ pid: x.pid, rssKiB: x.rssKiB, hwmKiB: x.hwmKiB })),
      })
      await pause(250)
    }
  })()
  const cut = async (next) => {
    const { profile } = await cdp.send('HeapProfiler.stopSampling')
    profiles.push({ phase, fromMs: phaseStart, toMs: at(), profile })
    marks.push({ name: next, ms: at() })
    phase = next
    phaseStart = at()
    if (next !== 'stopped') await cdp.send('HeapProfiler.startSampling', sampling)
  }
  return {
    mark: cut,
    async stop() {
      await cut('stopped')
      stopped = true
      await loop
      return { t0: new Date(t0).toISOString(), samples, marks, requests, consoles, profiles }
    },
  }
}

// ─── Source maps (hidden maps beside the bundle; no dependency) ─────────────

const B64 = new Map(
  [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].map((c, i) => [c, i]),
)
function decodeMappings(mappings) {
  const lines = []
  let source = 0,
    line = 0,
    column = 0,
    name = 0
  for (const text of mappings.split(';')) {
    const segments = []
    let generated = 0
    for (const segment of text.split(',')) {
      if (!segment) continue
      const values = []
      let value = 0,
        shift = 0
      for (const char of segment) {
        const digit = B64.get(char)
        value += (digit & 31) << shift
        if (digit & 32) shift += 5
        else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1)
          value = 0
          shift = 0
        }
      }
      generated += values[0]
      if (values.length >= 4) {
        source += values[1]
        line += values[2]
        column += values[3]
        if (values.length >= 5) name += values[4]
        segments.push([generated, source, line, column, values.length >= 5 ? name : -1])
      }
    }
    lines.push(segments)
  }
  return lines
}

function mapper(distDirs) {
  const maps = new Map()
  const load = (file) => {
    if (maps.has(file)) return maps.get(file)
    let map = null
    for (const dir of distDirs) {
      const path = resolve(dir, 'assets', `${file}.map`)
      if (!existsSync(path)) continue
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      map = { sources: raw.sources, names: raw.names, lines: decodeMappings(raw.mappings) }
      break
    }
    maps.set(file, map)
    return map
  }
  return (frame) => {
    const file = frame.url.split('/').pop()?.split('?')[0]
    if (!file?.endsWith('.js')) return null
    const map = load(file)
    const segments = map?.lines[frame.lineNumber]
    if (!segments?.length) return null
    let lo = 0,
      hi = segments.length - 1,
      best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (segments[mid][0] <= frame.columnNumber) {
        best = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    if (best < 0) return null
    const [, source, line, column] = segments[best]
    const path = (map.sources[source] ?? '?').replace(/^(\.\.\/)+/, '')
    return `${path}:${line + 1}:${column + 1}`
  }
}

/** Per profile: bytes allocated (garbage included), by self frame and by frame on the stack. */
export function summarize(timeline, distDirs, top = 40) {
  const where = mapper(distDirs)
  const label = (frame) => {
    const mapped = where(frame)
    const name = frame.functionName || '(anonymous)'
    if (mapped) return `${name} ${mapped}`
    if (!frame.url) return name
    return `${name} ${frame.url.split('/').pop()}:${frame.lineNumber + 1}`
  }
  return timeline.profiles.map(({ phase, fromMs, toMs, profile }) => {
    const self = new Map(),
      total = new Map(),
      stacks = new Map()
    let bytes = 0
    const walk = (node, path) => {
      const key = label(node.callFrame)
      const here = [...path, key]
      let sum = node.selfSize
      for (const child of node.children ?? []) sum += walk(child, here)
      if (node.selfSize > 0) {
        self.set(key, (self.get(key) ?? 0) + node.selfSize)
        const stack = here.slice(-14).reverse().join('\n  <- ')
        stacks.set(stack, (stacks.get(stack) ?? 0) + node.selfSize)
        bytes += node.selfSize
      }
      return sum
    }
    // Total: count a frame once per root-to-leaf path even if it recurses.
    const walkTotal = (node, seen) => {
      const key = label(node.callFrame)
      let sum = node.selfSize
      const next = new Set(seen)
      const fresh = !seen.has(key)
      next.add(key)
      for (const child of node.children ?? []) sum += walkTotal(child, next)
      if (fresh) total.set(key, (total.get(key) ?? 0) + sum)
      return sum
    }
    walk(profile.head, [])
    walkTotal(profile.head, new Set())
    const rank = (map, n) =>
      [...map]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([key, size]) => ({ mib: +(size / 1048576).toFixed(1), key }))
    return {
      phase,
      fromMs,
      toMs,
      allocatedMiB: +(bytes / 1048576).toFixed(1),
      self: rank(self, top),
      total: rank(total, top),
      stacks: rank(stacks, 12),
    }
  })
}

export function writeHeapTimeline(out, timeline, distDirs) {
  for (const { phase, profile } of timeline.profiles)
    writeFileSync(resolve(out, `heap-${phase}.heapprofile`), JSON.stringify(profile))
  const summary = summarize(timeline, distDirs)
  const peak = timeline.samples.reduce(
    (best, s) => ((s.heapUsed ?? 0) > (best?.heapUsed ?? 0) ? s : best),
    null,
  )
  const rssPeak = timeline.samples.reduce(
    (best, s) => {
      const rss = Math.max(0, ...s.renderers.map((r) => r.rssKiB))
      return rss > best.rssKiB ? { ms: s.ms, phase: s.phase, rssKiB: rss } : best
    },
    { rssKiB: 0 },
  )
  const { profiles: _, ...rest } = timeline
  writeFileSync(
    resolve(out, 'heap-timeline.json'),
    `${JSON.stringify({ ...rest, summary }, null, 1)}\n`,
  )
  const lines = [
    `# Heap timeline`,
    '',
    `Marks: ${timeline.marks.map((m) => `${m.name}@${m.ms}ms`).join(', ')}`,
    `Peak heap used ${((peak?.heapUsed ?? 0) / 1048576) | 0} MiB at ${peak?.ms} ms (${peak?.phase}); peak renderer RSS ${(rssPeak.rssKiB / 1024) | 0} MiB at ${rssPeak.ms} ms (${rssPeak.phase}).`,
    `Sync requests: ${timeline.requests
      .filter((r) => /sync|collection/.test(r.path))
      .map((r) => `${r.method} ${r.path}@${r.ms}`)
      .join('; ')}`,
    '',
  ]
  for (const s of timeline.samples)
    lines.push(
      `${String(s.ms).padStart(6)} ${s.phase.padEnd(12)} heap ${s.heapUsed === null ? '   -' : String((s.heapUsed / 1048576) | 0).padStart(5)} / ${s.heapTotal === null ? '   -' : String((s.heapTotal / 1048576) | 0).padStart(5)} MiB  rss ${s.renderers.map((r) => (r.rssKiB / 1024) | 0).join('/')} MiB`,
    )
  for (const p of summary) {
    lines.push(
      '',
      `## ${p.phase} (${p.fromMs}–${p.toMs} ms): ${p.allocatedMiB} MiB allocated`,
      '',
      'Self:',
    )
    for (const row of p.self.slice(0, 25))
      lines.push(`  ${String(row.mib).padStart(8)}  ${row.key}`)
    lines.push('', 'Total (on the stack):')
    for (const row of p.total.slice(0, 40))
      lines.push(`  ${String(row.mib).padStart(8)}  ${row.key}`)
    lines.push('', 'Top stacks:')
    for (const row of p.stacks.slice(0, 8)) lines.push(`  ${row.mib} MiB\n  ${row.key}`, '')
  }
  writeFileSync(resolve(out, 'heap-timeline.md'), `${lines.join('\n')}\n`)
  return {
    peakHeapUsed: peak?.heapUsed ?? null,
    peakHeapMs: peak?.ms ?? null,
    peakHeapPhase: peak?.phase ?? null,
    peakRendererRssKiB: rssPeak.rssKiB,
    peakRssMs: rssPeak.ms,
    peakRssPhase: rssPeak.phase,
    allocatedMiB: Object.fromEntries(summary.map((p) => [p.phase, p.allocatedMiB])),
  }
}
