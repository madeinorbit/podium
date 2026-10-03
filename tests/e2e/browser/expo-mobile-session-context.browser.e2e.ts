import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium phone export proof',
)
test.setTimeout(240_000)
test.use({ serviceWorkers: 'block' })
const artifacts = resolve(import.meta.dirname, '../../../.artifacts/POD-5171')
const http = RELAY.replace(/^ws/, 'http')
const measure = process.env.PODIUM_MOBILE_SESSION_MEASURE === '1'
const title = 'Phone session context proof'
const savedDraft = 'Saved phone conversation draft'
test.beforeAll(() => mkdirSync(artifacts, { recursive: true }))

async function rpc<T>(page: Page, path: string, input?: unknown): Promise<T> {
  const response =
    input === undefined
      ? await page.request.get(`${http}/trpc/${path}`)
      : await page.request.post(`${http}/trpc/${path}`, { data: input })
  expect(response.ok(), await response.text()).toBe(true)
  return ((await response.json()) as { result: { data: T } }).result.data
}
async function seed(page: Page) {
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
  return { ...session, issueId: issue.id }
}
async function observe(page: Page) {
  const errors: string[] = []
  let resource401 = 0
  page.on('response', (response) => {
    if (response.status() === 401) resource401++
  })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    // The isolated harness refuses some unauthenticated resources during
    // startup. Count those separately; retain every application/fatal error.
    if (message.type() === 'error' && !/^Failed to load resource:.*status of 401/.test(message.text()))
      errors.push(message.text())
  })
  await page.addInitScript(() => {
    // Existing opt-in counter; no production owner or subscriber is installed.
    const timer = setInterval(() => {
      const stats = (globalThis as unknown as { __podiumStoreStats?: { enable(): void } })
        .__podiumStoreStats
      if (stats) {
        stats.enable()
        clearInterval(timer)
      }
    }, 0)
  })
  return { errors, resource401: () => resource401 }
}
async function settings(page: Page, on: boolean) {
  await page.goto(`/mobile/settings?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Sync cursor')).toBeVisible({ timeout: 60_000 })
  const toggle = page.getByLabel('MobX pilot', { exact: true })
  if ((await toggle.isChecked()) !== on) {
    await toggle.click()
    await page.waitForTimeout(2_000) // The production device storage write-behind.
  }
}
async function conversation(page: Page, sessionId: string) {
  await page.goto(`/mobile/session/${sessionId}?server=${RELAY}&e2e=1`, {
    waitUntil: 'domcontentloaded',
  })
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  await expect(page.getByLabel('Session actions')).toBeVisible()
  const input = page.getByRole('textbox').last()
  await expect(input).toBeVisible()
  return input
}
async function counts(page: Page) {
  return page.evaluate(() => {
    const stats = (
      globalThis as unknown as {
        __podiumStoreStats?: {
          snapshot(): { runtimes: { slices: Record<string, number>; selectorRuns: number }[] }
        }
      }
    ).__podiumStoreStats?.snapshot()
    if (!stats) throw new Error('The existing store counter did not attach')
    return stats.runtimes.reduce(
      (sum, row) => ({
        context: sum.context + (row.slices['mobileSession.context'] ?? 0),
        ports: sum.ports + (row.slices['mobileSession.ports'] ?? 0),
        selectors: sum.selectors + row.selectorRuns,
      }),
      { context: 0, ports: 0, selectors: 0 },
    )
  })
}

test('seeded production phone keeps session identity, draft and terminal attachment through the pool-on restart', async ({
  page,
}) => {
  const observed = await observe(page),
    session = await seed(page)
  await settings(page, false)
  const legacy = await conversation(page, session.sessionId)
  await legacy.fill(savedDraft)
  await page.waitForTimeout(2_000)
  const before = await counts(page)
  expect(before.context).toBeGreaterThan(0)
  expect(before.ports).toBeGreaterThan(0) // The legacy subscriber is the red arm.
  await page.screenshot({ path: resolve(artifacts, 'conversation-legacy.png') })
  await settings(page, true)
  const enabled = await conversation(page, session.sessionId)
  await expect(enabled).toHaveValue(savedDraft)
  await enabled.fill(`${savedDraft} updated`)
  await expect(enabled).toHaveValue(`${savedDraft} updated`)
  const after = await counts(page)
  expect(after.context).toBe(0)
  expect(after.ports).toBe(0)
  await page.screenshot({ path: resolve(artifacts, 'conversation-pool.png') })

  // The actual renderer spends its attach only after the pool's confirmed row
  // arrives. No synthetic terminal or controller stands in for this boundary.
  await page.goto(`/mobile/session/${session.sessionId}/terminal?server=${RELAY}&e2e=1`, {
    waitUntil: 'domcontentloaded',
  })
  await expect(page.getByRole('button', { name: /^Task .* — open$/ })).toBeVisible({
    timeout: 60_000,
  })
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (
            window as unknown as {
              __podium?: { state(): { sessionId?: string }; screenText(): string }
            }
          ).__podium?.screenText(),
        ),
      { timeout: 45_000 },
    )
    .toContain('keyecho')
  const terminal = await page.evaluate(() =>
    (
      window as unknown as {
        __podium?: { state(): { sessionId?: string; cols: number; rows: number } }
      }
    ).__podium?.state(),
  )
  expect(terminal?.sessionId).toBe(session.sessionId)
  expect(terminal?.cols).toBeGreaterThan(0)
  expect(terminal?.rows).toBeGreaterThan(0)
  expect(await counts(page)).toMatchObject({ context: 0, ports: 0 })
  expect(observed.errors).toEqual([])
  await page.screenshot({ path: resolve(artifacts, 'terminal-pool.png') })
  writeFileSync(
    resolve(artifacts, 'production-proof.json'),
    `${JSON.stringify({ before, after, terminal: { cols: terminal?.cols, rows: terminal?.rows }, errors: observed.errors.length, resource401: observed.resource401() }, null, 2)}\n`,
  )
})

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
/** Expand only the isolated harness bootstrap. Clone its canonical synthetic
 * issue/session shapes; never create thousands of daemon processes or read an
 * operator cache. Each snapshot chunk retains the authority's real cursor. */
async function sizedBootstrap(page: Page, session: { issueId: string; sessionId: string }) {
  const size = { sessions: 5_200, issues: 6_100 }
  let installations = 0
  await page.route('**/sync/bootstrap', async (route) => {
    const reply = await route.fetch(),
      frames = (await reply.text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Frame)
    const meta = frames[0]!,
      complete = frames.at(-1)!,
      chunks = frames.filter((frame) => frame.type === 'feedBootstrap')
    const original = chunks.flatMap((frame) => frame.changes ?? [])
    const issue = original.find(
      (row) => row.entity === 'issueProjection' && row.entityId === session.issueId,
    )
    const seat = original.find(
      (row) => row.entity === 'session' && row.entityId === session.sessionId,
    )
    if (!issue || !seat || meta.seq < 1)
      throw new Error('Canonical synthetic bootstrap templates are missing')
    const additions: Change[] = []
    for (let index = 0; index < size.issues; index++) {
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
    for (let index = 0; index < size.sessions; index++) {
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
    const width = Math.min(meta.seq, 128),
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
    const body = `${[
      { ...meta, totalRows: rows },
      ...all,
      { ...complete, rows, records: all.length },
    ]
      .map((frame) => JSON.stringify(frame))
      .join('\n')}\n`
    const headers: Record<string, string> = {
      ...reply.headers(),
      'content-type': 'application/x-ndjson',
    }
    delete headers['content-length']
    delete headers['content-encoding']
    delete headers['transfer-encoding']
    installations++
    await route.fulfill({
      status: reply.status(),
      body,
      headers,
    })
  })
  return { size, installations: () => installations }
}

test('measures the phone conversation with an operator-sized synthetic corpus', async ({
  page,
}) => {
  test.skip(
    !measure,
    'Run only while holding bench:flatblock, with PODIUM_MOBILE_SESSION_MEASURE=1',
  )
  test.setTimeout(360_000)
  const observed = await observe(page),
    session = await seed(page),
    corpus = await sizedBootstrap(page, session)
  if (process.env.PODIUM_MOBILE_SESSION_WAIT_FOR_LEASE === '1') {
    // The lane builds and boots first. The operator grants the timing lease
    // only at this boundary, so build and correctness work never hold it.
    test.setTimeout(2_160_000)
    const started = Date.now()
    writeFileSync(resolve(artifacts, 'measurement-ready.json'), '{"ready":true}\n')
    await expect
      .poll(() => existsSync(resolve(artifacts, 'capture-granted')), {
        timeout: 1_800_000,
      })
      .toBe(true)
    test.setTimeout(Date.now() - started + 360_000)
  }
  const arms: {
    pool: boolean
    replicaCache: 'cold' | 'warm'
    navigationMs: number
    draftMs: number[]
    counts: Awaited<ReturnType<typeof counts>>
  }[] = []
  for (const on of [false, true, false, true]) {
    await settings(page, on)
    const replicaCache = arms.length < 2 ? 'cold' : 'warm'
    if (replicaCache === 'cold') {
      // Keep the device preference and auth cookie; close the app's handles
      // before clearing both first arms' replica homes. Bootstrap interception
      // disables browser HTTP caching in every arm, including the warm arms.
      const origin = new URL(page.url()).origin
      await page.goto('about:blank')
      const protocol = await page.context().newCDPSession(page)
      await protocol.send('Storage.clearDataForOrigin', {
        origin,
        storageTypes: 'indexeddb,cache_storage',
      })
      await protocol.detach()
    }
    const input = await conversation(page, session.sessionId)
    const navigationMs = await page.evaluate(
      () =>
        new Promise<number>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now()))),
        ),
    )
    const draftMs: number[] = []
    for (let index = 0; index < 6; index++) {
      await input.evaluate((element) => {
        element.addEventListener(
          'input',
          () => {
            const start = performance.now()
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                ;(window as unknown as { __phoneDraftMs?: number }).__phoneDraftMs =
                  performance.now() - start
              }),
            )
          },
          { once: true },
        )
        delete (window as unknown as { __phoneDraftMs?: number }).__phoneDraftMs
      })
      await input.fill(`Synthetic draft ${on}:${index}`)
      await page.waitForFunction(
        () => (window as unknown as { __phoneDraftMs?: number }).__phoneDraftMs !== undefined,
      )
      draftMs.push(
        await page.evaluate(() => (window as unknown as { __phoneDraftMs: number }).__phoneDraftMs),
      )
    }
    const reads = await counts(page)
    if (on) expect(reads).toMatchObject({ context: 0, ports: 0 })
    else {
      expect(reads.context).toBeGreaterThan(0)
      expect(reads.ports).toBeGreaterThan(0)
    }
    arms.push({ pool: on, replicaCache, navigationMs, draftMs, counts: reads })
  }
  expect(corpus.installations()).toBeGreaterThan(0)
  expect(observed.errors).toEqual([])
  writeFileSync(
    resolve(artifacts, 'browser-measurement.json'),
    `${JSON.stringify({ corpus: corpus.size, bootstrapInstallations: corpus.installations(), browser: 'chromium-pixel', httpCache: 'Disabled by bootstrap interception in every arm', method: 'Document navigation start to settled conversation, and input event to two animation frames; cold replica legacy/pool, then warm replica legacy/pool. Cold arms clear IndexedDB, warm arms retain it. Not the web speed gate.', arms, errors: observed.errors.length, resource401: observed.resource401() }, null, 2)}\n`,
  )
})
