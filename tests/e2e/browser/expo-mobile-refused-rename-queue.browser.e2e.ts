import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type APIRequestContext,
  type CDPSession,
  devices,
  expect,
  type Page,
  type Route,
  test,
} from '@playwright/test'
import { RELAY } from './_harness'
import { replicaDurable } from './_phone-profile'

/**
 * POD-5430: POD-5415's phone sequence on ONE shared profile, as POD-4978 first
 * hit it. A refused rename used to park and hold its issue's partition, so the
 * read receipt from opening the mission and the next rename stayed queued until
 * the user dealt with the first ("1 change needing review and 2 queued"). Under
 * ADR 3 amendment 2 the refusal releases the partition: both later writes send,
 * and the banner reads "1 change needs review" with nothing queued.
 *
 * Synthetic issues on the lane's isolated server only.
 */
test.skip(
  ({ isMobile, browserName }) => !isMobile || browserName !== 'chromium',
  'Pixel Chromium proof',
)
test.use({ serviceWorkers: 'block' })
test.setTimeout(240_000)
const HTTP = RELAY.replace(/^ws/, 'http')

async function rpc<T>(
  request: APIRequestContext,
  procedure: string,
  input: unknown,
  query = false,
): Promise<T> {
  const result = query
    ? await request.get(
        `${HTTP}/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`,
      )
    : await request.post(`${HTTP}/trpc/${procedure}`, { data: input })
  if (!result.ok()) throw new Error(`${procedure}: ${result.status()} ${await result.text()}`)
  return (await result.json()).result.data as T
}

async function longPress(page: Page, cdp: CDPSession, label: string) {
  const row = page.getByRole('button', { name: label, exact: true })
  await row.click({ trial: true })
  const box = await row.boundingBox()
  if (!box) throw new Error('Missing native row')
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
  })
  await page.waitForTimeout(500)
  await expect(page.getByRole('button', { name: 'Rename', exact: true })).toBeVisible()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
}

async function rename(page: Page, cdp: CDPSession, label: string, next: string) {
  await longPress(page, cdp, label)
  await page.getByRole('button', { name: 'Rename', exact: true }).tap({ timeout: 15_000 })
  await page
    .getByRole('textbox', { name: 'Rename task', exact: true })
    .fill(next, { timeout: 15_000 })
  await page.getByRole('button', { name: 'Rename', exact: true }).tap({ timeout: 15_000 })
}

