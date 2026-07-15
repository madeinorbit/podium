import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { RELAY } from './_harness'

/**
 * #64/#68 preview corrections, verified against the real Live UI:
 *
 * 1. ORDER — within a project group the work list reads newest-created first
 *    (immutable creation order) and MUST NOT reorder when agents start
 *    working or ask for the human: attention is carried per-row (square
 *    language / amber pill), never by reordering.
 * 2. GEOMETRY — the exact expanded-sidebar values from the handoff (1a/1b):
 *    262px default column, 3px list rhythm, borderless rows at 5px 8px with
 *    the 8px inner gap and 26px squares, the selected row growing its 1px
 *    border + 6px padding and the bridge notch, 8.5px mono group label,
 *    divider and footer spacing.
 */
test.skip(({ isMobile }) => isMobile, 'desktop verification: the expanded sidebar is desktop-only')

const HTTP = RELAY.replace(/^ws/, 'http')
const HOOKS_DIR = join(harnessEnv(Number(process.env.PORT ?? 8799)).stateDir, 'hooks')

async function rpc<T>(
  request: APIRequestContext,
  proc: string,
  input?: unknown,
  method: 'post' | 'get' = 'post',
): Promise<T> {
  const res =
    method === 'post'
      ? await request.post(`${HTTP}/trpc/${proc}`, { data: input ?? {} })
      : await request.get(`${HTTP}/trpc/${proc}`)
  if (!res.ok()) throw new Error(`${proc} → ${res.status()}: ${await res.text()}`)
  const body = (await res.json()) as { result?: { data?: T } }
  return body.result?.data as T
}

interface SeededIssue {
  id: string
  seq: number
}

async function hookSettingsFiles(): Promise<Set<string>> {
  return new Set(await readdir(HOOKS_DIR).catch(() => []))
}

async function newHookUrl(existing: Set<string>): Promise<string | undefined> {
  const files = await hookSettingsFiles()
  const settingsFile = [...files].find((file) => !existing.has(file))
  if (!settingsFile) return undefined
  const settings = await readFile(join(HOOKS_DIR, settingsFile), 'utf8')
  return settings.match(/"url":\s*"([^"]+\/hooks\/[^"]+)"/)?.[1]
}

async function openShell(page: Page): Promise<void> {
  await page.goto(`/?server=${RELAY}&e2e=1`)
  await page.waitForFunction(() => !document.querySelector('.app-loading'), undefined, {
    timeout: 60_000,
  })
  await page.locator('aside').first().waitFor({ state: 'visible', timeout: 60_000 })
}

