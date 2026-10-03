/** Count real minified-production pool publications without a product hook.
 * Source maps locate Chromium conditional breakpoints; their conditions collect
 * data and return false, so execution never pauses. Not used by ordinary lanes. */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { CDPSession, Page } from '@playwright/test'

interface RawMap {
  sources: string[]
  sourcesContent?: (string | null)[]
  mappings: string
}
interface Point {
  name: 'poolBegin' | 'poolEnd' | 'kernel'
  file: string
  line: number
  column: number
  source: string
  originalLine: number
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const digits = new Int8Array(128).fill(-1)
for (let i = 0; i < alphabet.length; i++) digits[alphabet.charCodeAt(i)] = i

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.js.map') ? [path] : []
  })
}

function pointsIn(file: string, checkout: string): Point[] {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RawMap
  const targets = raw.sources.flatMap((source, index) => {
    const suffix = source
      .replaceAll('\\', '/')
      .match(
        /packages\/(client-graph\/src\/pool|client-core\/src\/replica\/kernel\/facade)\.ts$/,
      )?.[0]
    if (!suffix) return []
    const text = raw.sourcesContent?.[index] ?? readFileSync(resolve(checkout, suffix), 'utf8')
    const lines = text.split('\n')
    const find = (needle: string) => {
      const line = lines.findIndex((value) => value.includes(needle))
      if (line < 0) throw new Error(`Missing ${needle} in ${source}`)
      return { line, column: lines[line]!.indexOf(needle) }
    }
    if (suffix.endsWith('/pool.ts')) {
      const entry = find('apply(event: RowSourceEvent)')
      const first = entry.line + 1
      return [
        {
          index,
          name: 'poolBegin' as const,
          line: first,
          column: lines[first]!.indexOf('const out'),
        },
        { index, name: 'poolEnd' as const, ...find('for (const [entity, id] of out.removed)') },
      ]
    }
    const entry = find('onKernelEvent(event: ReplicaEvent): void {')
    return [
      {
        index,
        name: 'kernel' as const,
        line: entry.line + 1,
        column: lines[entry.line + 1]!.indexOf('switch'),
      },
    ]
  })
  if (targets.length === 0) return []
  const found = new Map<string, Point>()
  let source = 0,
    originalLine = 0,
    originalColumn = 0,
    generatedLine = 0
  for (const line of raw.mappings.split(';')) {
    let column = 0
    for (const segment of line.split(',')) {
      if (!segment) continue
      const values: number[] = []
      let value = 0,
        shift = 0
      for (const char of segment) {
        const digit = digits[char.charCodeAt(0)]!
        value += (digit & 31) << shift
        if (digit & 32) shift += 5
        else {
          values.push(value & 1 ? -(value >> 1) : value >> 1)
          value = shift = 0
        }
      }
      column += values[0]!
      if (values.length < 4) continue
      source += values[1]!
      originalLine += values[2]!
      originalColumn += values[3]!
      for (const target of targets) {
        if (
          target.index === source &&
          target.line === originalLine &&
          originalColumn >= target.column &&
          !found.has(target.name)
        )
          found.set(target.name, {
            name: target.name,
            file: file.slice(0, -4),
            line: generatedLine,
            column,
            source: raw.sources[source]!,
            originalLine,
          })
      }
    }
    generatedLine++
  }
  return [...found.values()]
}

