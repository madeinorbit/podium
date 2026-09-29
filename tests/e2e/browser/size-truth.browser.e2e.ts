import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import {
  type APIRequestContext,
  type BrowserContext,
  devices,
  expect,
  type Page,
  test,
} from '@playwright/test'
import { harnessEnv } from '../harness-env'
import { openApp, RELAY } from './_harness'

/**
 * THE SIZE INVARIANT, END TO END (POD-4773; POD-3190 design rev 3).
 *
 * After every event, three readings of one terminal's size agree:
 *
 *   KERNEL  the agent's real pty — `stty -F /dev/pts/N size`, N read from
 *           `/proc/<child>/fd/0`. Taken from OUTSIDE the system under test:
 *           not the host's SIZE, not a command run inside the agent.
 *   COPY    the server's copy — `sessions.list`'s `geometry`.
 *   GRID    every browser's xterm grid (`__podium.grid()`, the view itself,
 *           not the connection's idea of the server grid).
 *
 * Agreement alone would pass a system that never resizes anything: all three
 * sat at 80x24 happily on the base. So every row also names who drives, and
 * the kernel must end at the CONTROLLER's box — the last grid its mount
 * measured and stated (`ask:sent`, measured). The one exception is the row
 * where the host refuses the ask: there the view must keep the TRUE size.
 *
 * Then it POKES: a keystroke makes the agent write, and the readings must
 * still agree afterwards. The old redraw nudge restored its stale size on the
 * program's next output, so a check that never caused output could not see it.
 *
 * Real Claude on haiku (nothing is ever submitted). Needs, on the harness:
 *   PODIUM_E2E_REAL_AGENTS=1 PODIUM_E2E_CLAUDE_MODEL=haiku
 *   PODIUM_E2E_LINK_B_PROXY=1 PODIUM_E2E_DAEMON_RESTART_GAP_MS=4000
 *   PODIUM_HOST_SOCKET_DIR=<a private, short dir> (never the live hosts)
 */
test.skip(() => process.env.PODIUM_E2E_REAL_AGENTS !== '1', 'real-agent run only')
test.skip(({ isMobile }) => isMobile, 'the desktop project drives its own phone context')

const PORT = Number(process.env.PORT ?? 8799)
const HTTP = RELAY.replace(/^ws/, 'http')
const HOST_SOCKET_DIR = process.env.PODIUM_HOST_SOCKET_DIR?.replace(/\/+$/, '') ?? ''

interface Grid {
  cols: number
  rows: number
}
const show = (g: Grid | undefined): string => (g ? `${g.cols}x${g.rows}` : '—')
const same = (a: Grid | undefined, b: Grid | undefined): boolean =>
  a !== undefined && b !== undefined && a.cols === b.cols && a.rows === b.rows

// ---- the kernel, from outside ------------------------------------------------

/** The podium-host process serving this session's pty (not a --no-pty engine). */
function hostPid(sessionId: string): number | undefined {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    let argv: string[]
    try {
      argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0')
    } catch {
      continue
    }
    const at = argv.indexOf('--socket')
    const socket = at >= 0 ? (argv[at + 1] ?? '') : ''
    if (!socket.endsWith(`${sessionId}.sock`) || argv.includes('--no-pty')) continue
    // The harness must never reach the operator's live hosts.
    if (!socket.startsWith(`${HOST_SOCKET_DIR}/`)) {
      throw new Error(`session ${sessionId} runs under ${socket}, outside ${HOST_SOCKET_DIR}`)
    }
    return Number(entry)
  }
  return undefined
}

function hostSocket(sessionId: string): string | undefined {
  const pid = hostPid(sessionId)
  if (pid === undefined) return undefined
  const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
  return argv[argv.indexOf('--socket') + 1]
}

/** The agent: the host's child whose stdin is a pty. */
function child(sessionId: string): { pid: number; tty: string } | undefined {
  const host = hostPid(sessionId)
  if (host === undefined) return undefined
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    let stat: string
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
    } catch {
      continue
    }
    // `pid (comm) state ppid …` — comm may hold spaces and parens.
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
    if (ppid !== host) continue
    try {
      const tty = readlinkSync(`/proc/${entry}/fd/0`)
      if (tty.startsWith('/dev/pts/')) return { pid: Number(entry), tty }
    } catch {}
  }
  return undefined
}

