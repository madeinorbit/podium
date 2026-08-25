import { chromium, type Locator, type Page } from '@playwright/test'
// The formatting rule is protocol's, not the web app's: `formatDisplayedVersion`
// is a one-line passthrough of `formatDevVersionShort` that exists to give the
// browser bundle its own vocabulary. Reaching into `apps/web` for it dragged the
// whole browser module graph — `@/app/store` and all — into the scripts project,
// which maps no `@/` alias (POD-2807). Depending on the shared package instead
// keeps the alias out rather than teaching scripts/tsconfig.json to resolve it.
//
// This does not silently drift from what the UI renders: the assertions below
// compute the expected string and compare it against the DOM, so a web-only
// change to the label fails this lane loudly instead of passing on a stale rule.
import { formatDevVersionShort as formatDisplayedVersion } from '@podium/protocol/update-dev-version'

const origin = process.env.PODIUM_UPDATE_E2E_ORIGIN
const mode = process.env.PODIUM_UPDATE_E2E_UI_MODE ?? 'accept'
const target = process.env.PODIUM_UPDATE_E2E_TARGET
const screenshot = process.env.PODIUM_UPDATE_E2E_SCREENSHOT

if (!origin || !target) throw new Error('PODIUM_UPDATE_E2E_ORIGIN and TARGET are required')

const browser = await chromium.launch()
let page: Page | undefined

