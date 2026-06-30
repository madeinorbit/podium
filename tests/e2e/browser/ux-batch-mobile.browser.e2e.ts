import { expect, test } from '@playwright/test'
import { newSession, openApp } from './_harness'

/**
 * Mobile-only runtime check for the UX batch. The harness registers THIS worktree,
 * whose branch (worktree-ux-batch-2026-06-30) is long enough to overflow the mobile
 * header's branch trigger without the #14 fix.
 */
test.skip(({ isMobile }) => !isMobile, 'mobile layout only')

test('#14 a long branch name stays bounded + ellipsized in the mobile header', async ({ page }) => {
  await openApp(page)
  await newSession(page, 'Claude')

  // The branch trigger button (opens the worktree picker) shows repo + branch + ▾.
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          [...document.querySelectorAll('button')].some((b) =>
            /worktree-ux-batch/.test(b.textContent ?? ''),
          ),
        ),
      { timeout: 15_000 },
    )
    .toBe(true)

  const m = await page.evaluate(() => {
    const t = [...document.querySelectorAll('button')].find((b) =>
      /worktree-ux-batch/.test(b.textContent ?? ''),
    )
    if (!t) return null
    const r = t.getBoundingClientRect()
    // The branch line span carries `truncate` (overflow:hidden); it should be
    // clipped (scrollWidth > clientWidth) rather than overflowing the header.
    const span = [...t.querySelectorAll('span')].find(
      (s) => /worktree-ux-batch/.test(s.textContent ?? '') && getComputedStyle(s).overflow === 'hidden',
    )
    return {
      right: r.right,
      vw: window.innerWidth,
      width: r.width,
      clipped: span ? span.scrollWidth > span.clientWidth : false,
    }
  })

  expect(m).not.toBeNull()
  if (!m) return
  // Stays within the viewport (doesn't break/overflow the header)...
  expect(m.right).toBeLessThanOrEqual(m.vw + 1)
  // ...bounded to ~45% of the header width...
  expect(m.width).toBeLessThanOrEqual(m.vw * 0.47)
  // ...and the long branch is actually ellipsized, not overflowing.
  expect(m.clipped).toBe(true)
})
