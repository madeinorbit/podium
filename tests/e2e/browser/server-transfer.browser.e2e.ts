import { expect, type Page, test } from '@playwright/test'
import { makeTrpc } from '../../../apps/web/src/app/trpc'
import { RELAY } from './_harness'

test.skip(
  ({ isMobile }) => isMobile,
  'desktop test — Settings navigation and the compact machine-row action are desktop surfaces',
)
test.describe.configure({ timeout: 90_000 })

const HTTP = RELAY.replace(/^ws/, 'http')
const PUBLIC_URL = 'https://new-podium.example.com'
const CONFIRMATION = 'TRANSFER SERVER'

function trpcJson(data: unknown) {
  return [{ result: { data } }]
}

async function openMachines(page: Page): Promise<void> {
  await page.addInitScript(() => {
    ;(window as Window & { __PODIUM_SKIP_SETUP__?: boolean }).__PODIUM_SKIP_SETUP__ = true
  })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 45_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 15_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Machines', exact: true }).click()
  await expect(settings.getByRole('heading', { name: 'Machines', exact: true })).toBeVisible()
}

test('clicks Make server and follows proof-backed status through Connected', async ({ page }) => {
  const trpc = makeTrpc(HTTP)
  await expect
    .poll(async () => (await trpc.machines.list.query()).length, { timeout: 20_000 })
    .toBeGreaterThan(0)
  const machines = await trpc.machines.list.query()
  const target = machines[0]
  if (!target) throw new Error('branch harness did not expose its host machine')

  let started = false
  let statusAfterStart = 0
  let submittedBody = ''
  const transferStates = [
    {
      state: 'preparing',
      phase: 'preparing',
      sourceFenced: false,
      targetProof: false,
      sourceConnected: false,
    },
    {
      state: 'staged',
      phase: 'copying',
      sourceFenced: false,
      targetProof: false,
      sourceConnected: false,
    },
    {
      state: 'validated',
      phase: 'validating',
      sourceFenced: false,
      targetProof: false,
      sourceConnected: false,
    },
    {
      state: 'source-fenced',
      phase: 'switching',
      sourceFenced: true,
      targetProof: false,
      sourceConnected: false,
    },
    {
      state: 'committed',
      phase: 'switching',
      sourceFenced: true,
      targetProof: true,
      sourceConnected: false,
    },
    {
      state: 'committed',
      phase: 'connected',
      sourceFenced: true,
      targetProof: true,
      sourceConnected: true,
    },
  ] as const

  await page.context().route(/machines\.serverTransferStatus/, async (route) => {
    const phase = started
      ? transferStates[Math.min(Math.floor(statusAfterStart++ / 2), transferStates.length - 1)]
      : undefined
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        trpcJson({
          sourceMachineId: 'e2e-source-server',
          targetEligibility: [{ targetMachineId: target.id, eligible: true }],
          transfer: phase
            ? {
                targetMachineId: target.id,
                transferId: 'transfer-e2e',
                publicUrl: PUBLIC_URL,
                ...phase,
              }
            : null,
        }),
      ),
    })
  })

  await page.context().route(/machines\.transferServer/, async (route) => {
    submittedBody = route.request().postData() ?? ''
    started = true
    // Deliberately claim committed here. The UI must ignore this acknowledgement
    // and remain on Preparing until serverTransferStatus supplies real proof.
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        trpcJson({
          ok: true,
          transferId: 'transfer-e2e',
          state: 'committed',
          targetMachineId: target.id,
          publicUrl: PUBLIC_URL,
        }),
      ),
    })
  })

  await openMachines(page)

  // Pairing cancellation is UI-only: opening and closing the pairing flow must
  // not start a transfer or mutate the current server.
  // Pairing takes over the Settings pane rather than stacking a dialog on the
  // sheet, and Escape returns to the machine list without closing Settings.
  await page.getByRole('button', { name: 'Add machine' }).click()
  const pairing = page.getByRole('region', { name: 'Add a machine' })
  await expect(pairing).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(pairing).toBeHidden()
  await expect(page.getByRole('button', { name: 'Add machine' })).toBeVisible()
  expect(started).toBe(false)
  expect(submittedBody).toBe('')

  const makeServer = page.getByRole('button', { name: 'Make server' })
  await expect(makeServer).toHaveCount(1)
  await makeServer.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(`Move the server from the current server to ${target.name}?`)
  const submit = dialog.getByRole('button', { name: 'Transfer server' })
  await expect(dialog.getByLabel('New public URL')).toHaveValue('')
  await expect(submit).toBeDisabled()

  await dialog.getByLabel('New public URL').fill(PUBLIC_URL)
  await expect(submit).toBeDisabled()
  await dialog.getByLabel('Server transfer confirmation').fill('transfer server')
  await expect(submit).toBeDisabled()
  await dialog.getByLabel('Server transfer confirmation').fill(CONFIRMATION)
  await expect(submit).toBeEnabled()
  await submit.click()

  await expect.poll(() => submittedBody).toContain(PUBLIC_URL)
  await expect.poll(() => submittedBody).toContain(CONFIRMATION)

  for (const label of ['Preparing', 'Copying', 'Validating', 'Switching']) {
    await expect(dialog.locator('[data-transfer-state="active"]')).toHaveText(label, {
      timeout: 10_000,
    })
  }
  await expect(
    dialog.getByText(/proved it is serving and the previous server reconnected/i),
  ).toBeVisible({
    timeout: 10_000,
  })
  await expect(dialog.locator('[data-transfer-phase="connected"]')).toHaveAttribute(
    'data-transfer-state',
    'complete',
  )

  if (process.env.POD_1752_SHOT) {
    await page.screenshot({ path: process.env.POD_1752_SHOT, fullPage: false })
  }
})
