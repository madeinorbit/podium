import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * SESSION ROWS SHOW WHO ACTED AND FOR WHOM, REAL-CLICKED (POD-1526).
 *
 * The unit suite (`sidebar-common.attribution.test.tsx`) renders `PanelRow`
 * directly, which proves the component but not that the SIDEBAR still mounts it
 * on a real session that a real server stamped. This spec closes that gap end to
 * end: nothing here hand-sets `createdBy` — the fixture creates both sessions
 * through the real `createSession` and the SERVER derives the pair from the
 * binding principal (ADR 3 D7), so what the browser paints came off the wire.
 *
 * THE DELEGATED ROW IS THE LOAD-BEARING ASSERTION. Its actor is an agent and its
 * on-behalf-of is the delegating human — two DIFFERENT values — so a renderer
 * that collapsed the pair to one value would fail here. The host row beside it
 * is the user-acting-for-themselves case, which puts the same id in both halves
 * and therefore cannot prove anything about collapse; it is asserted only for
 * presence, and is marked as such so nobody later mistakes it for the guard.
 *
 * FIXTURE: `PODIUM_E2E_SESSION_ATTRIBUTION=1` on the harness server (see
 * tests/e2e/serve-harness.ts). Without it there are no attribution rows on
 * screen, so this spec FAILS with a named reason rather than passing silently.
 */
test.skip(({ isMobile }) => isMobile, 'desktop sidebar verification')

test('a delegated session row shows the acting agent AND the human it acted for', async ({
  page,
}) => {
  // The config's 30s default is a per-TEST cap, and this test cold-starts the
  // whole stack: the sidebar's first paint waits on a repo discovery pass that
  // has been measured at 8s on a loaded box. Generous per-assertion timeouts
  // below mean nothing without this — the run that found it died at 30s with
  // every individual wait still well inside its own budget.
  test.setTimeout(180_000)
  test.fail(
    process.env.PODIUM_E2E_SESSION_ATTRIBUTION !== '1',
    'needs PODIUM_E2E_SESSION_ATTRIBUTION=1 on the harness server — without it there are no attribution rows to read',
  )
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  const aside = page.locator('aside').first()
  await aside.waitFor({ state: 'visible', timeout: 60_000 })

  const issueRow = aside
    .getByTestId('unified-issue-row')
    .filter({ hasText: 'Session attribution rows' })
    .first()
  // PATIENT BY NECESSITY, not by superstition. The harness answers /health as
  // soon as the server listens, which is BEFORE this fixture's sessions exist:
  // both spawns retry against races that resolve on their own schedule (the
  // daemon's harness inventory, then the parent's minted binding), so the rows
  // can arrive tens of seconds after the page does. Waiting for them is correct;
  // a shorter budget here just reports "no rows" for a fixture still building.
  await expect(issueRow).toBeVisible({ timeout: 120_000 })

  // REAL CLICK: the agent roster folds behind the row's chevron, so the pair is
  // only on screen once a user expands the issue — which is exactly the gesture
  // this spec has to make rather than assume.
  const expand = issueRow.getByRole('button', { name: /^Expand / })
  if (await expand.isVisible().catch(() => false)) await expand.click()

  // The roster band carries the session rows; both fixture sessions live here.
  const rows = issueRow.locator('[data-session]')
  await expect(rows).toHaveCount(2, { timeout: 30_000 })

  // Every row carries a pair, because the server stamps unconditionally.
  const pairs = issueRow.getByTestId('attribution-pair')
  await expect(pairs).toHaveCount(2)

  // THE GUARD: the delegated row is the one whose two halves DIFFER. Found by
  // that property rather than by name, so the spec is asserting the delegation
  // itself and not a label the fixture happened to choose.
  const delegated = issueRow
    .locator('[data-session]')
    .filter({ has: page.getByTestId('attribution-pair') })
    .filter({ hasNotText: 'Attribution host' })
    .first()
  const actor = delegated.getByTestId('attribution-actor')
  const onBehalfOf = delegated.getByTestId('attribution-on-behalf-of')
  await expect(actor).toBeVisible()
  await expect(onBehalfOf).toBeVisible()

  const actorText = ((await actor.textContent()) ?? '').trim()
  const behalfText = ((await onBehalfOf.textContent()) ?? '').trim()
  expect(actorText.length).toBeGreaterThan(0)
  // "for <human>" — a real delegating human, not the machine/system "no human".
  expect(behalfText).toMatch(/^for \S/)
  // The pair did NOT collapse: the human half does not merely restate the actor.
  expect(behalfText).not.toContain(actorText)

  if (process.env.PODIUM_E2E_ATTRIBUTION_SHOT)
    await issueRow.screenshot({ path: process.env.PODIUM_E2E_ATTRIBUTION_SHOT })

  // Real click: selecting the delegated row opens it, and the attribution
  // survives the row becoming the ACTIVE row (a state that restyles it).
  await delegated.click()
  await expect(delegated).toHaveAttribute('data-session', /.+/)
  await expect(delegated.getByTestId('attribution-actor')).toHaveText(actorText)
  await expect(delegated.getByTestId('attribution-on-behalf-of')).toHaveText(behalfText)
})