async function finishFirstRunIfVisible(page: Page, ready: Locator) {
  const setup = page.locator('.desktop-shell[data-setup-only="true"]')
  const first = await Promise.race([
    setup.waitFor().then(() => 'setup' as const),
    ready.waitFor().then(() => 'ready' as const),
  ])
  if (first === 'ready') return

  const activationUrl = new URL(origin!)
  activationUrl.searchParams.set('e2e', '1')
  activationUrl.searchParams.set('activation', 'first-task')
  await page.goto(activationUrl.toString(), {
    waitUntil: 'domcontentloaded',
    timeout: 180_000,
  })
  await page.getByRole('button', { name: 'Finish setup' }).click()
  await ready.waitFor()
}

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  page = await context.newPage()
  page.setDefaultTimeout(120_000)
  await page.goto(`${origin}?e2e=1`, {
    waitUntil: 'domcontentloaded',
    timeout: 180_000,
  })

  if (mode === 'accept' || mode === 'offer') {
    const indicator = page.getByTestId('update-indicator')
    await finishFirstRunIfVisible(page, indicator)
    let label = await indicator.getAttribute('aria-label')
    if (mode === 'accept' && label === 'Update failed') {
      if ((await indicator.getAttribute('aria-expanded')) !== 'true') await indicator.click()
      const stale = page.getByRole('dialog', { name: 'Podium update' })
      await stale.getByRole('button', { name: 'Hide' }).click()
      await page.waitForFunction(
        ({ version }) => {
          const next = document
            .querySelector('[data-testid="update-indicator"]')
            ?.getAttribute('aria-label')
          return (
            next === `Podium ${version} is available` || next === `Podium ${version} is required`
          )
        },
        { version: target },
      )
      label = await indicator.getAttribute('aria-label')
    }
    const offered =
      label === `Podium ${target} is available` || label === `Podium ${target} is required`
    const retrying = mode === 'accept' && label === `Podium ${target} could not be applied`
    if (!offered && !retrying) {
      const [versionResponse, fleetResponse] = await Promise.all([
        page.request.get(`${origin}/version`),
        page.request.get(`${origin}/trpc/updates.fleet`),
      ])
      console.error(`mode=${JSON.stringify(mode)} label=${JSON.stringify(label)}`)
      console.error(`version=${JSON.stringify(await versionResponse.json())}`)
      console.error(`fleet=${JSON.stringify(await fleetResponse.json())}`)
      throw new Error(`rendered offer did not name target ${target}`)
    }
    if (label === null) throw new Error('rendered offer had no accessible label')
    if ((await indicator.getAttribute('aria-expanded')) !== 'true') {
      await indicator.click()
    }
    const panel = page.getByRole('dialog', { name: 'Podium update' })
    await panel.getByRole('heading', { name: label }).waitFor()
    const primary = panel.getByTestId('update-primary')
    const action = retrying ? 'Try again' : 'Update Podium'
    if ((await primary.innerText()).trim() !== action) {
      throw new Error(`rendered offer did not expose the human ${action} action`)
    }
    if (screenshot) await panel.screenshot({ path: screenshot })

    if (mode === 'offer') {
      console.log(JSON.stringify({ offer: label, action }))
    } else {
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/trpc/updates.start') && response.request().method() === 'POST',
      )
      await primary.click()
      const payload = await (await responsePromise).json()
      const result = Array.isArray(payload) ? payload[0] : payload
      const operationId =
        result?.result?.data?.operationId ?? result?.result?.data?.json?.operationId
      if (typeof operationId !== 'string' || operationId.length === 0) {
        console.error(`updates.start=${JSON.stringify(payload)}`)
        throw new Error('UI acceptance did not return an update operation id')
      }
      /**
       * THE CLICK MUST START AN OPERATION, NOT JOIN ONE.
       *
       * `updates.start` deliberately hands a second caller the operation that is
       * already running (startUpdateOperation, apps/server/src/modules/updates/trpc.ts)
       * so two tabs render the same panel. That is right for a human and wrong
       * for a gate: it let this click return an EARLIER scenario's stuck
       * operation, whose id `rollout` then graded as if the click had produced
       * it. Two unrelated rows moved together for exactly that reason.
       */
      const alreadyRunning =
        result?.result?.data?.alreadyRunning ?? result?.result?.data?.json?.alreadyRunning
      if (alreadyRunning === true) {
        console.error(`updates.start=${JSON.stringify(payload)}`)
        throw new Error(
          `UI acceptance joined an update operation that was already running (${operationId}); it did not start one`,
        )
      }
      console.log(JSON.stringify({ operationId, offer: label, action }))
    }
  } else if (mode === 'versions') {
    const settingsButton = page.getByRole('button', { name: 'Settings' }).first()
    await finishFirstRunIfVisible(page, settingsButton)
    await settingsButton.click()
    const settings = page.getByTestId('settings-sheet')
    await settings.getByRole('button', { name: 'Updates', exact: true }).click()
    const versionResponse = await page.request.get(`${origin}/version`)
    if (!versionResponse.ok()) throw new Error(`/version returned ${versionResponse.status()}`)
    const versionBody = await versionResponse.json()
    const serverVersion = versionBody?.appVersion
    if (typeof serverVersion !== 'string') throw new Error('/version omitted appVersion')
    const shownServer = formatDisplayedVersion(serverVersion)
    const collapsed = settings.getByTestId('running-version')
    const breakdown = settings.getByTestId('component-version-breakdown')
    const shownTarget = formatDisplayedVersion(target)
    const rows = settings.locator('[data-testid^="update-machine-"]')
    await page.waitForFunction(
      ({ machines, version }) => {
        const text = [...document.querySelectorAll('[data-testid^="update-machine-"]')].map(
          (row) => row.textContent ?? '',
        )
        return machines.every((machine) =>
          text.some((candidate) => candidate.includes(machine) && candidate.includes(version)),
        )
      },
      { machines: ['source', 'fleet-a', 'fleet-b'], version: shownTarget },
    )
    const texts = await rows.allInnerTexts()
    for (const machine of ['source', 'fleet-a', 'fleet-b']) {
      const text = texts.find((candidate) => candidate.includes(machine))
      if (!text || !text.includes(shownTarget)) {
        throw new Error(`${machine} display does not report ${shownTarget}`)
      }
    }
    const fleetResponse = await page.request.get(`${origin}/trpc/updates.fleet`)
    if (!fleetResponse.ok()) throw new Error(`updates.fleet returned ${fleetResponse.status()}`)
    const fleetPayload = await fleetResponse.json()
    const fleetBody = fleetPayload?.result?.data?.json ?? fleetPayload?.result?.data
    if (!fleetBody || !Array.isArray(fleetBody.machines)) {
      throw new Error('updates.fleet omitted its machine snapshot')
    }
    if (fleetBody.appVersion !== serverVersion) {
      throw new Error(
        `settings authority disagrees with /version: ${fleetBody.appVersion} != ${serverVersion}`,
      )
    }
    const pageVersion = (
      await page.locator('meta[name="podium-version"]').getAttribute('content')
    )?.trim()
    if (!pageVersion) throw new Error('running interface omitted its podium-version stamp')
    const expectedComponents = new Map<string, string>([
      ['server', serverVersion],
      ['interface', pageVersion],
    ])
    if (fleetBody.servedMobileWeb?.present && fleetBody.servedMobileWeb.appVersion) {
      expectedComponents.set('phone', fleetBody.servedMobileWeb.appVersion)
    }
    const distinctComponentVersions = new Set(expectedComponents.values())
    if (distinctComponentVersions.size === 1) {
      await collapsed.waitFor()
      if ((await collapsed.count()) !== 1 || (await collapsed.innerText()).trim() !== shownServer) {
        throw new Error('agreeing component versions did not collapse to the authoritative version')
      }
    } else {
      await breakdown.waitFor()
      for (const [component, rawVersion] of expectedComponents) {
        const row = breakdown.getByTestId(`component-version-${component}`)
        const shown = formatDisplayedVersion(rawVersion)
        if (!(await row.innerText()).includes(shown)) {
          throw new Error(`${component} display disagrees with its artifact: ${shown}`)
        }
      }
    }
    for (const machine of ['source', 'fleet-a', 'fleet-b']) {
      const apiMachine = fleetBody.machines.find(
        (candidate: { name?: string }) => candidate.name === machine,
      )
      if (!apiMachine || apiMachine.version !== target) {
        throw new Error(`${machine} API version disagrees with expected installed target ${target}`)
      }
      const text = texts.find((candidate) => candidate.includes(machine))
      const shown = formatDisplayedVersion(apiMachine.version)
      if (!text || !text.includes(shown)) {
        throw new Error(`${machine} display disagrees with its API version ${shown}`)
      }
    }
    if (screenshot) await settings.screenshot({ path: screenshot })
    console.log(
      JSON.stringify({
        serverVersion,
        target,
        machines: ['source', 'fleet-a', 'fleet-b'],
      }),
    )
  } else {
    throw new Error(`unknown UI probe mode: ${mode}`)
  }
} catch (error) {
  if (page) {
    console.error(`url=${page.url()}`)
    try {
      console.error(`body=${(await page.locator('body').innerText()).slice(0, 4_000)}`)
    } catch (bodyError) {
      console.error(`body-capture-failed=${String(bodyError)}`)
    }
    if (screenshot) {
      await page.screenshot({ path: screenshot, fullPage: true }).catch((screenshotError) => {
        console.error(`screenshot-capture-failed=${String(screenshotError)}`)
      })
    }
  }
  throw error
} finally {
  await browser.close()
}