export async function logpoints(cdp: CDPSession, dist: string, checkout: string, mobile: boolean) {
  const points = files(dist).flatMap((file) => pointsIn(file, checkout))
  for (const name of ['poolBegin', 'poolEnd', 'kernel'])
    if (!points.some((point) => point.name === name))
      throw new Error(`No ${name} production mapping in ${dist}`)
  await cdp.send('Debugger.enable')
  const resolved: unknown[] = []
  const pauses: unknown[] = []
  cdp.on('Debugger.breakpointResolved', (event) => resolved.push(event))
  cdp.on('Debugger.paused', (event) => {
    pauses.push({ reason: event.reason, data: event.data, location: event.callFrames[0]?.location })
    void cdp.send('Debugger.resume').catch(() => {})
  })
  for (const point of points) {
    const path = `${mobile ? '/mobile' : ''}/${relative(dist, point.file).replaceAll('\\', '/')}`
    const line = readFileSync(point.file, 'utf8').split('\n')[point.line]!
    const prefix = line.slice(Math.max(0, point.column - 400), point.column)
    const signature =
      point.name === 'kernel' ? /onKernelEvent\(([$\w]+)\)\{$/ : /apply\(([$\w]+)\)\{$/
    const parameter = point.name === 'poolEnd' ? undefined : prefix.match(signature)?.[1]
    if (point.name !== 'poolEnd' && !parameter)
      throw new Error(`No production parameter at ${point.name}: ${prefix.slice(-100)}`)
    const call =
      point.name === 'kernel'
        ? `kernel(${parameter})`
        : `${point.name}(this${point.name === 'poolBegin' ? `, ${parameter}` : ''})`
    await cdp.send('Debugger.setBreakpointByUrl', {
      urlRegex: `${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      lineNumber: point.line,
      columnNumber: point.column,
      condition: `(globalThis.__cacheProof?.${call}, false)`,
    })
  }
  return { points, resolved, pauses }
}

export interface Delivery {
  pool: number
  type: string
  sessions: number
  unread: number
  start: number
  end?: number
  duration?: number
  hash: string
}
export interface Capture {
  deliveries: Delivery[]
  live: number[]
  readyAt: number
  settledAt: number
  firstPaint: number
  final: { pool: number; sessions: number; unread: number; hash: string }[]
}

export async function installProbe(page: Page, mobile: boolean, title: string) {
  await page.addInitScript(
    ({ mobile, title }) => {
      const global = globalThis as unknown as Record<string, any>
      const pools = new WeakMap<object, number>()
      const rows = new Map<number, Map<string, unknown[]>>()
      const pending = new Map<number, Delivery>()
      const deliveries: Delivery[] = []
      const live: number[] = []
      const digest = (states: Map<string, unknown[]>) => {
        let hash = 2166136261
        for (const char of JSON.stringify([...states].sort(([a], [b]) => a.localeCompare(b))))
          hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
        return (hash >>> 0).toString(16)
      }
      const proof = {
        readyAt: 0,
        settledAt: 0,
        poolBegin(
          pool: object,
          event: {
            type: string
            rows: { kind: string; id: string; value?: Record<string, unknown> }[]
          },
        ) {
          let id = pools.get(pool)
          if (id === undefined) {
            id = rows.size + 1
            pools.set(pool, id)
            rows.set(id, new Map())
          }
          const states = rows.get(id)!
          if (event.type === 'replace') states.clear()
          let sessions = 0,
            unread = 0
          for (const row of event.rows) {
            if (row.kind !== 'session' || !row.id.startsWith('phone-summary-session-')) continue
            sessions++
            if (row.value === undefined) states.delete(row.id)
            else {
              unread += Number(row.value.unread === true)
              states.set(row.id, [
                row.value.unread,
                row.value.readAt,
                row.value.snoozedUntil ?? null,
              ])
            }
          }
          const delivery: Delivery = {
            pool: id,
            type: event.type,
            sessions,
            unread,
            hash: digest(states),
            start: performance.now(),
          }
          deliveries.push(delivery)
          pending.set(id, delivery)
        },
        poolEnd(pool: object) {
          const id = pools.get(pool)
          const delivery = id === undefined ? undefined : pending.get(id)
          if (!delivery || delivery.end !== undefined) return
          delivery.end = performance.now()
          delivery.duration = delivery.end - delivery.start
        },
        kernel(event: { type: string; posture?: string }) {
          if (event.type === 'posture' && event.posture === 'live') live.push(performance.now())
        },
        snapshot(): Capture {
          return {
            deliveries,
            live,
            readyAt: proof.readyAt,
            settledAt: proof.settledAt,
            firstPaint: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0,
            final: [...rows].map(([pool, states]) => ({
              pool,
              sessions: states.size,
              unread: [...states.values()].filter((row) => row[0] === true).length,
              hash: digest(states),
            })),
          }
        },
      }
      global.__cacheProof = proof
      const ready = () =>
        mobile
          ? !!document.querySelector('[aria-label="Session actions"]') &&
            !!document.querySelector('textarea, input[type="text"], [role="textbox"]') &&
            document.body?.textContent?.includes(title)
          : !!document.querySelector('aside') &&
            !document.querySelector('.app-loading') &&
            !!document.querySelector('[data-testid="unified-issue-row"]')
      const observer = new MutationObserver(() => {
        if (!proof.readyAt && ready()) {
          proof.readyAt = performance.now()
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              proof.settledAt = performance.now()
              performance.mark('cache-proof:settled')
            }),
          )
        }
      })
      observer.observe(document, { childList: true, subtree: true, attributes: true })
    },
    { mobile, title },
  )
}

export async function capture(page: Page): Promise<Capture> {
  return page.evaluate(() =>
    (globalThis as unknown as { __cacheProof: { snapshot(): Capture } }).__cacheProof.snapshot(),
  )
}
