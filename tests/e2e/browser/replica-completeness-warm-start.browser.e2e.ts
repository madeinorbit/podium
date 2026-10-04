/** POD-5403 production warm-resume proof. Opt-in, foreground on flatblock with
 * bench:flatblock held. Both arms serve untouched minified production files to
 * independent browser caches, against one isolated harness authority. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type BrowserContext,
  type CDPSession,
  devices,
  expect,
  type Page,
  test,
} from '@playwright/test'
import { RELAY } from './_harness'
import {
  firstLaunch,
  observeErrors,
  replicaDurable,
  SIZED_CORPUS,
  saveTrace,
  seedSession,
  sizedBootstrap,
  traceStart,
} from './_phone-profile'
import { type Capture, capture, installProbe, logpoints } from './_warm-cache-logpoints'

test.skip(process.env.PODIUM_WARM_CACHE_PROOF !== '1', 'explicit production capture only')
test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium logpoint and trace proof')
test.setTimeout(600_000)
test.use({ serviceWorkers: 'block' })

const ARTIFACTS = resolve(import.meta.dirname, '../../../.artifacts/5403')
const TITLE = 'Warm cache completeness proof'
const ORIGIN = RELAY.replace(/^ws/, 'http')
// Functional cold-start diagnosis has no debugger probes or timing capture and
// can run while another issue holds the shared timing lease.
const STARTUP_ONLY = process.env.PODIUM_WARM_CACHE_STARTUP_ONLY === '1'
type Name = 'baseline' | 'candidate'
interface Sample extends Capture {
  arm: Name
  bootstrapRequests: number
  certified: boolean
}

function paths(name: Name, mobile: boolean) {
  const root = process.env[`PODIUM_WARM_${name.toUpperCase()}_DIST`]
  const checkout = process.env[`PODIUM_WARM_${name.toUpperCase()}_CHECKOUT`]
  if (!root || !checkout) throw new Error(`Missing ${name} production dist/check-out paths`)
  const dist = resolve(root, mobile ? 'mobile' : 'web')
  return {
    dist,
    checkout,
    stamp: JSON.parse(readFileSync(resolve(dist, 'podium-build.json'), 'utf8')),
  }
}

/** Static bytes only are substituted; sync/auth/RPC still reach the harness. */
async function productionFiles(context: BrowserContext, current: () => string, mobile: boolean) {
  await context.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (new URL(route.request().url()).origin !== ORIGIN) return route.continue()
    const staticPath = mobile
      ? path.startsWith('/mobile/')
      : path === '/' || /^\/(assets|favicon|manifest|podium-build|sw\.js)/.test(path)
    if (!staticPath) return route.continue()
    const suffix = mobile ? path.slice('/mobile/'.length) : path.slice(1)
    let file = resolve(current(), suffix || 'index.html')
    if (
      !existsSync(file) &&
      mobile &&
      !suffix.startsWith('_expo/') &&
      !suffix.startsWith('assets/')
    )
      file = resolve(current(), 'index.html')
    if (!existsSync(file)) throw new Error(`Missing production asset ${file}`)
    const extension = file.split('.').at(-1)
    const mime: Record<string, string> = {
      html: 'text/html',
      js: 'text/javascript',
      css: 'text/css',
      json: 'application/json',
      svg: 'image/svg+xml',
      png: 'image/png',
      ttf: 'font/ttf',
      woff2: 'font/woff2',
      ico: 'image/x-icon',
    }
    await route.fulfill({
      status: 200,
      body: readFileSync(file),
      contentType: mime[extension ?? ''] ?? 'application/octet-stream',
    })
  })
}

