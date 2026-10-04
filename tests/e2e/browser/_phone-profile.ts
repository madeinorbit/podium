/** Phone pool start attribution: the operator-sized synthetic corpus,
 * saved replica barrier and a navigation-surviving Chromium trace with V8 CPU
 * samples. Measurement only; never imported by a product file or default lane. */
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { type CDPSession, expect, type Page } from '@playwright/test'
import { readSyncStream } from '@podium/client-core/sync-stream'
import { SYNC_BATCH_MAX_ROWS } from '@podium/protocol'
import { RELAY } from './_harness'

const http = RELAY.replace(/^ws/, 'http')

export async function rpc<T>(page: Page, path: string, input?: unknown): Promise<T> {
  const response =
    input === undefined
      ? await page.request.get(`${http}/trpc/${path}`)
      : await page.request.post(`${http}/trpc/${path}`, { data: input })
  expect(response.ok(), await response.text()).toBe(true)
  return ((await response.json()) as { result: { data: T } }).result.data
}

/** One real issue with one live session on the isolated harness server. */
export async function seedSession(page: Page, title: string) {
  const repos = await rpc<string[]>(page, 'repos.list')
  const cwd = repos.find((repo) => repo.includes('zz-podium-e2e-repo-')) ?? repos[0]
  expect(cwd).toBeDefined()
  const issue = await rpc<{ id: string }>(page, 'issues.create', {
    repoPath: cwd,
    title,
    startNow: false,
  })
  const session = await rpc<{ sessionId: string }>(page, 'sessions.create', {
    cwd,
    issueId: issue.id,
    agentKind: 'claude-code',
    title,
  })
  await expect
    .poll(
      async () =>
        (await rpc<{ sessionId: string; status: string }[]>(page, 'sessions.list')).find(
          (row) => row.sessionId === session.sessionId,
        )?.status,
      { timeout: 60_000 },
    )
    .toBe('live')
  return { ...session, issueId: issue.id, cwd: cwd! }
}

interface Change {
  seq: number
  entity: string
  entityId: string
  op: string
  value: Record<string, unknown>
}
interface Frame {
  type: string
  changes?: Change[]
  seq: number
  last?: boolean
  totalRows?: number
  rows?: number
  records?: number
}

export const SIZED_CORPUS = { sessions: 5_200, issues: 6_100 }

/** POD-5171's protocol-valid sized bootstrap: clone the canonical seeded issue
 * and session rows to 6,100 issues and 5,200 sessions, in production-width
 * frames below the authority's real snapshot cursor, validated by the real
 * decoder before the browser sees it. No operator cache is read. */
export async function sizedBootstrap(page: Page, seed: { issueId: string; sessionId: string }) {
  let installations = 0
  await page.route('**/sync/bootstrap', async (route) => {
    const reply = await route.fetch()
    if (process.env.PODIUM_PHONE_PROFILE_UNSIZED === '1') {
      installations++
      if (process.env.PODIUM_PHONE_PROFILE_DEBUG === '1')
        console.log(`[bootstrap ${new Date().toISOString()}] #${installations} unsized pass-through`)
      await route.fulfill({ response: reply })
      return
    }
    const frames = (await reply.text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Frame)
    const meta = frames[0]!,
      complete = frames.at(-1)!,
      chunks = frames.filter((frame) => frame.type === 'feedBootstrap')
    const original = chunks.flatMap((frame) => frame.changes ?? [])
    const issue = original.find(
      (row) => row.entity === 'issueProjection' && row.entityId === seed.issueId,
    )
    const seat = original.find((row) => row.entity === 'session' && row.entityId === seed.sessionId)
    if (!issue || !seat || meta.seq < 1)
      throw new Error('Canonical synthetic bootstrap templates are missing')
    const additions: Change[] = []
    for (let index = 0; index < SIZED_CORPUS.issues; index++) {
      const id = `phone-summary-issue-${index}`
      additions.push({
        ...issue,
        entityId: id,
        value: {
          ...issue.value,
          id,
          seq: 10_000 + index,
          title: `Synthetic phone task ${index}`,
          archived: index >= 64,
          stage: index >= 64 ? 'done' : 'in_progress',
        },
      })
    }
    for (let index = 0; index < SIZED_CORPUS.sessions; index++) {
      const id = `phone-summary-session-${index}`
      additions.push({
        ...seat,
        entityId: id,
        value: {
          ...seat.value,
          sessionId: id,
          issueId: `phone-summary-issue-${index}`,
          refIssueId: `phone-summary-issue-${index}`,
          refSeq: 10_000 + index,
          title: `Synthetic phone agent ${index}`,
          archived: index >= 32,
          status: index >= 32 ? 'exited' : 'live',
          lastActiveAt: index >= 32 ? '2020-01-01T00:00:00Z' : new Date().toISOString(),
          stoppedAt: index >= 32 ? '2020-01-01T00:00:00Z' : undefined,
          ...(seat.value.resume && typeof seat.value.resume === 'object'
            ? { resume: { ...seat.value.resume, value: `phone-synthetic-resume-${index}` } }
            : {}),
        },
      })
    }
    const width = Math.min(meta.seq, SYNC_BATCH_MAX_ROWS),
      extra: Frame[] = []
    for (let start = 0; start < additions.length; start += width)
      extra.push({
        ...chunks[0]!,
        last: false,
        changes: additions
          .slice(start, start + width)
          .map((row, index) => ({ ...row, seq: index + 1 })),
      })
    const all = [...chunks.map((chunk) => ({ ...chunk, last: false })), ...extra]
    all.at(-1)!.last = true
    const rows = original.length + additions.length
    const body = `${[{ ...meta, totalRows: rows }, ...all, { ...complete, rows, records: all.length }]
      .map((frame) => JSON.stringify(frame))
      .join('\n')}\n`
    async function* lines() {
      yield* body.trim().split('\n')
    }
    for await (const _record of readSyncStream(lines())) {
      // Validate to EOF before the browser sees the response.
    }
    const headers: Record<string, string> = {
      ...reply.headers(),
      'content-type': 'application/x-ndjson',
    }
    delete headers['content-length']
    delete headers['content-encoding']
    delete headers['transfer-encoding']
    installations++
    if (process.env.PODIUM_PHONE_PROFILE_DEBUG === '1')
      console.log(`[bootstrap ${new Date().toISOString()}] #${installations} ${route.request().url()} rows=${rows} frames=${all.length}`)
    await route.fulfill({ status: reply.status(), body, headers })
  })
  return { installations: () => installations }
}

