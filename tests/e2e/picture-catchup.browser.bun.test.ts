/** SPEC v4 C: eight browser boundaries, real Claude on haiku, private screen host.
 * Run only this file, with PODIUM_E2E_REAL_AGENTS=1. The login-copy helper keeps
 * its one-hour guard; no source credentials or live hosts are changed. */
import { expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BrowserContext, chromium, type Page } from '@playwright/test'
import { agentLaunchCommand } from '@podium/harness'
import type { SessionId } from '@podium/model'
import { connectHost, hostSocketPath, resolveHostBin } from '@podium/process/durable'
import { TerminalScreen } from '@podium/process/screen'
import { decodeBinaryEnvelope, PtyOutputBinaryMetadata } from '@podium/protocol'
import { startDaemon } from '../../apps/daemon/src/daemon'
import { noJanitorWorkerForTests } from '../../apps/server/src/janitor-host'
import type { PictureCache } from '../../apps/server/src/modules/sessions/picture-cache'
import { startServer } from '../../apps/server/src/server'
import { loginTestClient } from '../../apps/server/src/test-support/client-auth'
import { assignHostMachine } from '../../apps/server/src/test-support/host-daemon'
import { buildLocalRustHost } from '../../scripts/rust-host-cross'
import { applyRealAgentClaudeEnv, HOST_INSTANCE_ENV, harnessEnv } from './harness-env'
import { startLinkProxy } from './link-b-proxy'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const trim = (text: string) => text.trimEnd()
const credentialHash = () =>
  createHash('sha256')
    .update(readFileSync(join(homedir(), '.claude', '.credentials.json')))
    .digest('hex')

async function until(check: () => boolean | Promise<boolean>, why: string, timeout = 120_000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(why)
    await Bun.sleep(100)
  }
}

async function freePort(): Promise<number> {
  const socket = createServer()
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve))
  const port = (socket.address() as { port: number }).port
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  return port
}

function processStat(pid: number) {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)?.split(' ') ?? []
  return { start: fields[19], cpuTicks: Number(fields[11]) + Number(fields[12]) }
}

