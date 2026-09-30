/**
 * VIEWER CATCH-UP FROM THE HOST'S PICTURES, END TO END (POD-4912, SPEC v4 B2).
 *
 * A real server, a real daemon (in process) and a real Rust podium-host that
 * keeps the screen, built from `packages/pty/vendor/podium-host`; viewers
 * are real logged-in `/client` websockets. Every check compares what a viewer
 * rebuilt from the bytes it received with a picture the HOST itself hands a
 * separate reader connection — the truth the system is meant to deliver.
 *
 *   - a cold attach gets exactly a picture then the tail (its first byte is
 *     the picture's RIS, so no older byte);
 *   - a resize: every viewer gets a picture at the new size, after the size;
 *   - a controller takeover leaves no viewer blank;
 *   - a spectator's redraw never reaches the program; the controller's does;
 *   - a daemon restart: one reset picture, zero replayed bytes;
 *   - a server restart: an idle program is not blank after its viewers reattach;
 *   - a C-host session (no pictures) keeps live output and input.
 *
 * Isolation: its own state dir (the e2e harness), a private SHORT host socket
 * dir, no systemd scopes, and at the end only the hosts under that dir are
 * stopped. Needs a Rust toolchain (rustup) for the host; skips without one.
 * The C adoption case needs an external PODIUM_TEST_C_HOST_BIN fixture;
 * it skips without one, because the C source is no longer vendored.
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asSessionId, type SessionId } from '@podium/model'
import {
  connectHost,
  hostBinFeatures,
  hostCreateArgs,
  hostSocketPath,
  resolveHostBin,
} from '@podium/process/durable'
import { TerminalScreen } from '@podium/process/screen'
import {
  CAP_TERMINAL_OUTPUT_BINARY_V1,
  CLIENT_WIRE_VERSION,
  decodeBinaryEnvelope,
  PtyOutputBinaryMetadata,
  type ServerMessage,
} from '@podium/protocol'
import { durableSessionLabel } from '@podium/runtime/instance'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startDaemon } from '../../apps/daemon/src/daemon'
import { noJanitorWorkerForTests } from '../../apps/server/src/janitor-host'
import { startServer } from '../../apps/server/src/server'
import { loginTestClient } from '../../apps/server/src/test-support/client-auth'
import { assignHostMachine } from '../../apps/server/src/test-support/host-daemon'
import { buildLocalRustHost } from '../../scripts/rust-host-cross'
import { applyHarnessEnv } from './harness-env'

const HARNESS_PORT = 9937
const PASSWORD = 'picture-catchup-e2e-password'
const { stateDir } = applyHarnessEnv(HARNESS_PORT)
// A configured all-in-one instance: an unconfigured one withholds its planes.
writeFileSync(
  join(stateDir, 'config.json'),
  JSON.stringify({ configVersion: 2, mode: 'all-in-one', persistence: 'systemd' }),
)
// NEVER the live hosts: a private, short socket dir (a unix socket path is
// capped near 108 bytes), and no systemd scopes.
const HOST_DIR = mkdtempSync('/tmp/p4912-')
process.env.PODIUM_HOST_SOCKET_DIR = HOST_DIR
process.env.PODIUM_NO_SCOPE = '1'
process.env.PODIUM_PASSWORD = PASSWORD

const FIXTURE = fileURLToPath(
  new URL('../../packages/pty/test/fixtures/fixture-tui.mjs', import.meta.url),
)

function rustHost(): string | undefined {
  try {
    return buildLocalRustHost(
      fileURLToPath(new URL('../../packages/pty/vendor/podium-host', import.meta.url)),
    )
  } catch {
    return undefined
  }
}
const RUST_HOST = rustHost()
// Compatibility fixture only: never selected by the Rust-only spawn resolver.
const C_HOST = process.env.PODIUM_TEST_C_HOST_BIN
const haveCHost = !!C_HOST && hostBinFeatures(C_HOST) === 1

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

async function until(pred: () => boolean, why: () => string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${why()}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Retry an async check until it passes (the program answers on its own time). */
async function eventually(check: () => Promise<void>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

const trimmed = (lines: string[]): string =>
  lines
    .map((l) => l.trimEnd())
    .join('\n')
    .trimEnd()

type Event = { kind: 'json'; msg: ServerMessage } | { kind: 'bytes'; data: Buffer }

/** A logged-in `/client` viewer of one session that rebuilds the screen it is sent. */
async function viewer(port: number, cookie: string, sessionId: SessionId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/client?cap=sync.http.v1`, {
    headers: { Cookie: cookie },
  })
  const events: Event[] = []
  let screen: TerminalScreen | undefined
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const d = decodeBinaryEnvelope(new Uint8Array(raw as Buffer), PtyOutputBinaryMetadata)
      if (d.metadata.sessionId !== sessionId) return
      const data = Buffer.from(d.payload)
      events.push({ kind: 'bytes', data })
      screen?.push(data)
      return
    }
    const msg = JSON.parse(raw.toString()) as ServerMessage
    events.push({ kind: 'json', msg })
    if (msg.type === 'attached' && msg.sessionId === sessionId) {
      screen = new TerminalScreen({ cols: msg.geometry.cols, rows: msg.geometry.rows })
    }
    if (msg.type === 'geometry' && msg.sessionId === sessionId)
      screen?.setAppliedSize(msg.cols, msg.rows)
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  ws.send(
    JSON.stringify({
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: [CAP_TERMINAL_OUTPUT_BINARY_V1, 'sync.http.v1'],
      wireVersion: CLIENT_WIRE_VERSION,
    }),
  )
  await until(
    () => events.some((e) => e.kind === 'json' && e.msg.type === 'welcome'),
    () => 'no welcome',
  )
  ws.send(JSON.stringify({ type: 'attach', sessionId }))
  await until(
    () => screen !== undefined,
    () =>
      `never attached: ${JSON.stringify(
        events.map((e) =>
          e.kind === 'bytes'
            ? 'bytes'
            : 'outcome' in e.msg
              ? `${e.msg.type}:${e.msg.outcome}`
              : e.msg.type,
        ),
      )}`,
  )
  const clientId = (
    events.find((e) => e.kind === 'json' && e.msg.type === 'welcome') as {
      msg: { clientId: string }
    }
  ).msg.clientId
  return {
    ws,
    clientId,
    events,
    send: (msg: object) => ws.send(JSON.stringify(msg)),
    payloads: () => events.flatMap((e) => (e.kind === 'bytes' ? [e.data] : [])),
    /** Pictures this viewer was served: payloads that start with RIS. */
    pictures: () =>
      events.flatMap((e, i) =>
        e.kind === 'bytes' && e.data[0] === 0x1b && e.data[1] === 0x63 ? [i] : [],
      ),
    async text(): Promise<string> {
      await screen?.flush()
      return trimmed(screen?.lines(false) ?? [])
    },
    close: () => ws.close(),
  }
}

/** What the HOST says the screen is, through a reader connection of its own. */
async function hostScreen(label: string): Promise<{ text: string; cols: number; rows: number }> {
  const conn = connectHost(hostSocketPath(label), { mode: 'reader' })
  try {
    await conn.welcome
    const picture = new Promise<{ bytes: Buffer; cols: number; rows: number }>((resolve) => {
      conn.onItem((item) => {
        if (item.kind === 'picture' && item.reason === 'reset') resolve(item)
      })
    })
    if (!conn.requestPicture()) throw new Error('the host keeps no screen')
    const p = await picture
    const screen = new TerminalScreen({ cols: p.cols, rows: p.rows })
    screen.push(p.bytes)
    await screen.flush()
    return { text: trimmed(screen.lines(false)), cols: p.cols, rows: p.rows }
  } finally {
    conn.detach()
  }
}

/** PIDs recorded from this file's own hosts' WELCOME frames. */
const ownedHosts = new Map<number, string>()

/** Stop only recorded hosts that still own a socket in the private directory. */
function stopOwnHosts(): void {
  for (const [pid, started] of ownedHosts) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] !== started) continue
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      const at = argv.indexOf('--socket')
      if (at < 0 || !(argv[at + 1] ?? '').startsWith(`${HOST_DIR}/`)) continue
      if (!readlinkSync(`/proc/${pid}/exe`).includes('podium-host')) continue
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

describe.skipIf(RUST_HOST === undefined)('viewer catch-up from host pictures (real host)', () => {
  let port: number
  let srv: Awaited<ReturnType<typeof startServer>>
  let daemon: Awaited<ReturnType<typeof startDaemon>>
  let token: string
  let cookie: string

  async function bootServer(): Promise<void> {
    srv = await startServer({ janitorWorkerForTests: noJanitorWorkerForTests, port })
    // Owned by the first admin (whom the viewers log in as), then enrolled
    // with the daemon's token and allowed to run sessions.
    await assignHostMachine(srv.registry.sessionStore)
    await srv.registry.modules.machines.ensureHostMachine('picture-e2e', token, {
      server: true,
      agentExecution: true,
    })
    cookie = (await loginTestClient({ origin: `http://127.0.0.1:${port}`, password: PASSWORD }))
      .cookieHeader
  }
  async function bootDaemon(): Promise<void> {
    daemon = await startDaemon({
      serverUrl: `ws://127.0.0.1:${port}`,
      machineToken: token,
      machineId: srv.registry.modules.machines.hostMachineId,
      hooks: { port: 0 },
      agentRelay: { port: 0 },
      launch: () => ({ cmd: process.execPath, args: [FIXTURE], cwd: '/tmp' }),
    })
    await until(
      () => daemon.connected,
      () => 'daemon never connected',
    )
  }
  const sessionOf = (sid: SessionId) => {
    const s = srv.registry.modules.sessions.sessions.get(sid)
    if (!s) throw new Error(`no session ${sid}`)
    return s
  }
  /** Count what the server's terminal receives for one session from now on. */
  function watch(sid: SessionId) {
    const terminal = sessionOf(sid).terminal
    const seen = { resets: 0, cuts: 0, dataBytes: 0 }
    const acceptOutput = terminal.acceptOutput.bind(terminal)
    // Absent on a server from before pictures, where the C-host row is the
    // control arm: live output and input must behave the same on both.
    if (typeof terminal.acceptPicture === 'function') {
      const acceptPicture = terminal.acceptPicture.bind(terminal)
      terminal.acceptPicture = (p) => {
        if (p.reason === 'reset') seen.resets += 1
        else seen.cuts += 1
        acceptPicture(p)
      }
    }
    terminal.acceptOutput = (bytes, frames) => {
      seen.dataBytes += bytes.byteLength
      acceptOutput(bytes, frames)
    }
    return seen
  }
  async function recordHost(label: string) {
    const conn = connectHost(hostSocketPath(label), { mode: 'reader' })
    try {
      const welcome = await conn.welcome
      const stat = readFileSync(`/proc/${welcome.hostPid}/stat`, 'utf8')
      const started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      if (started === undefined) throw new Error('host start time missing')
      ownedHosts.set(welcome.hostPid, started)
      return welcome
    } finally {
      conn.detach()
    }
  }
  async function liveShell(cHost?: string): Promise<{ sid: SessionId; label: string }> {
    const sid = asSessionId(randomUUID())
    const label = durableSessionLabel(sid)
    let legacyHostPid: number | undefined
    if (cHost) {
      // An older daemon already started this host. The current daemon must
      // adopt its socket; its new-spawn binary remains the Rust host.
      const socketPath = hostSocketPath(label)
      mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 })
      const created = spawnSync(
        cHost,
        hostCreateArgs({
          socketPath,
          cwd: '/tmp',
          cmd: process.execPath,
          args: [FIXTURE],
          cols: 80,
          rows: 24,
        }),
        { encoding: 'utf8', env: process.env },
      )
      expect(created.status, created.stderr).toBe(0)
      legacyHostPid = (await recordHost(label)).hostPid
    }
    await srv.registry.modules.sessions.createSession({
      sessionId: sid,
      agentKind: 'shell',
      cwd: '/tmp',
      machineId: srv.registry.modules.machines.hostMachineId,
    })
    await until(
      () => sessionOf(sid).status === 'live',
      () => `session ${sid} never went live`,
    )
    expect(sessionOf(sid).durableLabel).toBe(label)
    const welcome = await recordHost(label)
    if (cHost) {
      expect(welcome.hostPid).toBe(legacyHostPid)
      expect(readlinkSync(`/proc/${welcome.hostPid}/exe`)).toBe(cHost)
      expect(welcome.features).toBe(0)
      expect(welcome.screen).toBe(false)
    }
    return { sid, label }
  }

  beforeAll(async () => {
    process.env.PODIUM_HOST_BIN = RUST_HOST
    resolveHostBin({ fresh: true })
    port = await freePort()
    token = randomUUID()
    await bootServer()
    await bootDaemon()
  }, 120_000)

  afterAll(async () => {
    await daemon?.close().catch(() => {})
    await srv?.close().catch(() => {})
    stopOwnHosts()
    rmSync(HOST_DIR, { recursive: true, force: true })
  })

  it('a cold attach gets exactly a picture then the tail, and the host’s screen', async () => {
    const { sid, label } = await liveShell()
    const v = await viewer(port, cookie, sid)
    await until(
      () => v.payloads().length > 0,
      () => 'no output',
    )
    // The very first byte is the picture's RIS: nothing older reached it.
    expect(v.payloads()[0]?.subarray(0, 2)).toEqual(Buffer.from('\x1bc'))
    const host = await hostScreen(label)
    expect(host.text).toContain('PODIUM-FIXTURE cols=80 rows=24')
    expect(await v.text()).toBe(host.text)
    v.close()
  }, 60_000)

  it('a resize: every viewer gets a picture at the new size, after the size', async () => {
    const { sid, label } = await liveShell()
    const a = await viewer(port, cookie, sid)
    const b = await viewer(port, cookie, sid)
    await until(
      () => a.pictures().length > 0 && b.pictures().length > 0,
      () => 'not caught up',
    )
    a.send({ type: 'viewState', visible: [sid], focused: sid })
    a.send({
      type: 'viewportRequest',
      sessionId: sid,
      geometry: { cols: 100, rows: 30 },
      visible: true,
      mode: 'native',
      claimControl: true,
    })
    for (const v of [a, b]) {
      await until(
        () => {
          const size = v.events.findIndex(
            (e) => e.kind === 'json' && e.msg.type === 'geometry' && e.msg.cols === 100,
          )
          return size >= 0 && v.pictures().some((i) => i > size)
        },
        () => 'no picture after the new size',
      )
    }
    const host = await hostScreen(label)
    expect(host).toMatchObject({ cols: 100, rows: 30 })
    expect(host.text).toContain('cols=100 rows=30')
    expect(await a.text()).toBe(host.text)
    expect(await b.text()).toBe(host.text)
    a.close()
    b.close()
  }, 60_000)

  it('a controller takeover leaves no viewer blank', async () => {
    const { sid, label } = await liveShell()
    const a = await viewer(port, cookie, sid)
    const b = await viewer(port, cookie, sid)
    await until(
      () => a.pictures().length > 0 && b.pictures().length > 0,
      () => 'not caught up',
    )
    const beforeA = a.pictures().length
    const beforeB = b.pictures().length
    b.send({ type: 'requestControl', sessionId: sid })
    await until(
      () => a.pictures().length > beforeA && b.pictures().length > beforeB,
      () => 'a viewer was left without a picture after the epoch change',
    )
    const host = await hostScreen(label)
    expect(await a.text()).toBe(host.text)
    expect(await b.text()).toBe(host.text)
    a.close()
    b.close()
  }, 60_000)

  it("a spectator's redraw never reaches the program; the controller's does", async () => {
    const { sid, label } = await liveShell()
    const ctl = await viewer(port, cookie, sid)
    const spec = await viewer(port, cookie, sid)
    await until(
      () => ctl.pictures().length > 0 && spec.pictures().length > 0,
      () => 'not caught up',
    )
    const pictures = spec.pictures().length
    spec.send({ type: 'redrawRequest', sessionId: sid })
    await until(
      () => spec.pictures().length > pictures,
      () => 'the spectator was not served again',
    )
    // The fixture repaints with the hex of any input: a Ctrl-L would show 0c.
    expect((await hostScreen(label)).text).toMatch(/^last-input=$/m)
    ctl.send({ type: 'redrawRequest', sessionId: sid })
    await eventually(async () => {
      expect((await hostScreen(label)).text).toMatch(/^last-input=0c$/m)
    })
    ctl.close()
    spec.close()
  }, 60_000)

  it('a daemon restart: one reset picture, zero replayed bytes, and the host’s screen', async () => {
    const { sid, label } = await liveShell()
    const v = await viewer(port, cookie, sid)
    await until(
      () => v.pictures().length > 0,
      () => 'not caught up',
    )
    await daemon.close()
    await until(
      () => sessionOf(sid).status !== 'live',
      () => 'the server never saw the daemon go',
    )
    const seen = watch(sid)
    await bootDaemon()
    await until(
      () => sessionOf(sid).status === 'live' && seen.resets > 0,
      () => `no reset picture after the restart (${JSON.stringify(seen)})`,
    )
    // Long enough for a second request or a ring replay to have shown up.
    await new Promise((r) => setTimeout(r, 2000))
    expect(seen.resets).toBe(1)
    expect(seen.dataBytes).toBe(0)
    const host = await hostScreen(label)
    expect(await v.text()).toBe(host.text)
    v.close()
  }, 90_000)

  it('a server restart: an idle program is not blank after its viewers reattach', async () => {
    const { sid, label } = await liveShell()
    const old = await viewer(port, cookie, sid)
    await until(
      () => old.pictures().length > 0,
      () => 'not caught up',
    )
    old.close()
    await srv.registry.modules.sessions.repository.flushActivity()
    await srv.close()
    await bootServer()
    const v = await viewer(port, cookie, sid)
    await until(
      () => v.pictures().length > 0,
      () => 'the reattached viewer was never served a picture',
      60_000,
    )
    const host = await hostScreen(label)
    expect(host.text).toContain('PODIUM-FIXTURE')
    expect(await v.text()).toBe(host.text)
    v.close()
  }, 120_000)

  it.skipIf(!haveCHost)(
    'a C-host session keeps live output and input, and never sends a picture',
    async () => {
      const { sid } = await liveShell(C_HOST)
      const seen = watch(sid)
      const first = await viewer(port, cookie, sid)
      first.send({ type: 'input', sessionId: sid, data: Buffer.from('b').toString('base64') })
      await until(
        () => Buffer.concat(first.payloads()).toString('latin1').includes('last-input=62'),
        () => 'C host never completed its live paint',
      )
      first.close()
      await until(
        () => sessionOf(sid).terminal.controllerId === null,
        () => 'first viewer never detached',
      )
      const v = await viewer(port, cookie, sid)
      await new Promise((r) => setTimeout(r, 100))
      expect(v.payloads()).toEqual([])
      v.send({ type: 'input', sessionId: sid, data: Buffer.from('a').toString('base64') })
      await until(
        () => Buffer.concat(v.payloads()).toString('latin1').includes('last-input=61'),
        () => 'input never round-tripped',
      )
      expect(seen.resets + seen.cuts).toBe(0)
      v.close()
    },
    60_000,
  )
})