async function launchWork(page: Page, on: boolean) {
  await page.goto(`/mobile/settings?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('Sync cursor')).toBeVisible({ timeout: 60_000 })
  const toggle = page.getByLabel('MobX pilot', { exact: true })
  if ((await toggle.isChecked()) !== on) await toggle.click()
  await expect(toggle).toBeChecked({ checked: on })
  await page.waitForTimeout(2_000)
  await replicaDurable(page)
  await page.goto(`/mobile/work?server=${RELAY}`, { waitUntil: 'domcontentloaded' })
}

interface WireIssue {
  readonly id: string
  readonly title: string
}

test('a refused rename holds neither the read receipt nor the next rename on one phone profile', async ({
  browser,
  request,
}, testInfo) => {
  const repos = await rpc<string[]>(request, 'repos.list', {}, true)
  const repoPath = repos[0]
  if (!repoPath) throw new Error('Isolated harness has no repo')
  const arms: unknown[] = []
  for (const on of [false, true]) {
    const title = `Refusal queue ${on ? 'on' : 'off'} ${Date.now().toString(36)}`
    const issue = await rpc<{ id: string }>(request, 'issues.create', {
      repoPath,
      title,
      // Started, so Work lists the row. Each start adds a worktree to the
      // harness checkout; remove them after a run on a shared host.
      startNow: true,
    })
    const context = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block' })
    const errors: string[] = []
    const sent: { path: string; at: number; body: string }[] = []
    try {
      const page = await context.newPage()
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => {
        if (message.type() !== 'error') return
        const url = message.location().url
        const path = url ? new URL(url).pathname : ''
        if (
          /^Failed to load resource: the server responded with a status of 401\b/.test(
            message.text(),
          ) ||
          (path === '/trpc/issues.update' &&
            /^Failed to load resource: the server responded with a status of 400\b/.test(
              message.text(),
            ))
        )
          return
        errors.push(message.text())
      })
      page.on('request', (req) => {
        const path = new URL(req.url()).pathname
        if (path === '/trpc/issues.update' || path === '/trpc/issues.markRead') {
          sent.push({ path, at: Date.now(), body: req.postData() ?? '' })
        }
      })
      await launchWork(page, on)
      const row = () =>
        page.getByRole('button', { name: new RegExp(`^(?:[A-Z]+-\\d+|#\\d+) ${title}$`) })
      await expect(row()).toBeVisible({ timeout: 60_000 })
      const cdp = await context.newCDPSession(page)
      const label = (await row().getAttribute('aria-label'))!
      const ref = label.slice(0, -(title.length + 1))

      // Rename A, refused by the server: it rolls back and parks with its text.
      let held: Route | undefined
      await page.route('**/trpc/issues.update*', (route) => {
        held = route
      })
      await rename(page, cdp, label, `${title} A`)
      await expect.poll(() => held !== undefined).toBe(true)
      await held!.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            message: 'Synthetic refusal',
            code: -32600,
            data: { code: 'BAD_REQUEST', httpStatus: 400, path: 'issues.update' },
          },
        }),
      })
      await page.unroute('**/trpc/issues.update*')
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible({
        timeout: 15_000,
      })

      // Open the mission after the refusal: its read receipt joins the partition.
      await page.getByRole('button', { name: label, exact: true }).tap()
      await expect(page).toHaveURL(/\/mobile\/mission\//)
      await expect(page.getByLabel('Mission actions', { exact: true })).toBeVisible({
        timeout: 30_000,
      })
      await page.goBack()
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible({
        timeout: 30_000,
      })

      // Rename B: same issue, same partition.
      await rename(page, cdp, label, `${title} B`)
      await expect(
        page.getByRole('button', { name: `${ref} ${title} B`, exact: true }),
      ).toBeVisible()

      // Both later writes reach the server, and the server holds rename B.
      await expect
        .poll(
          async () => {
            const rows = await rpc<WireIssue[]>(request, 'issues.list', { repoPath }, true)
            return rows.find((candidate) => candidate.id === issue.id)?.title
          },
          { timeout: 30_000 },
        )
        .toBe(`${title} B`)
      await expect.poll(() => sent.some((s) => s.path === '/trpc/issues.markRead')).toBe(true)

      // The banner: one change needs review, nothing queued behind it.
      const notice = page.getByTestId('workspace-continuity-notice')
      await expect(notice).toContainText('1 change needs review', { timeout: 15_000 })
      await expect(notice).not.toContainText('queued')

      arms.push({
        on,
        sent: sent.map(({ path, body }) => ({
          path,
          rename: /"title":"[^"]* ([AB])"/.exec(body)?.[1] ?? null,
        })),
        notice: await notice.textContent(),
      })
      expect(errors).toEqual([])
    } finally {
      await context.close()
    }
  }
  const directory = resolve('.artifacts/POD-5430')
  mkdirSync(directory, { recursive: true })
  const path = resolve(directory, 'refused-rename-queue.json')
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        browser: browser.version(),
        arms,
        scope:
          'Synthetic production Expo export; one shared phone profile per arm (pilot off, then on); refused rename, mission open, second rename on the same issue.',
      },
      null,
      2,
    )}\n`,
  )
  await testInfo.attach('Refused rename queue', { path, contentType: 'application/json' })
  console.info('[refused rename queue]', JSON.stringify(arms))
})