function kernel(sessionId: string): { grid: Grid; pid: number } | undefined {
  const agent = child(sessionId)
  if (!agent) return undefined
  try {
    const [rows, cols] = execFileSync('stty', ['-F', agent.tty, 'size'], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .map(Number)
    return { grid: { cols: cols ?? 0, rows: rows ?? 0 }, pid: agent.pid }
  } catch {
    return undefined
  }
}

// ---- the server's copy -------------------------------------------------------

interface Row {
  sessionId: string
  status?: string
  geometry?: Grid
}

async function sessionRows(request: APIRequestContext): Promise<Row[]> {
  const response = await request.get(`${HTTP}/trpc/sessions.list`).catch(() => undefined)
  if (!response?.ok()) return []
  const body = (await response.json()) as { result?: { data?: Row[] } }
  return body.result?.data ?? []
}

// ---- the browsers ------------------------------------------------------------

interface PodiumApi {
  state(): { sessionId?: string; role: string; cols: number; rows: number }
  grid?(): Grid
  diagnostics?(): Array<{ event: string; data: Record<string, unknown> }>
  sendInput(data: string): void
  takeControl?(): void
}
type PodiumWindow = Window & { __podium?: PodiumApi }

interface Viewer {
  name: string
  page: Page
}

interface ViewerReading {
  name: string
  sessionId?: string
  role?: string
  grid?: Grid
  /** The last grid this mount measured and stated: its box. */
  box?: Grid
}

async function readViewer(viewer: Viewer): Promise<ViewerReading> {
  const reading = await viewer.page
    .evaluate(() => {
      const api = (window as unknown as PodiumWindow).__podium
      if (!api?.grid) return undefined
      const state = api.state()
      const asks = (api.diagnostics?.() ?? []).filter(
        (entry) => entry.event === 'ask:sent' && entry.data.measured === true,
      )
      return {
        sessionId: state.sessionId,
        role: state.role,
        grid: api.grid(),
        box: asks.at(-1)?.data.geometry as { cols: number; rows: number } | undefined,
      }
    })
    .catch(() => undefined)
  return { name: viewer.name, ...reading }
}

// ---- the harness's outside controls -----------------------------------------

const stateDir = (): string => harnessEnv(PORT).stateDir
const harnessPid = (): number => Number(readFileSync(join(stateDir(), 'harness.pid'), 'utf8'))
const readState = (file: string): string => readFileSync(join(stateDir(), file), 'utf8').trim()

/** Signal the harness and wait for the ack file to move. */
async function signalHarness(signal: NodeJS.Signals, ackFile: string): Promise<string> {
  const before = readState(ackFile)
  process.kill(harnessPid(), signal)
  await expect
    .poll(() => readState(ackFile), { timeout: 60_000, message: `${signal} acknowledged` })
    .not.toBe(before)
  return readState(ackFile)
}

/**
 * THE HOST REFUSES (fault injection, from outside). A second client STEALs the
 * writer lease, so every RESIZE the daemon sends answers ERR NOT_WRITER. The
 * frames are written by hand: SPEC-6's HELLO (u16 version, u8 mode, u64 from)
 * and STEAL, each as u32 length + u8 type + payload.
 */
async function stealWriterLease(socketPath: string): Promise<Socket> {
  const frame = (type: number, payload = Buffer.alloc(0)): Buffer => {
    const out = Buffer.alloc(5 + payload.length)
    out.writeUInt32BE(payload.length + 1, 0)
    out[4] = type
    payload.copy(out, 5)
    return out
  }
  const hello = Buffer.alloc(11)
  hello.writeUInt16BE(1, 0)
  hello[2] = 1 // writer
  hello.writeBigUInt64BE(0xffff_ffff_ffff_ffffn, 3) // from the tail
  const socket = connect(socketPath)
  let seen = Buffer.alloc(0)
  const stolen = new Promise<void>((resolve, reject) => {
    socket.on('error', reject)
    // Keep reading: the host streams DATA to every client, and an unread
    // client is one the host eventually has to drop.
    socket.on('data', (chunk: Buffer) => {
      seen = Buffer.concat([seen, chunk])
      while (seen.length >= 5 && seen.length >= 4 + seen.readUInt32BE(0)) {
        const type = seen[4]
        seen = seen.subarray(4 + seen.readUInt32BE(0))
        if (type === 0x8c) resolve() // STOLEN
      }
    })
  })
  socket.write(Buffer.concat([frame(0x01, hello), frame(0x0a)]))
  await stolen
  return socket
}

// ---- the check ---------------------------------------------------------------

interface Verdict {
  row: string
  kernel: string
  copy: string
  viewers: string
  controllerBox: string
  ms: number
}

test('the agent’s real size, the server’s copy and every browser grid agree after every event', async ({
  browser,
  request,
}) => {
  test.setTimeout(25 * 60_000)
  expect(
    HOST_SOCKET_DIR.length > 0 && HOST_SOCKET_DIR.length <= 40,
    'PODIUM_HOST_SOCKET_DIR must name a private, short dir — never the live hosts',
  ).toBe(true)
  expect(process.env.PODIUM_E2E_LINK_B_PROXY, 'the link B drop needs the proxy').toBe('1')
  expect(process.env.PODIUM_E2E_CLAUDE_MODEL, 'Claude runs on haiku').toBe('haiku')

  const verdicts: Verdict[] = []
  const contexts: BrowserContext[] = []
  let session = ''
  let agentPid: number | undefined
  let viewers: Viewer[] = []

  const read = async () => ({
    kernel: kernel(session),
    copy: (await sessionRows(request)).find((row) => row.sessionId === session),
    viewers: await Promise.all(viewers.map(readViewer)),
  })
  type Reading = Awaited<ReturnType<typeof read>>

  /** Why this reading breaks the invariant, or undefined when it holds. */
  const problem = (r: Reading, follow: boolean): string | undefined => {
    if (!r.kernel) return 'the agent’s pty cannot be read'
    if (agentPid !== undefined && r.kernel.pid !== agentPid) {
      return `the agent was replaced (pid ${agentPid} → ${r.kernel.pid})`
    }
    if (!same(r.kernel.grid, r.copy?.geometry)) return 'kernel ≠ server copy'
    for (const v of r.viewers) {
      if (v.sessionId !== session) return `${v.name} is not showing the session`
      if (!same(v.grid, r.kernel.grid)) return `${v.name}’s grid ≠ kernel`
    }
    if (!follow) return undefined
    const controllers = r.viewers.filter((v) => v.role === 'controller')
    if (controllers.length !== 1) return `${controllers.length} controllers among the viewers`
    const [controller] = controllers
    if (!same(controller?.box, r.kernel.grid)) {
      return `the kernel is not at the controller’s box (${controller?.name} measured ${show(controller?.box)})`
    }
    return undefined
  }

  const describe = (r: Reading): string =>
    [
      `kernel ${show(r.kernel?.grid)} (pid ${r.kernel?.pid ?? '—'})`,
      `copy ${show(r.copy?.geometry)} (${r.copy?.status ?? 'no row'})`,
      ...r.viewers.map(
        (v) => `${v.name} grid ${show(v.grid)} role ${v.role ?? '—'} box ${show(v.box)}`,
      ),
    ].join('; ')

  const poke = async (): Promise<void> => {
    for (const v of viewers) {
      const r = await readViewer(v)
      if (r.role !== 'controller') continue
      // Typed and erased at the prompt: output from the agent, and no turn.
      await v.page.evaluate(() => (window as unknown as PodiumWindow).__podium?.sendInput('x'))
      await v.page.waitForTimeout(400)
      await v.page.evaluate(() => (window as unknown as PodiumWindow).__podium?.sendInput('\x7f'))
    }
  }

  /**
   * Wait for agreement, then make the agent write and demand it again. A row
   * fails with every reading on one line, so a red names the hop that lied.
   */
  const check = async (
    row: string,
    opts: { follow?: boolean; poke?: boolean; kernelStays?: Grid } = {},
  ): Promise<Grid> => {
    const follow = opts.follow ?? true
    const started = Date.now()
    let last: Reading | undefined
    const settle = async (phase: string, timeout: number): Promise<void> => {
      const deadline = Date.now() + timeout
      for (;;) {
        last = await read()
        let why = problem(last, follow)
        if (!why && opts.kernelStays && !same(last.kernel?.grid, opts.kernelStays)) {
          why = `the kernel moved off ${show(opts.kernelStays)}`
        }
        if (!why) return
        if (Date.now() > deadline) {
          throw new Error(`[${row}] ${phase}: ${why}\n    ${describe(last)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    await settle('agreement', 60_000)
    if (opts.poke ?? true) {
      await poke()
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      await settle('after the agent wrote', 15_000)
    }
    const reading = last as Reading
    verdicts.push({
      row,
      kernel: show(reading.kernel?.grid),
      copy: show(reading.copy?.geometry),
      viewers: reading.viewers.map((v) => `${v.name}=${show(v.grid)}/${v.role}`).join(' '),
      controllerBox: show(reading.viewers.find((v) => v.role === 'controller')?.box),
      ms: Date.now() - started,
    })
    console.log(`[size-truth] ${row}: ${describe(reading)}`)
    return reading.kernel?.grid as Grid
  }

  const desktop = async (name: string, viewport: { width: number; height: number }) => {
    const context = await browser.newContext({ ...devices['Desktop Chrome'], viewport })
    contexts.push(context)
    return { name, page: await context.newPage() }
  }

  /** A second screen onto the session, as a deep link opens it. */
  const openOnDesktop = async (viewer: Viewer): Promise<void> => {
    await viewer.page.addInitScript(() => localStorage.setItem('podium.panelModeDefault', 'native'))
    await viewer.page.goto(`/sessions/${session}?server=${RELAY}&e2e=1`)
    await expect
      .poll(() => readViewer(viewer).then((r) => r.sessionId), {
        timeout: 90_000,
        message: `${viewer.name} shows the session`,
      })
      .toBe(session)
  }

  const claudeReady = async (page: Page): Promise<void> => {
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as unknown as { __podium?: { screenText(): string } }
              ).__podium?.screenText() ?? '',
          ),
        { timeout: 120_000, intervals: [1000], message: 'Claude is at its prompt' },
      )
      .toMatch(/for shortcuts|auto mode|❯/i)
  }

  const cliTab = (page: Page) => page.locator('[data-testid="mode-native"]:visible').first()
  const chatTab = (page: Page) => page.locator('[data-testid="mode-chat"]:visible').first()

  /** New panel → New Claude. Returns the new session's id, from the server. */
  const spawnClaude = async (page: Page): Promise<string> => {
    const before = new Set((await sessionRows(request)).map((row) => row.sessionId))
    await page.locator('button[aria-label="New panel"]:visible').first().click({ timeout: 15_000 })
    const item = page.getByRole('menuitem', { name: 'New Claude' })
    await item.waitFor({ state: 'visible', timeout: 10_000 })
    await item.click({ timeout: 10_000 }).catch(() => {})
    let id: string | undefined
    await expect
      .poll(
        async () => {
          id = (await sessionRows(request)).find(
            (row) => !before.has(row.sessionId) && row.status === 'live',
          )?.sessionId
          return id !== undefined
        },
        { timeout: 90_000, message: 'the spawned session is live' },
      )
      .toBe(true)
    return id as string
  }

  try {
    // ==== ROW: spawn straight in CLI ==========================================
    const d1 = await desktop('desktop-1', { width: 1400, height: 900 })
    viewers = [d1]
    await openApp(d1.page)
    session = await spawnClaude(d1.page)
    await expect(cliTab(d1.page)).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 })
    await expect
      .poll(() => readViewer(d1).then((r) => r.sessionId), { timeout: 60_000 })
      .toBe(session)
    await claudeReady(d1.page)
    agentPid = kernel(session)?.pid
    await check('spawn straight in CLI')

    // ==== ROW: spawn in chat, then CLI =========================================
    // Picking Chat is also the operator's default pick, so the next panel opens
    // in Chat: its terminal is first mounted by the CLI click, not the spawn.
    await chatTab(d1.page).click()
    await expect(chatTab(d1.page)).toHaveAttribute('aria-selected', 'true')
    session = await spawnClaude(d1.page)
    agentPid = undefined
    await expect(chatTab(d1.page)).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 })
    await expect(cliTab(d1.page)).toHaveAttribute('aria-selected', 'false')
    // No browser grid yet: kernel and copy still agree, at whatever it spawned.
    viewers = []
    await expect.poll(() => kernel(session) !== undefined, { timeout: 60_000 }).toBe(true)
    agentPid = kernel(session)?.pid
    await d1.page.waitForTimeout(8_000) // let Claude boot at the spawn size
    await check('spawn in chat (no viewer)', { follow: false, poke: false })
    await cliTab(d1.page).click()
    viewers = [d1]
    await expect
      .poll(() => readViewer(d1).then((r) => r.sessionId), { timeout: 60_000 })
      .toBe(session)
    await claudeReady(d1.page)
    await check('spawn in chat, then CLI')

    // ==== ROW: box change =======================================================
    await d1.page.setViewportSize({ width: 1100, height: 720 })
    await check('box change')

    // ==== ROW: window drag ======================================================
    for (let step = 1; step <= 24; step++) {
      await d1.page.setViewportSize({ width: 1100 + step * 16, height: 720 + step * 9 })
      await d1.page.waitForTimeout(16)
    }
    await check('window drag')

    // ==== ROW: claim with a size change ========================================
    // A second desktop opens the session: its reveal claims, at its own box.
    const d2 = await desktop('desktop-2', { width: 1250, height: 800 })
    await openOnDesktop(d2)
    viewers = [d1, d2]
    await check('claim with a size change (desktop-2 opens)')
    // And the first takes it back with the product's own takeover.
    await d1.page.evaluate(() => (window as unknown as PodiumWindow).__podium?.takeControl?.())
    await check('claim with a size change (desktop-1 takes over)')

    // ==== ROW: desktop leaves, the phone is the sole controller ================
    const phoneContext = await browser.newContext({ ...devices['Pixel 7'] })
    contexts.push(phoneContext)
    const phone = { name: 'phone', page: await phoneContext.newPage() }
    await phone.page.goto(`/mobile/session/${session}?server=${RELAY}&e2e=1`)
    await phone.page.getByRole('button', { name: 'Open terminal' }).click({ timeout: 60_000 })
    await expect
      .poll(() => readViewer(phone).then((r) => r.sessionId), { timeout: 60_000 })
      .toBe(session)
    viewers = [d1, d2, phone]
    await check('phone attaches as a spectator')
    for (const viewer of [d1, d2]) await viewer.page.context().close()
    viewers = [phone]
    await check('desktops leave, the phone is sole controller')

    // ==== ROW: link A drops =====================================================
    const d3 = await desktop('desktop-3', { width: 1300, height: 850 })
    await openOnDesktop(d3)
    viewers = [phone, d3]
    await check('desktop-3 opens and claims')
    await phoneContext.close()
    viewers = [d3]
    await check('the phone leaves')
    await d3.page.context().setOffline(true)
    await d3.page.waitForTimeout(5_000)
    await d3.page.setViewportSize({ width: 1180, height: 760 }) // the box moves while cut off
    await d3.page.waitForTimeout(2_000)
    await d3.page.context().setOffline(false)
    await check('link A drops, the box changes, link A is back')

    // ==== ROW: link B drops =====================================================
    expect(await signalHarness('SIGHUP', 'link-b')).toMatch(/ down$/)
    await d3.page.waitForTimeout(5_000)
    await d3.page.setViewportSize({ width: 1340, height: 870 }) // asked while the daemon is unreachable
    await d3.page.waitForTimeout(3_000)
    expect(await signalHarness('SIGHUP', 'link-b')).toMatch(/ up$/)
    await check('link B drops, the box changes, link B is back')

    // ==== ROW: server restart (link A and link B together) =====================
    await signalHarness('SIGUSR1', 'restart-serial')
    await check('server restart')

    // ==== ROW: the host refuses =================================================
    // Nothing the host refused may be reported: the view keeps the TRUE size,
    // and the agent keeps the size it has.
    const socket = hostSocket(session)
    if (!socket) throw new Error('no host socket for the session')
    const held = kernel(session)?.grid as Grid
    const thief = await stealWriterLease(socket)
    try {
      await d3.page.setViewportSize({ width: 1220, height: 800 })
      await d3.page.waitForTimeout(5_000)
      await check('the host refuses the ask', { follow: false, poke: false, kernelStays: held })
    } finally {
      thief.destroy()
    }

    // ==== ROW: daemon restart ===================================================
    // Re-adoption takes the (now free) lease back. The box moves while no
    // daemon runs; the bind re-drives it.
    const restarts = readState('daemon-restart-serial')
    process.kill(harnessPid(), 'SIGUSR2')
    await d3.page.waitForTimeout(1_000)
    await d3.page.setViewportSize({ width: 1400, height: 900 })
    await expect
      .poll(() => readState('daemon-restart-serial'), { timeout: 60_000 })
      .not.toBe(restarts)
    await check('daemon restart, the box changes while it is down')
    const settled = await check('settled before a plain daemon restart', { poke: false })
    await signalHarness('SIGUSR2', 'daemon-restart-serial')
    await check('daemon restart, nothing changes', { kernelStays: settled })
  } finally {
    console.log('[size-truth] verdicts\n' + JSON.stringify(verdicts, null, 2))
    await test.info().attach('size-truth-verdicts.json', {
      body: JSON.stringify(verdicts, null, 2),
      contentType: 'application/json',
    })
    for (const context of contexts) await context.close().catch(() => {})
  }
})