async function readMetadata(page: Page, mobile: boolean) {
  return page.evaluate(
    async (database) => {
      if (!(await indexedDB.databases()).some((entry) => entry.name === database)) return []
      return new Promise<{ key: string; value: Record<string, unknown> }[]>((done, fail) => {
        const request = indexedDB.open(database)
        request.onerror = () => fail(request.error)
        request.onsuccess = () => {
          const db = request.result
          if (!db.objectStoreNames.contains('entities') || !db.objectStoreNames.contains('meta')) {
            db.close()
            done([])
            return
          }
          const tx = db.transaction(['entities', 'meta'], 'readonly')
          const read = tx.objectStore('meta').getAll()
          tx.oncomplete = () => {
            db.close()
            done(read.result)
          }
          tx.onerror = () => fail(tx.error)
        }
      })
    },
    mobile ? 'podium-replica.db' : 'podium-kernel-replica',
  )
}

async function certified(page: Page, mobile: boolean) {
  const meta = await readMetadata(page, mobile)
  const cursor = meta.find((row) => row.key === 'cursor')?.value
  const marker = meta.find((row) => row.key === 'personal-rows-complete-at')?.value
  return (
    !!cursor &&
    !!marker &&
    typeof marker.scopeFingerprint === 'string' &&
    marker.scopeFingerprint === cursor.scopeFingerprint &&
    marker.feedId === cursor.feedId &&
    marker.epoch === cursor.epoch &&
    marker.seq === cursor.seq
  )
}

async function durable(page: Page, mobile: boolean) {
  if (mobile) return replicaDurable(page)
  await expect
    .poll(
      async () => (await readMetadata(page, false)).filter((row) => row.key === 'cursor').length,
      { timeout: 120_000, intervals: [500] },
    )
    .toBe(1)
}

const bulk = (sample: Capture) =>
  sample.deliveries.filter((delivery) => delivery.sessions === SIZED_CORPUS.sessions)

function appErrors(errors: string[], mobile: boolean): string[] {
  // Blocking workers prevents a controlling-worker handoff from adding a second
  // navigation. Workbox reports that Playwright's blocked register() returned
  // undefined; retain the report, but exclude only that harness-induced error.
  return errors.filter(
    (error) =>
      mobile ||
      !(
        error.includes('ERROR web:sw service worker registration failed') &&
        error.includes("Cannot read properties of undefined (reading 'waiting')") &&
        error.includes('workbox-window.prod.es5-')
      ),
  )
}

