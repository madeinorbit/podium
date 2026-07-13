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

test('mobile chat view: the native key bar / toolbar are NOT shown (chat uses the OS keyboard)', async ({
  page,
}) => {
  await openApp(page)
  await newSession(page, 'Claude') // claude-code is chatCapable, so the toggle is offered
  // Switch to the chat view.
  await page.locator('button[aria-label="Switch to chat view"]').click()
  await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 20_000 })

  // The on-screen terminal key rows (Submit/arrows/voice + the Ctrl/Esc toolbar)
  // belong to the NATIVE terminal. In chat mode they must be hidden — the composer
  // uses the OS soft keyboard directly.
  await expect(page.locator('.key-actions:visible')).toHaveCount(0)
  await expect(page.locator('.toolbar:visible')).toHaveCount(0)

  // The composer footer's bottom inset is wired to --kb-open so the iOS home-indicator
  // safe area collapses while the keyboard is open (no dead gap under the input).
  const usesKbOpen = await page.evaluate(() => {
    const ta = document.querySelector('textarea')
    let el: HTMLElement | null = ta as HTMLElement | null
    while (el && !/var\(--kb-open/.test(el.style.paddingBottom || getComputedStyle(el).paddingBottom)) {
      el = el.parentElement
    }
    // Fall back to scanning the footer's inline class for the token (computed style
    // resolves the calc, so check the source class on the footer ancestor).
    return [...document.querySelectorAll('div')].some((d) =>
      /\(--kb-open/.test(d.getAttribute('class') ?? ''),
    )
  })
  expect(usesKbOpen).toBe(true)
})