test.skipIf(process.env.PODIUM_E2E_REAL_AGENTS !== '1')(
  'reload, cold switch, all restarts, both link drops, and takeover reproduce the host picture',
  async () => {
    const dirs = harnessEnv(4914, randomUUID())
    const hostDir = join(dirs.base, 'h')
    const webDir = join(dirs.base, 'web')
    const scratch = join(dirs.base, 'repo')
    const sourceLogin = credentialHash()
    const envBefore = { ...process.env }
    const owned = new Map<number, string | undefined>()
    const contexts: BrowserContext[] = []
    const verdicts: Array<Record<string, unknown>> = []
    let server: Awaited<ReturnType<typeof startServer>> | undefined
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined
    let linkA: Awaited<ReturnType<typeof startLinkProxy>> | undefined
    let linkB: Awaited<ReturnType<typeof startLinkProxy>> | undefined
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    let sid: SessionId
    let label: string
    let hostPid = 0
    let cookie: Awaited<ReturnType<typeof loginTestClient>>
    const password = 'private-picture-browser-password'
    const token = randomUUID()
    const port = await freePort()
    const runningServer = () => {
      if (!server) throw new Error('the private server is not running')
      return server
    }
    const runningDaemon = () => {
      if (!daemon) throw new Error('the private daemon is not running')
      return daemon
    }
    const session = () => {
      const value = server?.registry.modules.sessions.sessions.get(sid)
      if (!value) throw new Error('the session is absent')
      return value
    }
    async function bootServer() {
      server = await startServer({ port, janitorWorkerForTests: noJanitorWorkerForTests })
      await assignHostMachine(server.registry.sessionStore)
      await server.registry.modules.machines.ensureHostMachine('picture-browser', token, {
        server: true,
        agentExecution: true,
      })
      cookie = await loginTestClient({ origin: `http://127.0.0.1:${port}`, password })
    }
    async function bootDaemon() {
      if (!server || !linkB) throw new Error('the private server is not running')
      daemon = await startDaemon({
        serverUrl: `ws://127.0.0.1:${linkB.port}`,
        machineToken: token,
        machineId: server.registry.modules.machines.hostMachineId,
        hooks: { port: 0 },
        agentRelay: { port: 0 },
        discovery: { homeDir: dirs.discoveryHomeDir, background: false, cachePath: ':memory:' },
        launch: (kind, opts) => {
          const spec = agentLaunchCommand(kind, { ...opts, model: 'haiku' })
          return { ...spec, env: { ...spec.env, HOME: dirs.discoveryHomeDir } }
        },
      })
      await until(() => daemon?.connected === true, 'the daemon did not connect')
      await until(async () => {
        const machines = await runningServer().registry.modules.machines.listMachines()
        return (
          machines.find((m) => m.id === runningServer().registry.modules.machines.hostMachineId)
            ?.inventory !== undefined
        )
      }, 'the private machine inventory did not arrive')
    }
    async function hostPicture() {
      const conn = connectHost(hostSocketPath(label), { mode: 'reader' })
      try {
        await conn.welcome
        let result: { bytes: Buffer; cols: number; rows: number } | undefined
        conn.onItem((item) => {
          if (item.kind === 'picture' && item.reason === 'reset') result = item
        })
        expect(conn.requestPicture()).toBe(true)
        await until(() => result !== undefined, 'the host did not answer PICTURE')
        const picture = result as NonNullable<typeof result>
        const screen = new TerminalScreen({ cols: picture.cols, rows: picture.rows })
        try {
          screen.push(picture.bytes)
          await screen.flush()
          return { ...picture, text: trim(screen.lines(false).join('\n')) }
        } finally {
          screen.dispose()
        }
      } finally {
        conn.detach()
      }
    }
    type Viewer = { page: Page; payloads: Buffer[] }
    async function viewer(passive = false): Promise<Viewer> {
      if (!browser || !linkA) throw new Error('the private browser is not running')
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 } })
      contexts.push(context)
      await context.addCookies([
        {
          name: cookie.cookieName,
          value: cookie.cookieValue,
          url: `http://127.0.0.1:${linkA.port}`,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ])
      const page = await context.newPage()
      page.on('pageerror', (error) => console.error(`[picture-browser] ${error.message}`))
      page.on('console', (message) => {
        if (message.type() === 'error') console.error(`[picture-browser] ${message.text()}`)
      })
      const payloads: Buffer[] = []
      page.on('websocket', (socket) => {
        socket.on('framereceived', ({ payload }) => {
          if (typeof payload === 'string') return
          const decoded = decodeBinaryEnvelope(new Uint8Array(payload), PtyOutputBinaryMetadata)
          if (decoded.metadata.sessionId === sid) payloads.push(Buffer.from(decoded.payload))
        })
      })
      await page.goto(`http://127.0.0.1:${linkA.port}/?session=${sid}&passive=${passive ? 1 : 0}`)
      return { page, payloads }
    }
    async function reading(v: Viewer) {
      return v.page.evaluate(() => {
        const api = (
          window as unknown as {
            __podium?: {
              screenText(): string
              grid(): { cols: number; rows: number }
              state(): { connected: boolean; role: string }
            }
          }
        ).__podium
        return api
          ? { text: api.screenText().trimEnd(), grid: api.grid(), ...api.state() }
          : undefined
      })
    }
    const pictures = (v: Viewer) =>
      v.payloads.filter((p) => p.subarray(0, 2).equals(Buffer.from('\x1bc'))).length
    async function servedAgain(viewers: Viewer[], before: number[]) {
      await until(
        () => viewers.every((v, index) => pictures(v) > (before[index] ?? 0)),
        'a viewer did not get a new picture after the boundary',
      )
    }
    async function check(row: string, viewers: Viewer[]) {
      let picture: Awaited<ReturnType<typeof hostPicture>> | undefined
      await until(async () => {
        picture = await hostPicture()
        const readings = await Promise.all(viewers.map(reading))
        return readings.every(
          (r) =>
            r?.connected &&
            r.text === picture?.text &&
            r.grid.cols === picture?.cols &&
            r.grid.rows === picture?.rows,
        )
      }, `${row}: the browser screen differs from the host picture`)
      const cache = (session().terminal as unknown as { pictureCache: PictureCache }).pictureCache
      const cached = cache.picture
      expect(cached).toBeDefined()
      if (!cached) throw new Error('the server has no cached picture')
      const reader = cache.openReader(cached)
      let tailBytes = 0
      try {
        for (;;) {
          const item = cache.read(reader)
          if (item.kind === 'end') break
          expect(item.kind).toBe('bytes')
          if (item.kind === 'bytes') tailBytes += item.bytes.length
        }
      } finally {
        cache.closeReader(reader)
      }
      const deliveredTail = viewers.map((v) => {
        const index = v.payloads.findLastIndex((p) => p.subarray(0, 2).equals(Buffer.from('\x1bc')))
        expect(index).toBeGreaterThanOrEqual(0)
        expect(v.payloads[index]).toEqual(cached?.bytes)
        const bytes = v.payloads.slice(index + 1).reduce((sum, p) => sum + p.length, 0)
        expect(bytes).toBeLessThanOrEqual(tailBytes)
        return bytes
      })
      const result = {
        row,
        cols: picture?.cols,
        rows: picture?.rows,
        pictureBytes: picture?.bytes.length,
        tailBytes,
        deliveredTail,
        hostCpuTicks: processStat(hostPid).cpuTicks,
      }
      verdicts.push(result)
      console.log(`[picture-browser] ${JSON.stringify(result)}`)
    }
    try {
      expect(hostDir.length).toBeLessThanOrEqual(40)
      for (const key of HOST_INSTANCE_ENV) delete process.env[key]
      process.env.PODIUM_STATE_DIR = dirs.stateDir
      process.env.PODIUM_HOST_SOCKET_DIR = hostDir
      process.env.ABDUCO_SOCKET_DIR = dirs.abducoSocketDir
      process.env.PODIUM_NO_SCOPE = '1'
      process.env.PODIUM_PASSWORD = password
      process.env.PODIUM_WEB_DIR = webDir
      for (const dir of [dirs.stateDir, hostDir, webDir, scratch, dirs.abducoSocketDir]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
      }
      applyRealAgentClaudeEnv(dirs, [scratch])
      writeFileSync(
        join(dirs.stateDir, 'config.json'),
        JSON.stringify({ configVersion: 2, mode: 'all-in-one' }),
      )
      const bundle = await Bun.build({
        entrypoints: [join(ROOT, 'tests/e2e/fixtures/picture-viewer.ts')],
        target: 'browser',
        conditions: ['@podium/source'],
        outdir: webDir,
      })
      if (!bundle.success) throw new Error(bundle.logs.map(String).join('\n'))
      writeFileSync(
        join(webDir, 'index.html'),
        `<!doctype html><html><head>
        <link rel="stylesheet" href="/picture-viewer.css"><style>
        body{background:#181818;color:#eee;font:14px monospace;margin:24px}
        #viewport{width:960px;height:600px;overflow:auto;margin-top:20px}
        </style></head><body><button id="cold-switch">Cold switch</button>
        <button id="take-control">Take control</button>
        <button id="pause">Pause</button>
        <div id="viewport"><div id="terminal"></div></div>
        <script type="module" src="/picture-viewer.js"></script></body></html>`,
      )
      process.env.PODIUM_HOST_BIN = buildLocalRustHost(
        join(ROOT, 'packages/pty/vendor/podium-host-rs'),
      )
      resolveHostBin({ fresh: true })
      await bootServer()
      linkA = await startLinkProxy(port)
      linkB = await startLinkProxy(port)
      await bootDaemon()
      sid = (
        await runningServer().registry.modules.sessions.createSession({
          agentKind: 'claude-code',
          model: 'haiku',
          cwd: scratch,
          machineId: runningServer().registry.modules.machines.hostMachineId,
        })
      ).sessionId as SessionId
      await until(() => session().status === 'live', 'Claude did not go live')
      label = session().durableLabel
      const conn = connectHost(hostSocketPath(label), { mode: 'reader' })
      try {
        const welcome = await conn.welcome
        hostPid = welcome.hostPid
        for (const pid of [welcome.hostPid, welcome.childPid]) {
          const start = processStat(pid).start
          if (!start) throw new Error('the owned process has no start time')
          owned.set(pid, start)
        }
      } finally {
        conn.detach()
      }
      browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
      const a = await viewer()
      await until(
        async () => (await reading(a)) !== undefined,
        'the browser mount did not initialize',
        30_000,
      )
      await Bun.sleep(3000)
      console.log(
        `[picture-browser] initial ${JSON.stringify({ reading: await reading(a), payloads: a.payloads.length, host: (await hostPicture()).text })}`,
      )
      await until(
        async () => (await reading(a))?.connected === true,
        'the terminal fixture did not attach',
        30_000,
      )
      await until(
        async () => /for shortcuts|auto mode|❯/.test((await reading(a))?.text ?? ''),
        'Claude did not paint its prompt',
      )
      await check('initial attach', [a])
      let before = [pictures(a)]
      await a.page.reload()
      await servedAgain([a], before)
      await check('reload', [a])
      before = [pictures(a)]
      await a.page.locator('#cold-switch').click()
      await servedAgain([a], before)
      await check('cold switch', [a])
      before = [pictures(a)]
      await runningServer().close()
      await until(
        async () => (await reading(a))?.connected === false,
        'server restart did not disconnect the viewer',
      )
      await bootServer()
      await servedAgain([a], before)
      await check('server restart', [a])
      before = [pictures(a)]
      await runningDaemon().close()
      await bootDaemon()
      await servedAgain([a], before)
      await check('daemon restart', [a])
      before = [pictures(a)]
      await runningDaemon().close()
      await runningServer().close()
      await until(
        async () => (await reading(a))?.connected === false,
        'both restarts did not disconnect the viewer',
      )
      await bootServer()
      await bootDaemon()
      await servedAgain([a], before)
      await check('both restart', [a])
      before = [pictures(a)]
      linkA.cut()
      await until(async () => (await reading(a))?.connected === false, 'link A did not drop')
      linkA.restore()
      await servedAgain([a], before)
      await check('link A drop', [a])
      before = [pictures(a)]
      linkB.cut()
      await until(() => daemon?.connected === false, 'link B did not drop')
      linkB.restore()
      await until(() => daemon?.connected === true, 'link B did not reconnect')
      await servedAgain([a], before)
      await check('link B drop', [a])
      const b = await viewer(true)
      await check('spectator attach', [a, b])
      expect((await reading(a))?.role).toBe('controller')
      expect((await reading(b))?.role).toBe('spectator')
      before = [pictures(a), pictures(b)]
      await b.page.locator('#take-control').click()
      await until(async () => (await reading(b))?.role === 'controller', 'takeover did not happen')
      // Match the app's inactive former panel after the user switches controller.
      await a.page.locator('#pause').click()
      await servedAgain([a, b], before)
      await check('controller takeover', [a, b])
      expect((await reading(a))?.role).toBe('spectator')
      expect((await reading(b))?.role).toBe('controller')
      const evidenceDir = process.env.PODIUM_E2E_EVIDENCE_DIR
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true })
        await b.page.screenshot({ path: join(evidenceDir, 'picture-browser.png') })
        writeFileSync(
          join(evidenceDir, 'picture-browser.json'),
          `${JSON.stringify(verdicts, null, 2)}\n`,
        )
      }
    } finally {
      for (const context of contexts) {
        for (const page of context.pages()) {
          console.log(
            `[picture-browser] final ${JSON.stringify({
              url: page.url(),
              body: await page
                .locator('body')
                .innerText()
                .catch(() => ''),
              reading: await reading({ page, payloads: [] }).catch(() => undefined),
            })}`,
          )
          const evidenceDir = process.env.PODIUM_E2E_EVIDENCE_DIR
          if (evidenceDir) {
            mkdirSync(evidenceDir, { recursive: true })
            await page
              .screenshot({ path: join(evidenceDir, 'picture-browser-final.png') })
              .catch(() => {})
          }
        }
      }
      await Promise.all(contexts.map((c) => c.close().catch(() => {})))
      await browser?.close()
      await daemon?.close().catch(() => {})
      await server?.close().catch(() => {})
      await linkA?.close()
      await linkB?.close()
      for (const [pid, start] of owned) {
        try {
          if (processStat(pid).start !== start) continue
          if (pid === hostPid && !readlinkSync(`/proc/${pid}/exe`).includes('podium-host')) continue
          process.kill(pid, 'SIGTERM')
        } catch {
          /* already exited */
        }
      }
      await Bun.sleep(250)
      for (const [pid, start] of owned) {
        try {
          if (processStat(pid).start === start) process.kill(pid, 'SIGKILL')
        } catch {
          /* already exited */
        }
      }
      rmSync(dirs.base, { recursive: true, force: true })
      for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key]
      Object.assign(process.env, envBefore)
      expect(credentialHash()).toBe(sourceLogin)
    }
  },
  15 * 60_000,
)
