import { type APIRequestContext, expect, test } from '@playwright/test'
import { RELAY } from './_harness'

/**
 * POD-781 — a grip drop lands where it was dropped, and does not snap back.
 *
 * The reorder used to hold a hand-rolled DOM preview after the drop (transforms
 * kept applied, cleared when the store echoed a new order or after 1500ms) —
 * a fourth optimism mechanism beside the outbox-as-overlay. That preview is
 * gone: the drop enqueues `issues.update{sortKey}` through the overlay, which
 * repaints the derived order immediately. Pointer-event routing is the one thing
 * a code read cannot settle, so this drives it.
 */
test.skip(({ isMobile }) => isMobile, 'desktop verification: the grip is desktop-only')

const HTTP = RELAY.replace(/^ws/, 'http')

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  // A GET query carries its input in `?input=<json>` — omitting it entirely is a
  // BAD_REQUEST for any procedure whose schema is an object, even an all-optional
  // one.
  const res =
    method === 'post'
      ? await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
      : await request.get(
          `${HTTP}/trpc/${proc}?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`,
        )
  if (!res.ok()) throw new Error(`${proc} → ${res.status()}: ${await res.text()}`)
  const body = (await res.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

test('a dropped row stays where it was dropped', async ({ page, request }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 900 })

  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos[0]
  if (!repoPath) throw new Error('harness registered no repo')
  const stamp = Date.now().toString(36)
  const title = (n: number) => `Drag smoke ${stamp} #${n}`
  await rpc(request, 'issues.create', { repoPath, title: title(1), startNow: true })
  await rpc(request, 'issues.create', { repoPath, title: title(2), startNow: true })

  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  const aside = page.locator('aside').first()
  const rowFor = (n: number) =>
    aside
      .getByTestId('unified-issue-row')
      .filter({ hasText: title(n) })
      .first()
  for (const n of [1, 2]) await expect(rowFor(n)).toBeVisible({ timeout: 60_000 })

  /** The drag scope holding our two rows, read as its live `data-drag-key` order. */
  const scopeOrder = () =>
    page.evaluate((needle: string) => {
      const scopes = [...document.querySelectorAll<HTMLElement>('[data-drag-scope]')]
      const scope = scopes.find((el) => el.textContent?.includes(needle))
      if (!scope) throw new Error('no drag scope holds the seeded rows')
      return [...scope.children]
        .filter((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.dragKey)
        .map((el) => el.dataset.dragKey as string)
    }, `Drag smoke ${stamp}`)

  const before = await scopeOrder()
  expect(before.length).toBeGreaterThanOrEqual(2)
  const [first, second] = before as [string, string]

  // Drag the TOP row's grip past the second row's midpoint and release.
  const grip = aside.locator(`[data-drag-key="${first}"] [data-testid="row-grip"]`)
  await grip.waitFor({ state: 'attached' })
  const gripBox = await grip.boundingBox()
  const targetBox = await aside.locator(`[data-drag-key="${second}"]`).boundingBox()
  if (!gripBox || !targetBox) throw new Error('grip or target row not measurable')
  const x = gripBox.x + gripBox.width / 2
  const y = gripBox.y + gripBox.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  const drop = targetBox.y + targetBox.height * 0.8
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(x, y + ((drop - y) * step) / 8)
  }

  // PER-FRAME sampling across the drop, because the thing being measured is a
  // FLASH: the retired preview held the transforms so the row could not show its
  // old position for even one painted frame, and the claim now is that the
  // overlay repaints fast enough not to need that. A rAF callback runs before its
  // frame is painted, so each sample is one frame that reached the screen.
  await page.evaluate((needle: string) => {
    const scopes = [...document.querySelectorAll<HTMLElement>('[data-drag-scope]')]
    const scope = scopes.find((el) => el.textContent?.includes(needle))
    if (!scope) throw new Error('no drag scope holds the seeded rows')
    const probe = window as unknown as { __dragFrames: string[]; __dragUpFrame: number }
    const frames: string[] = []
    probe.__dragFrames = frames
    // The frame the DROP happened in, marked from inside the page. Counting from
    // when this probe was armed instead would bill the driver's own
    // event-dispatch round trip to the repaint.
    probe.__dragUpFrame = -1
    window.addEventListener('pointerup', () => {
      probe.__dragUpFrame = frames.length
    }, { once: true, capture: true })
    const tick = (): void => {
      // ORDER *AND* whether the dragged row is still transformed, because that
      // pair is what the eye sees: the pre-drop order under a held transform is
      // the row sitting where it was dropped, while the pre-drop order with the
      // transform gone is the snap-back this must never show.
      const rows = [...scope.children].filter(
        (el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.dragKey,
      )
      const held = rows.some((el) => el.style.transform !== '')
      frames.push(`${rows.map((el) => el.dataset.dragKey as string).join()}|${held ? 'T' : '-'}`)
      if (frames.length < 90) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, `Drag smoke ${stamp}`)
  await page.mouse.up()

  // From the instant of the drop: the new order must appear and then HOLD. A
  // snap-back — the state this issue's overlay replaced a bespoke preview to
  // prevent — shows up as the original order reappearing after it landed.
  // COLLECTED FIRST, asserted after, so a failure prints the whole series and the
  // server's own answer beside it rather than the first sample that disagreed.
  const expected = [second, first, ...before.slice(2)]
  const samples: string[] = []
  for (let i = 0; i < 90; i += 1) {
    samples.push((await scopeOrder()).join())
    await page.waitForTimeout(30)
  }
  const { frames, upFrame } = await page.evaluate(() => {
    const probe = window as unknown as { __dragFrames: string[]; __dragUpFrame: number }
    return { frames: probe.__dragFrames, upFrame: probe.__dragUpFrame }
  })
  const serverKeys = await rpc<{ id: string; sortKey?: string }[]>(
    request,
    'issues.list',
    {},
    'get',
  )
    .then((issues) => {
      const byId = new Map(issues.map((i) => [i.id, i.sortKey]))
      return { moved: byId.get(first), other: byId.get(second) } as unknown
    })
    .catch((error: unknown) => `unreadable: ${String(error)}`)
  const landedAt = samples.indexOf(expected.join())
  const revertedAt = landedAt < 0 ? -1 : samples.findIndex((s, i) => i > landedAt && s !== expected.join())
  const evidence =
    `landed@${landedAt} reverted@${revertedAt} upFrame@${upFrame} | server sortKeys ${JSON.stringify(serverKeys)}` +
    ` | frames ${JSON.stringify(frames.slice(0, 16))}` +
    ` | samples ${JSON.stringify(samples.filter((s, i) => i === 0 || s !== samples[i - 1]))}`
  console.log(`[POD-781] ${evidence}`)

  expect(landedAt, `never landed — ${evidence}`).toBeGreaterThanOrEqual(0)
  expect(revertedAt, `snapped back — ${evidence}`).toBe(-1)

  // How many PAINTED frames after the drop still showed the pre-drop order. A rAF
  // callback runs before its frame is painted, so each one is a frame that
  // reached the screen. The retired preview existed to make this number zero by
  // holding a transform; the claim now is that the overlay repaints inside a
  // couple of frames, which is a repaint rather than a snap-back.
  expect(upFrame, `no pointerup seen — ${evidence}`).toBeGreaterThanOrEqual(0)
  // THE INVARIANT: not one painted frame between the release and the repaint
  // showed the pre-drop order with the gesture's transform already dropped. That
  // pair is the snap-back; either half alone is not (the pre-drop order UNDER a
  // held transform is the row sitting where it was dropped, and the new order
  // under a transform is `motion`'s layout animation carrying it there).
  const snapped = frames.filter((f, i) => i > upFrame && f === `${before.join()}|-`)
  expect(snapped.length, `painted the pre-drop order untransformed — ${evidence}`).toBe(0)
  // …and the repaint is a repaint, not a wait: a handful of frames, not the round
  // trip the retired preview used to cover. Loose on purpose — the exact count is
  // in the log line above, and a tight bound on a shared CI host is a flake.
  const repainted = frames.findIndex((f) => f.startsWith(`${expected.join()}|`))
  expect(repainted, `never repainted in the new order — ${evidence}`).toBeGreaterThan(-1)
  expect(repainted - upFrame, `slow repaint — ${evidence}`).toBeLessThanOrEqual(6)

  // …and the write really went out, rather than the client painting to itself.
  await expect
    .poll(
      async () => {
        const issues = await rpc<{ id: string; sortKey?: string }[]>(
          request,
          'issues.list',
          {},
          'get',
        )
        const byId = new Map(issues.map((i) => [i.id, i.sortKey]))
        const a = byId.get(second)
        const b = byId.get(first)
        return a !== undefined && b !== undefined && a < b
      },
      { timeout: 15_000 },
    )
    .toBe(true)
})
