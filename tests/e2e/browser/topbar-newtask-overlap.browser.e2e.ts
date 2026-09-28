import { expect, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * POD-4718: at 1280x900 the Tasks toolbar overflowed its topbar slot and the
 * host-indicator well painted over the overflow, so the New Task button sat
 * under a span inside `.header-host-indicators` and no click reached it.
 * Only a real browser can hold this line: jsdom reports no layout, so every
 * box below measures zero there and the overlap is invisible.
 *
 * Desktop-only: the command bar (and its slot/well zones) is a desktop-shell
 * layout; the mobile shell renders no topbar.
 */
test.skip(({ isMobile }) => isMobile, 'desktop test (no command bar on mobile)')

// Cold first-sync on a loaded shared host can take most of a minute before
// the shell mounts; the lane default (30s) false-reds the boot waits below.
test.setTimeout(120_000)

interface WellGeometry {
  hosts: number
  slotScroll: number
  slotClient: number
  wellNeed: number
  wellClient: number
  overlaps: boolean
  hit: string
  insideButton: boolean
}

test('tasks toolbar never slides under the host-indicator well at 1280x900', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
  await expect(async () => {
    await page.getByTestId('topbar-nav-issues').click({ timeout: 5_000 })
    await page.locator('[data-testid="issues-new-task"]').waitFor({ state: 'visible', timeout: 3_000 })
  }).toPass({ timeout: 30_000 })

  // Measurements from the natural well up to a deliberately overfull one,
  // taken atomically in a single evaluate: the harness backend reports one
  // host, so wider wells come from cloning the real machine chip — the
  // contract under test is that the slot holds at ANY well width, and cloning
  // exercises exactly that without waiting on backend state. Atomicity matters
  // because a store tick re-render between two evaluates would wipe the
  // clones. With the word-shedding rungs active, 1–3 hosts fit at 1280
  // anyway, so the loop runs to at least 8 hosts: only an overfull well
  // exercises the floor that makes the fix structural.
  //
  // "Overfull" is measured as content need, not well scrollWidth: the chips
  // themselves shrink (flex, min-width 0), so clones pile up inside the box
  // and the well's own scrollWidth can never exceed its box by much. Each
  // chip's scrollWidth is its unmet need (chips clip nothing internally), so
  // the summed need against the box is the honest overfullness.
  const spans = await page.evaluate(() => {
    const slot = document.querySelector('[data-testid="topbar-slot"]') as HTMLElement | null
    const btn = document.querySelector('[data-testid="issues-new-task"]') as HTMLElement | null
    const well = document.querySelector('.header-host-indicators') as HTMLElement | null
    if (!slot || !btn || !well) return null
    const chipsOf = () => {
      const machines = well.querySelectorAll('.header-machine-chip')
      return machines.length > 0 ? [...machines] : [...well.querySelectorAll(':scope > button')]
    }
    const donor = chipsOf()[0] as Element | undefined
    if (!donor) return { error: 'no host chip to clone' } as const
    const measure = () => {
      const chips = chipsOf() as HTMLElement[]
      const b = btn.getBoundingClientRect()
      const w = well.getBoundingClientRect()
      const atPoint = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
      return {
        hosts: chips.length,
        slotScroll: slot.scrollWidth,
        slotClient: slot.clientWidth,
        wellNeed: chips.reduce((sum, chip) => sum + chip.scrollWidth, 0),
        wellClient: well.clientWidth,
        overlaps: b.left < w.right && b.right > w.left && b.top < w.bottom && b.bottom > w.top,
        hit: atPoint
          ? `${atPoint.tagName}.${String((atPoint as HTMLElement).className ?? '').slice(0, 120)}`
          : 'null',
        insideButton: !!atPoint?.closest?.('[data-testid="issues-new-task"]'),
      }
    }
    const rows = [measure()]
    for (let i = 0; i < 10; i++) {
      well.appendChild(donor.cloneNode(true))
      rows.push(measure())
      if (rows[rows.length - 1].hosts >= 8) break
    }
    return rows
  })
  expect(spans).not.toBeNull()
  const rows = spans as WellGeometry[]
  expect(rows.length).toBeGreaterThan(1)
  const overfull = rows[rows.length - 1]
  // The setup did what it claims: at least 8 hosts whose summed need dwarfs
  // the well's box — so a pass below is a held line rather than a vacuous one.
  expect(overfull.hosts).toBeGreaterThanOrEqual(8)
  expect(
    overfull.wellNeed,
    `the well is overfull (need ${overfull.wellNeed} vs box ${overfull.wellClient})`,
  ).toBeGreaterThan(overfull.wellClient + 200)
  for (const row of rows) {
    // The toolbar fits its slot at every well width: nothing spills past the
    // slot's right edge for the well to cover, even overfull.
    expect(
      row.slotScroll,
      `the tasks toolbar fits its topbar slot with ${row.hosts} host(s) in the well`,
    ).toBeLessThanOrEqual(row.slotClient + 1)
    // The button and the well do not overlap at all, and the click point
    // hit-tests to the button itself — the exact failure Playwright reported
    // as "intercepts pointer events".
    expect(row.overlaps, `no overlap with ${row.hosts} host(s)`).toBe(false)
    expect(row.insideButton, `click point hits the button with ${row.hosts} host(s), not the well (hit ${row.hit})`).toBe(
      true,
    )
  }

  // And the click itself lands: the composer opens.
  await page.getByRole('button', { name: 'New Task', exact: true }).click({ timeout: 10_000 })
  await expect(page.getByRole('dialog').getByRole('heading', { name: 'New Task' })).toBeVisible({
    timeout: 10_000,
  })
  await page.keyboard.press('Escape')
})