/** The unmeasured first launch: bootstrap the sized corpus and wait for its
 * commit. A fresh browser profile's first IndexedDB open can exceed the store's
 * 8 s open timeout on a loaded host; only this launch may reload. */
export async function firstLaunch(page: Page) {
  for (let attempt = 0; ; attempt++) {
    await page.goto(`/mobile/settings?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
    const ready = page.getByText('Sync cursor'),
      unavailable = page.getByText('STORAGE UNAVAILABLE', { exact: false })
    await expect(ready.or(unavailable).first()).toBeVisible({ timeout: 60_000 })
    if (await ready.isVisible()) break
    if (attempt === 2) throw new Error('Phone replica storage stayed unavailable')
  }
  await replicaDurable(page)
}

/** Leave only a SAVED replica behind: a warm launch is one whose predecessor
 * committed its cursor. A readonly IndexedDB transaction over the replica's
 * stores queues behind every earlier overlapping readwrite commit, so its
 * completion proves the bootstrap write landed. Leaving earlier aborts the
 * multi-second 11k-row commit: the next launch then re-bootstraps behind a
 * busy IndexedDB, which is what POD-5171's "warm" arms measured. */
export async function replicaDurable(page: Page) {
  // A cold launch may still be streaming: poll until its commit is queued and done.
  await expect.poll(() => committedCursors(page), { timeout: 120_000, intervals: [500] }).toBe(1)
}

async function committedCursors(page: Page) {
  return page.evaluate(
    () =>
      new Promise<number>((done, fail) => {
        const request = indexedDB.open('podium-replica.db')
        request.onerror = () => fail(request.error)
        request.onsuccess = () => {
          const db = request.result
          const tx = db.transaction(['entities', 'meta'], 'readonly')
          const read = tx.objectStore('meta').getAll()
          tx.oncomplete = () => {
            db.close()
            done((read.result as { key: string }[]).filter((row) => row.key === 'cursor').length)
          }
          tx.onerror = () => fail(tx.error)
        }
      }),
  )
}

/** Errors that fail every capture. The isolated harness refuses some
 * unauthenticated device resources; those 401s are counted, not failures. */
export function observeErrors(page: Page) {
  const errors: string[] = []
  let resource401 = 0
  page.on('response', (response) => {
    if (response.status() === 401) resource401++
  })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (process.env.PODIUM_PHONE_PROFILE_DEBUG === '1')
      console.log(`[page ${message.type()} ${new Date().toISOString()}] ${message.text().slice(0, 400)}`)
    if (
      message.type() === 'error' &&
      !/^Failed to load resource:.*status of 401/.test(message.text())
    )
      errors.push(message.text())
  })
  return { errors, resource401: () => resource401 }
}

/** Survives document navigation and renderer swaps, unlike the page-scoped
 * Profiler domain: V8 samples arrive as trace ProfileChunk events. */
export const TRACE_CATEGORIES = [
  'toplevel',
  'devtools.timeline',
  'blink.user_timing',
  'v8.execute',
  'disabled-by-default-v8.cpu_profiler',
].join(',')

export interface TraceEvent {
  name: string
  cat: string
  ph: string
  ts: number
  dur?: number
  pid: number
  tid: number
  id?: string
  args?: Record<string, unknown>
}

export async function traceStart(cdp: CDPSession) {
  const events: TraceEvent[] = []
  const receive = ({ value }: { value: unknown[] }) => {
    for (const event of value) events.push(event as TraceEvent)
  }
  cdp.on('Tracing.dataCollected', receive)
  await cdp.send('Tracing.start', {
    categories: TRACE_CATEGORIES,
    transferMode: 'ReportEvents',
  })
  return async () => {
    const complete = new Promise<void>((done) => cdp.once('Tracing.tracingComplete', () => done()))
    await cdp.send('Tracing.end')
    await complete
    cdp.off('Tracing.dataCollected', receive)
    return events
  }
}

/** DevTools Performance-panel loadable trace (gzip JSON array). */
export function saveTrace(path: string, events: TraceEvent[]) {
  writeFileSync(path, gzipSync(JSON.stringify({ traceEvents: events })))
}