test('newest-first creation order holds while agents work; exact expanded geometry', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 900 })

  // ---- Seed three issues in creation order; the OLDEST gets a driveable
  // agent (hook endpoint) so we can flip its phase later. ----
  const repos = await rpc<string[]>(request, 'repos.list', undefined, 'get')
  const repoPath = repos[0]
  if (!repoPath) throw new Error('harness registered no repo')
  const stamp = Date.now().toString(36)
  const title = (n: number) => `Order smoke ${stamp} #${n}`

  const preexistingHooks = await hookSettingsFiles()
  await rpc<SeededIssue>(request, 'issues.create', {
    repoPath,
    title: title(1),
    startNow: true,
  })
  let oldestHookUrl: string | undefined
  await expect
    .poll(async () => {
      oldestHookUrl = await newHookUrl(preexistingHooks)
      return oldestHookUrl
    })
    .toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\//)
  await rpc<SeededIssue>(request, 'issues.create', { repoPath, title: title(2), startNow: true })
  await rpc<SeededIssue>(request, 'issues.create', { repoPath, title: title(3), startNow: true })

  await openShell(page)
  const aside = page.locator('aside').first()
  const rowFor = (n: number) =>
    aside
      .getByTestId('unified-issue-row')
      .filter({ hasText: title(n) })
      .first()
  for (const n of [1, 2, 3]) await expect(rowFor(n)).toBeVisible({ timeout: 30_000 })

  /** Our three rows' seeding numbers in on-screen top-to-bottom order. */
  const onScreenOrder = async (): Promise<number[]> => {
    const entries: { n: number; y: number }[] = []
    for (const n of [1, 2, 3]) {
      const box = await rowFor(n).boundingBox()
      if (!box) throw new Error(`row ${n} not measurable`)
      entries.push({ n, y: box.y })
    }
    return entries.sort((a, b) => a.y - b.y).map((e) => e.n)
  }

  // ---- 1 · Newest-created first. ----
  expect(await onScreenOrder()).toEqual([3, 2, 1])

  // ---- The OLDEST issue's agent starts working: order must hold. ----
  const working = await fetch(oldestHookUrl as string, {
    method: 'POST',
    body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'e2e working' }),
  })
  expect(working.ok).toBe(true)
  await expect(rowFor(1).locator('[data-phase]').first()).toHaveAttribute('data-phase', 'working', {
    timeout: 15_000,
  })
  expect(await onScreenOrder()).toEqual([3, 2, 1])

  // ---- …then needs the human (classic float-to-top trigger): still holds. ----
  const asking = await fetch(oldestHookUrl as string, {
    method: 'POST',
    body: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'e2e: still at the bottom?' }] },
    }),
  })
  expect(asking.ok).toBe(true)
  await expect(rowFor(1).locator('[data-phase]').first()).toHaveAttribute('data-phase', 'waiting', {
    timeout: 15_000,
  })
  await expect(rowFor(1).getByRole('img', { name: '1 waiting on you' })).toBeVisible()
  expect(await onScreenOrder()).toEqual([3, 2, 1])

  // ---- 2 · Geometry (handoff 1a/1b exact values). ----
  const style = (locator: ReturnType<typeof rowFor>, props: string[]) =>
    locator.evaluate(
      (el, keys) =>
        Object.fromEntries(
          keys.map((k) => [k, getComputedStyle(el as HTMLElement).getPropertyValue(k)]),
        ),
      props,
    )

  // Column: 262px default, aside border included.
  const asideBox = await aside.boundingBox()
  expect(Math.round(asideBox?.width ?? 0)).toBe(262)

  // 3px list rhythm: the scroll column's flex gap and the in-group row gap.
  const scroll = aside.getByTestId('work-scroll')
  expect((await style(scroll, ['row-gap']))['row-gap']).toBe('3px')
  const groupBox = await aside.getByTestId('project-group').first().boundingBox()
  expect(groupBox).not.toBeNull()
  const [top, second] = [await rowFor(3).boundingBox(), await rowFor(2).boundingBox()]
  if (!top || !second) throw new Error('rows not measurable')
  expect(Math.round(second.y - (top.y + top.height))).toBe(3)

  // Unselected row: borderless, 5px 8px padding, 8px flex gap, 36px tall.
  const plainRow = rowFor(3).locator('[data-phase]').first()
  const plain = await style(plainRow, [
    'padding-top',
    'padding-left',
    'border-top-width',
    'gap',
    'border-radius',
  ])
  expect(plain['padding-top']).toBe('5px')
  expect(plain['padding-left']).toBe('8px')
  expect(plain['border-top-width']).toBe('0px')
  expect(plain.gap).toBe('8px')
  expect(plain['border-radius']).toBe('7px')

  // Row heights must match a probe built from the handoff's exact inline
  // styles (26px square, 11.5px/10px two-line block at the font's natural
  // line height, 5px/6px padding, selected border) — self-calibrating against
  // the real Geist metrics.
  const probeHeights = await page.evaluate(() => {
    const build = (selected: boolean) => {
      const row = document.createElement('div')
      row.style.cssText = `position:absolute; visibility:hidden; display:flex; align-items:center; gap:8px; padding:${selected ? '6px' : '5px'} 8px; width:246px; font-family:'Geist Variable','Geist',sans-serif; line-height:normal;${selected ? ' border:1px solid #888;' : ''}`
      const square = document.createElement('span')
      square.style.cssText = 'width:26px; height:26px; flex:none;'
      const text = document.createElement('div')
      text.style.cssText = 'display:flex; flex-direction:column; gap:1px; min-width:0; flex:1;'
      const line1 = document.createElement('div')
      line1.style.cssText = 'font-size:11.5px; white-space:nowrap;'
      line1.textContent = 'Title'
      const line2 = document.createElement('div')
      line2.style.cssText = 'font-size:10px; white-space:nowrap;'
      line2.textContent = 'status'
      text.append(line1, line2)
      row.append(square, text)
      document.body.appendChild(row)
      const h = row.getBoundingClientRect().height
      row.remove()
      return h
    }
    return { plain: build(false), selected: build(true) }
  })
  expect(Math.round(top.height)).toBe(Math.round(probeHeights.plain))

  // Rows sit at the column's 8px right inset (aside border-box right − 1px
  // border − 8px padding).
  if (asideBox) {
    expect(Math.round(asideBox.x + asideBox.width - (top.x + top.width))).toBe(9)
  }

  // 26px ID square, 6.5px mono two-line label.
  const square = rowFor(3).getByRole('button', { name: /Set colour for issue #/ })
  const squareBox = await square.boundingBox()
  expect(Math.round(squareBox?.width ?? 0)).toBe(26)
  expect(Math.round(squareBox?.height ?? 0)).toBe(26)
  expect((await style(square, ['font-size']))['font-size']).toBe('6.5px')

  // 11.5px title / 10px status line.
  const titleSpan = rowFor(3).locator('button.flex-1 > span').first().locator('span').first()
  expect((await style(titleSpan, ['font-size']))['font-size']).toBe('11.5px')
  const statusSpan = rowFor(3).locator('button.flex-1 > span').nth(1)
  expect((await style(statusSpan, ['font-size']))['font-size']).toBe('10px')

  // Project label: mono 8.5px, .12em tracking, 4px/2px padding.
  const label = aside.getByTestId('project-group-label').first()
  const labelStyle = await style(label, [
    'font-size',
    'letter-spacing',
    'padding-left',
    'padding-bottom',
    'color',
  ])
  expect(labelStyle['font-size']).toBe('8.5px')
  expect(Number.parseFloat(labelStyle['letter-spacing'])).toBeCloseTo(8.5 * 0.12, 1)
  expect(labelStyle['padding-left']).toBe('4px')
  expect(labelStyle['padding-bottom']).toBe('2px')
  expect(labelStyle.color).toBe('rgb(122, 122, 134)')

  // Divider: hairline at 11px above / 9px below (handoff margins + 3px gaps).
  const divider = aside.getByTestId('sidebar-divider')
  const dividerStyle = await style(divider, ['margin-top', 'margin-bottom', 'height'])
  expect(dividerStyle['margin-top']).toBe('11px')
  expect(dividerStyle['margin-bottom']).toBe('9px')
  expect(dividerStyle.height).toBe('1px')

  // Footer: 8px top, 10px sides, 10px bottom (4px own + the column's 6px).
  const footer = aside.locator('.justify-around').last()
  const footerStyle = await style(footer, [
    'padding-top',
    'padding-left',
    'padding-bottom',
    'border-top-width',
  ])
  expect(footerStyle['padding-top']).toBe('8px')
  expect(footerStyle['padding-left']).toBe('10px')
  expect(footerStyle['padding-bottom']).toBe('10px')
  expect(footerStyle['border-top-width']).toBe('1px')

  // ---- Selected row grows the 1px border + 6px padding and the notch. ----
  await rowFor(3).locator('button.flex-1').first().click()
  const selected = rowFor(3).locator('[data-selected="true"]').first()
  await expect(selected).toBeVisible({ timeout: 10_000 })
  const sel = await style(selected, ['padding-top', 'border-top-width'])
  expect(sel['padding-top']).toBe('6px')
  expect(sel['border-top-width']).toBe('1px')
  const selBox = await selected.boundingBox()
  expect(Math.round(selBox?.height ?? 0)).toBe(Math.round(probeHeights.selected))
  const notch = rowFor(3).getByTestId('bridge-notch')
  await expect(notch).toBeVisible()
  const notchBox = await notch.boundingBox()
  expect(Math.round(notchBox?.width ?? 0)).toBe(10)
  if (asideBox && notchBox) {
    // Handoff-exact: from the row's 8px inset the notch tip lands flush with
    // the aside's OUTER edge — fully covering the 1px border, unclipped.
    expect(notchBox.x + notchBox.width).toBeGreaterThan(asideBox.x + asideBox.width - 0.1)
  }

  if (process.env.SIDEBAR_SHOT) {
    await aside.screenshot({ path: process.env.SIDEBAR_SHOT })
  }
})
