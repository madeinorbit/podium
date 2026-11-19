import { devices, expect, type Page, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * BROWSER BACK AND FORWARD KEEP THE PHONE APP MOUNTED (POD-7177).
 *
 * On the phone web build a popstate to a history entry Expo Router does not
 * hold (an entry written by someone else, one from before a reload, the iOS
 * Safari swipe back onto one) used to reset the router's root with a state
 * rebuilt from the path. That state carries no route keys, so the root layout
 * got a new key and the whole app remounted: /readiness, /auth/status, a new
 * socket and a fresh replica boot, every time, and offline the readiness check
 * failed (POD-7176 measured it). Taps were fine: they call the router.
 *
 * The walk: Work, a mission and its details by the app's router (what a tap
 * calls), then back and forward over the entries the router holds, then an
 * entry it does not hold and back and forward across that. Throughout, the app
 * shell's DOM stays the same nodes, no new socket opens and nothing asks
 * /readiness, /auth/status or the boot routes again: the same replica serves
 * every screen. iPhone emulation in Chromium (WebKit does not run on the
 * Linux test hosts).
 */
const { defaultBrowserType: _webkit, ...iPhone } = devices['iPhone 13']
test.use({ ...iPhone, serviceWorkers: 'block' })
test.setTimeout(180_000)

const TITLE = `History keeps the app ${Date.now()}`
const BOOT_PATHS = ['/readiness', '/auth/status', '/sync/bootstrap', '/sync/delta']

async function seedMission(page: Page): Promise<string> {
  const http = RELAY.replace(/^ws/, 'http')
  const repos = (await (await page.request.get(`${http}/trpc/repos.list`)).json()) as {
    result: { data: string[] }
  }
  const repoPath =
    repos.result.data.find((repo) => repo.includes('zz-podium-e2e-repo-')) ?? repos.result.data[0]
  expect(repoPath).toBeDefined()
  const created = await page.request.post(`${http}/trpc/issues.create`, {
    data: { repoPath, title: TITLE, startNow: false },
  })
  expect(created.ok(), await created.text()).toBe(true)
  return ((await created.json()) as { result: { data: { id: string } } }).result.data.id
}

const routerNavigate = (page: Page, href: string) =>
  page.evaluate((href) => {
    const hook = (globalThis as { __podiumPhoneRouter?: { navigate(href: string): void } })
      .__podiumPhoneRouter
    if (!hook) throw new Error('No phone router hook: the page needs ?e2e=1')
    hook.navigate(href)
  }, href)

const onWork = async (page: Page) => {
  await expect(page).toHaveURL(/\/mobile\/work(?:\?|$)/)
  await expect(page.getByRole('button', { name: 'Search work', exact: true })).toBeVisible()
}
const onMission = async (page: Page, id: string) => {
  await expect(page).toHaveURL(new RegExp(`/mobile/mission/${id}(?:\\?|$)`))
  await expect(page.getByText(TITLE).filter({ visible: true }).first()).toBeVisible()
}
const onDetails = async (page: Page, id: string) => {
  await expect(page).toHaveURL(new RegExp(`/mobile/mission/${id}/details(?:\\?|$)`))
  await expect(
    page
      .getByLabel(/^(Fold|Expand) every branch$/)
      .filter({ visible: true })
      .first(),
  ).toBeVisible()
}

test('back and forward between Work, a mission and its details keep the app and its replica', async ({
  page,
}) => {
  // The device is set above; one Chromium project runs it.
  test.skip(test.info().project.name !== 'chromium-pixel', 'One phone run')
  const id = await seedMission(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto(`/mobile/work?server=${RELAY}&e2e=1`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('tab', { name: 'Work', exact: true })).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByRole('button', { name: 'Search work', exact: true })).toBeVisible()
  // The issue is on the device before the walk, so no screen waits on the feed.
  await routerNavigate(page, `/mission/${id}`)
  await onMission(page, id)
  await page.goBack()
  await onWork(page)
  await page.waitForTimeout(1_000)

  // From here on, a boot request or a new socket is a remount.
  const boots: string[] = []
  const sockets: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (BOOT_PATHS.includes(path)) boots.push(`${request.method()} ${path} at ${page.url()}`)
  })
  page.on('websocket', (socket) => sockets.push(socket.url()))
  // The app shell: the Work tab's ancestors. A remount replaces these nodes.
  await page.getByRole('tab', { name: 'Work', exact: true }).evaluate((tab) => {
    const shell: Element[] = []
    for (let node = tab.parentElement; node && node !== document.body; node = node.parentElement)
      shell.push(node)
    ;(globalThis as { __shell?: Element[] }).__shell = shell
  })
  const shellKept = () =>
    page.evaluate(() => {
      const shell = (globalThis as { __shell?: Element[] }).__shell ?? []
      return { size: shell.length, connected: shell.filter((node) => node.isConnected).length }
    })

  try {
    await walk(page, id)
  } finally {
    // The evidence either way: what a remount would have asked for.
    console.log('[history-keeps-app]', JSON.stringify({ boots, sockets, shell: await shellKept() }))
  }
  await page.waitForTimeout(1_500)
  const shell = await shellKept()
  expect(shell.size).toBeGreaterThan(3)
  expect(shell.connected, 'app shell nodes still mounted').toBe(shell.size)
  expect(boots, 'boot requests after the first load').toEqual([])
  expect(sockets, 'sockets opened after the first load').toEqual([])
  expect(errors).toEqual([])
})

async function walk(page: Page, id: string): Promise<void> {
  // Taps: Work → mission → details, through the router.
  await routerNavigate(page, `/mission/${id}`)
  await onMission(page, id)
  await routerNavigate(page, `/mission/${id}/details`)
  await onDetails(page, id)

  // Back and forward over the entries the router holds.
  await page.goBack()
  await onMission(page, id)
  await page.goBack()
  await onWork(page)
  await page.goForward()
  await onMission(page, id)
  await page.goForward()
  await onDetails(page, id)

  // An entry the router does not hold (the iOS swipe back and a back after a
  // reload land on such entries), then back and forward across it.
  await page.evaluate(() => {
    history.pushState(null, '', `/mobile/work${location.search}`)
    dispatchEvent(new PopStateEvent('popstate'))
  })
  await onWork(page)
  await page.goBack()
  await onDetails(page, id)
  await page.goForward()
  await onWork(page)
}