test('certified warm attach removes the second delivery and preserves live values', async ({
  browser,
  page: seedPage,
  isMobile,
}, info) => {
  mkdirSync(ARTIFACTS, { recursive: true })
  const surface = isMobile ? 'phone' : 'web'
  const seed = await seedSession(seedPage, `${TITLE} ${surface}`)
  const arms = {} as Record<
    Name,
    {
      context: BrowserContext
      page: Page
      cdp: CDPSession
      current: Name
      corpus: Awaited<ReturnType<typeof sizedBootstrap>>
      errors: ReturnType<typeof observeErrors>
      mappings: Awaited<ReturnType<typeof logpoints>>
    }
  >
  const samples: Sample[] = []
  const compatibility: Sample[] = []
  const metadata = {
    baseline: paths('baseline', isMobile),
    candidate: paths('candidate', isMobile),
  }
  const route = isMobile
    ? `/mobile/session/${seed.sessionId}?server=${RELAY}&e2e=1`
    : `/?server=${RELAY}&e2e=1&mobxSidebar=1`

  try {
    for (const name of ['baseline', 'candidate'] as const) {
      const context = await browser.newContext({
        ...(isMobile ? devices['Pixel 7'] : devices['Desktop Chrome']),
        baseURL: ORIGIN,
        serviceWorkers: 'block',
      })
      // route.fulfill() has no peer IP. Chromium consequently treats the page
      // as public and requires this permission for the harness's loopback WS.
      await context.grantPermissions(['local-network-access'], { origin: ORIGIN })
      const page = await context.newPage()
      page.on('response', (response) => {
        if (new URL(response.url()).pathname.startsWith('/sync/'))
          console.log(
            `[${surface} ${name}] ${response.status()} ${new URL(response.url()).pathname}`,
          )
      })
      const arm = {
        context,
        page,
        current: name,
        cdp: await context.newCDPSession(page),
        corpus: await sizedBootstrap(page, seed),
        errors: observeErrors(page),
        mappings: { points: [], resolved: [], pauses: [] } as Awaited<ReturnType<typeof logpoints>>,
      }
      arms[name] = arm
      await productionFiles(context, () => metadata[arm.current].dist, isMobile)
      if (!STARTUP_ONLY) {
        await installProbe(page, isMobile, `${TITLE} ${surface}`)
        arm.mappings = await logpoints(
          arm.cdp,
          metadata[name].dist,
          metadata[name].checkout,
          isMobile,
        )
      }
      if (isMobile) {
        await firstLaunch(page)
      } else {
        await page.goto(route, { waitUntil: 'domcontentloaded' })
        await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
        await durable(page, false)
      }
      if (STARTUP_ONLY) {
        expect(arm.corpus.installations()).toBe(1)
        expect(await certified(page, isMobile)).toBe(name === 'candidate')
        expect(appErrors(arm.errors.errors, isMobile)).toEqual([])
        console.log(`[warm-cache-startup ${surface} ${name}] committed production cache`)
        continue
      }
      // Unmeasured pilot-on launch ensures each arm retains a fully committed cache.
      await page.goto(route, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(
        () =>
          (globalThis as unknown as { __cacheProof: { settledAt: number } }).__cacheProof
            .settledAt > 0,
        undefined,
        { timeout: 60_000 },
      )
      await page.waitForTimeout(5_000)
      await durable(page, isMobile)
      expect(arm.corpus.installations()).toBe(1)
      expect(await certified(page, isMobile)).toBe(name === 'candidate')
    }
    if (STARTUP_ONLY) return

    const measure = async (
      arm: (typeof arms)[Name],
      name: Name,
      trace = false,
    ): Promise<Sample> => {
      const before = arm.corpus.installations()
      const stopTrace = trace ? await traceStart(arm.cdp) : undefined
      await arm.page.goto(route, { waitUntil: 'domcontentloaded' })
      await arm.page.waitForFunction(
        () => {
          const proof = (
            globalThis as unknown as { __cacheProof: { settledAt: number; snapshot(): Capture } }
          ).__cacheProof
          return proof.settledAt > 0 && proof.snapshot().live.length > 0
        },
        undefined,
        { timeout: 60_000 },
      )
      await arm.page.waitForTimeout(5_000) // Observe post-paint live publication, too.
      const result: Sample = {
        ...(await capture(arm.page)),
        arm: name,
        bootstrapRequests: arm.corpus.installations() - before,
        certified: await certified(arm.page, isMobile),
      }
      if (stopTrace)
        saveTrace(resolve(ARTIFACTS, `${surface}-${name}.trace.json.gz`), await stopTrace())
      expect(result.bootstrapRequests).toBe(0)
      expect(result.live.length).toBeGreaterThan(0)
      expect(bulk(result).length, JSON.stringify(result)).toBe(name === 'candidate' ? 1 : 2)
      expect(bulk(result)[0]?.type).toBe('replace')
      expect(bulk(result)[0]?.unread).toBe(name === 'candidate' ? SIZED_CORPUS.sessions : 0)
      expect(bulk(result).at(-1)?.unread).toBe(SIZED_CORPUS.sessions)
      expect(bulk(result).every((delivery) => typeof delivery.duration === 'number')).toBe(true)
      expect(result.certified).toBe(name === 'candidate')
      expect(appErrors(arm.errors.errors, isMobile)).toEqual([])
      expect(arm.mappings.pauses).toEqual([])
      return result
    }

    // Three interleaved paired starts, then one trace pair for inspectable evidence.
    for (const name of [
      'baseline',
      'candidate',
      'candidate',
      'baseline',
      'baseline',
      'candidate',
    ] as const)
      samples.push(await measure(arms[name], name))
    const before = await measure(arms.baseline, 'baseline', true)
    const after = await measure(arms.candidate, 'candidate', true)
    for (const sample of [...samples, before, after])
      expect(bulk(sample).at(-1)?.hash).toBe(bulk(after)[0]?.hash)
    await arms.candidate.page.screenshot({
      path: resolve(ARTIFACTS, `${surface}-certified-warm.png`),
    })

    // Upgrade the cache written by the unchanged older build, with no migration.
    const old = arms.baseline
    old.current = 'candidate'
    // Unchanged chunks can keep the same URL across the two builds.
    await old.cdp.send('Debugger.disable')
    await logpoints(old.cdp, metadata.candidate.dist, metadata.candidate.checkout, isMobile)
    const count = old.corpus.installations()
    await old.page.goto(route, { waitUntil: 'domcontentloaded' })
    await old.page.waitForFunction(
      () =>
        (
          globalThis as unknown as { __cacheProof: { settledAt: number; snapshot(): Capture } }
        ).__cacheProof.snapshot().live.length > 0,
      undefined,
      { timeout: 60_000 },
    )
    await old.page.waitForTimeout(5_000)
    const upgrade: Sample = {
      ...(await capture(old.page)),
      arm: 'candidate',
      bootstrapRequests: old.corpus.installations() - count,
      certified: await certified(old.page, isMobile),
    }
    expect(upgrade.bootstrapRequests).toBe(0)
    expect(bulk(upgrade).length).toBe(2)
    expect(bulk(upgrade)[0]?.unread).toBe(0)
    expect(bulk(upgrade).at(-1)?.hash).toBe(bulk(after)[0]?.hash)
    expect(upgrade.certified).toBe(true)
    compatibility.push(upgrade, await measure(old, 'candidate'))

    const report = {
      surface,
      project: info.project.name,
      corpus: SIZED_CORPUS,
      production: metadata,
      samples,
      traced: [before, after],
      legacyUpgrade: compatibility,
      resolvedLogpoints: {
        baseline: arms.baseline.mappings.resolved,
        candidate: arms.candidate.mappings.resolved,
      },
      errors: { baseline: arms.baseline.errors, candidate: arms.candidate.errors },
    }
    writeFileSync(
      resolve(ARTIFACTS, `${surface}-warm-start.json`),
      `${JSON.stringify(report, null, 2)}\n`,
    )
    console.log(
      `[warm-cache-proof ${surface}] ${JSON.stringify(samples.map((sample) => ({ arm: sample.arm, settledMs: sample.settledAt, deliveries: bulk(sample) })))}`,
    )
  } catch (error) {
    const diagnostics = []
    for (const [name, arm] of Object.entries(arms)) {
      const state = {
        name,
        error: String(error),
        url: arm.page.url(),
        text: await arm.page.locator('body').innerText().catch(String),
        probe: await capture(arm.page).catch(String),
        meta: await readMetadata(arm.page, isMobile).catch(String),
        databases: await arm.page.evaluate(() => indexedDB.databases()).catch(String),
        bootstrapRequests: arm.corpus.installations(),
        errors: arm.errors.errors,
        mappings: arm.mappings,
      }
      diagnostics.push(state)
      await arm.page
        .screenshot({ path: resolve(ARTIFACTS, `${surface}-${name}-failure.png`) })
        .catch(() => {})
      console.log(`[warm-cache-failure] ${JSON.stringify(state)}`)
    }
    writeFileSync(
      resolve(ARTIFACTS, `${surface}-failure.json`),
      `${JSON.stringify(diagnostics, null, 2)}\n`,
    )
    throw error
  } finally {
    for (const arm of Object.values(arms)) await arm.context.close()
  }
})
