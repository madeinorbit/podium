/**
 * THE INSTANCE-HOME REGRESSION, PER DRIVER (POD-2247).
 *
 * All three server-driver hosts used to spawn their agent children with a bare
 * `{ ...process.env, ...input.env }`, so a named instance's opencode/codex/grok
 * children inherited the daemon's REAL `HOME` — found live when an isolated
 * grok session refreshed the operator's real `~/.grok` credentials within
 * seconds of spawn. The PTY path never had the bug (`ctx.homeDir` rides
 * `spawnEnv`'s overlay).
 *
 * These tests assert the fix END TO END, per the issue's acceptance: the child
 * itself reports its env — a fake harness binary installed under the INSTANCE
 * home's `.local/bin` (which `serverChildEnv`'s PATH derivation makes
 * authoritative, the same derivation that makes the fake resolvable at all)
 * writes its own `HOME` to a landing file, and the assertion reads the child's
 * write, not the composition function.
 */

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  codexAppServerVersionProbe,
  createCodexHost,
  resetCodexAppServerVersionProbe,
} from './codex-app-server'
import { createGrokAcpHost, grokAcpVersionProbe, resetGrokAcpVersionProbe } from './grok-acp-server'
import {
  createOpencodeHost,
  opencodeVersionProbe,
  resetOpencodeVersionProbe,
} from './opencode-server'

// UNSCOPED, before anything asks: with a live systemd user manager the launch
// would ride `systemd-run` into a transient scope — correct in production,
// noise here. `canScopeMaster` memoizes its first answer for the process life.
process.env.PODIUM_NO_SCOPE = '1'

/** The child's own report: written by the fake binary, read by the test. */
interface Landing {
  HOME: string | undefined
  PATH: string | undefined
  MANAGED: string | undefined
  CODEX_HOME: string | undefined
  GROK_HOME: string | undefined
  PODIUM_INSTANCE_UUID: string | undefined
  PODIUM_SESSION_ID: string | undefined
}
let previousRuntimeDir: string | undefined
let previousInstance: string | undefined

let root: string
let instanceHome: string
let workdir: string
let previousStateDir: string | undefined
let previousCodexHome: string | undefined
let previousGrokHome: string | undefined

/**
 * A fake harness binary. A `/bin/sh` wrapper exec's the test runtime itself
 * (`process.execPath`) on a helper that writes its env to the landing file named
 * by `PODIUM_TEST_LANDING` and then plays whichever harness it was invoked as:
 *
 *   - `--listen unix://…` (codex app-server) — accepts the WebSocket upgrade so
 *     `launch()`'s connect can complete;
 *   - `--port` (opencode serve) — answers `/global/health` so `waitForReady`
 *     passes;
 *   - neither (grok, on stdio) — just stays alive until the endpoint kills it.
 *
 * IT RUNS UNDER THE TEST RUNTIME, which is what makes the choice of listener
 * below load-bearing rather than incidental.
 */
const HELPER_SOURCE = `
const fs = require('node:fs')
const crypto = require('node:crypto')
const http = require('node:http')
const net = require('node:net')
fs.writeFileSync(process.env.PODIUM_TEST_LANDING, JSON.stringify({
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  MANAGED: process.env.PODIUM_TEST_MANAGED,
  CODEX_HOME: process.env.CODEX_HOME,
  GROK_HOME: process.env.GROK_HOME,
  PODIUM_INSTANCE_UUID: process.env.PODIUM_INSTANCE_UUID,
  PODIUM_SESSION_ID: process.env.PODIUM_SESSION_ID,
}))
if (process.argv.includes('--rig-check')) process.exit(0)
const portIx = process.argv.indexOf('--port')
const listenIx = process.argv.indexOf('--listen')
if (listenIx >= 0 && process.argv[listenIx + 1]?.startsWith('unix://')) {
  const path = process.argv[listenIx + 1].slice('unix://'.length)
  try { fs.unlinkSync(path) } catch {}
  // A RAW listener, deliberately not \`node:http\`. This fake runs under the test
  // runtime, which is Bun, and Bun's http server never delivers a hand-written
  // 101 out of an 'upgrade' handler — the client just waits, which is how this
  // rig used to hang for its whole timeout instead of failing (POD-2484). Real
  // Codex speaks the same bytes off a raw socket anyway.
  const server = net.createServer((socket) => {
    let pending = ''
    let upgraded = false
    socket.on('data', (chunk) => {
      if (upgraded) return // Everything after the handshake is framed traffic.
      pending += chunk.toString('latin1')
      const end = pending.indexOf('\\r\\n\\r\\n')
      if (end < 0) return
      const key = /sec-websocket-key:[ \\t]*([^\\r\\n]+)/i.exec(pending.slice(0, end))
      upgraded = true
      if (!key) return socket.end('HTTP/1.1 400 Bad Request\\r\\n\\r\\n')
      const accept = crypto
        .createHash('sha1')
        .update(key[1].trim() + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64')
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Accept: ' + accept,
        '',
        '',
      ].join('\\r\\n'))
    })
    // \`kill()\` terminates the client socket before the SIGKILL lands, and a
    // destroy that arrives as an RST rather than a FIN would otherwise be an
    // unhandled 'error' that takes this whole fake down mid-teardown.
    socket.on('error', () => {})
  })
  server.listen(path)
} else if (portIx >= 0) {
  const server = http.createServer((req, res) => { res.statusCode = 200; res.end('ok') })
  server.listen(Number(process.argv[portIx + 1]), '127.0.0.1')
} else {
  setInterval(() => {}, 60_000)
}
`

function installFakeBinary(name: string): void {
  const binDir = join(instanceHome, '.local', 'bin')
  mkdirSync(binDir, { recursive: true })
  const helper = join(root, 'fake-harness.cjs')
  writeFileSync(helper, HELPER_SOURCE)
  const wrapper = join(binDir, name)
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${helper}" "$@"\n`)
  chmodSync(wrapper, 0o755)
}

async function readLanding(path: string, timeoutMs = 10_000): Promise<Landing> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Landing
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error(`the fake harness never wrote its landing file at ${path}`)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'podium-2247-'))
  instanceHome = join(root, 'agent-home')
  workdir = join(root, 'workdir')
  mkdirSync(instanceHome, { recursive: true })
  mkdirSync(workdir, { recursive: true })
  // The journals live under the state dir; keep this test's writes out of the
  // machine's real one.
  previousStateDir = process.env.PODIUM_STATE_DIR
  previousCodexHome = process.env.CODEX_HOME
  previousGrokHome = process.env.GROK_HOME
  previousRuntimeDir = process.env.XDG_RUNTIME_DIR
  previousInstance = process.env.PODIUM_INSTANCE
  process.env.XDG_RUNTIME_DIR = join(root, 'runtime')
  process.env.PODIUM_INSTANCE = 'named-instance'
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  process.env.CODEX_HOME = '/daemon/operator/.codex'
  process.env.GROK_HOME = '/daemon/operator/.grok'
  for (const name of ['opencode', 'codex', 'grok']) installFakeBinary(name)
})

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.PODIUM_STATE_DIR
  else process.env.PODIUM_STATE_DIR = previousStateDir
  if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR
  else process.env.XDG_RUNTIME_DIR = previousRuntimeDir
  if (previousInstance === undefined) delete process.env.PODIUM_INSTANCE
  else process.env.PODIUM_INSTANCE = previousInstance
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousCodexHome
  if (previousGrokHome === undefined) delete process.env.GROK_HOME
  else process.env.GROK_HOME = previousGrokHome
  rmSync(root, { recursive: true, force: true })
})

const resources = () => undefined

describe('a launched server-driver child runs in the INSTANCE home', () => {
  it('opencode serve: the child itself reports the instance HOME', async () => {
    // Prime the memoized verdict so `launch()`'s own parameterless probe call
    // hits the cache instead of forking the machine's real binary.
    resetOpencodeVersionProbe()
    expect((await opencodeVersionProbe(() => ({ output: '1.18.16', ok: true }))).drivable).toBe(
      true,
    )

    const landing = join(root, 'landing-opencode.json')
    const host = createOpencodeHost({ resources, homeDir: instanceHome })
    const endpoint = await host.launch({
      sessionId: asSessionId(crypto.randomUUID()),
      workdir,
      secret: 'test-secret',
      username: 'podium',
      env: { PODIUM_TEST_LANDING: landing, PODIUM_TEST_MANAGED: 'rides-through' },
    })
    try {
      const seen = await readLanding(landing)
      expect(seen.HOME).toBe(instanceHome)
      expect(seen.HOME).not.toBe(process.env.HOME)
      expect(seen.PATH?.startsWith(join(instanceHome, '.local', 'bin'))).toBe(true)
      expect(seen.MANAGED).toBe('rides-through')
      // Isolation is harness-owned, not a global allowlist: opencode does not
      // read either selector, so unrelated machine settings still ride through.
      expect(seen.CODEX_HOME).toBe('/daemon/operator/.codex')
      expect(seen.GROK_HOME).toBe('/daemon/operator/.grok')
    } finally {
      await endpoint.kill()
    }
  }, 30_000)

  it('codex app-server: the child itself reports the instance HOME', async () => {
    resetCodexAppServerVersionProbe()
    expect(
      (await codexAppServerVersionProbe(() => ({ output: '0.147.0', ok: true }))).drivable,
    ).toBe(true)

    const landing = join(root, 'landing-codex.json')
    const host = createCodexHost({ resources, homeDir: instanceHome })
    const endpoint = await host.launch({
      sessionId: asSessionId(crypto.randomUUID()),
      workdir,
      env: {
        PODIUM_TEST_LANDING: landing,
        PODIUM_TEST_MANAGED: 'rides-through',
      },
    })
    try {
      const seen = await readLanding(landing)
      expect(seen.HOME).toBe(instanceHome)
      expect(seen.HOME).not.toBe(process.env.HOME)
      expect(seen.MANAGED).toBe('rides-through')
      expect(seen.CODEX_HOME).toBe(join(instanceHome, '.codex'))
      expect(seen.CODEX_HOME).not.toBe('/daemon/operator/.codex')
      const socketPath = endpoint.clientAddress.slice('unix://'.length)
      const socketRoot = join(root, 'runtime', 'podium-named-instance')
      expect(socketPath.startsWith(socketRoot)).toBe(true)
      expect(statSync(socketRoot).mode & 0o777).toBe(0o700)
      expect(statSync(socketPath).mode & 0o777).toBe(0o600)
    } finally {
      await endpoint.kill()
    }
  }, 30_000)

  it('grok agent stdio: the child reports instance HOME and exact lifecycle stamps', async () => {
    resetGrokAcpVersionProbe()
    expect((await grokAcpVersionProbe(() => ({ output: '0.2.23', ok: true }))).drivable).toBe(true)

    const landing = join(root, 'landing-grok.json')
    const instanceUuid = '11111111-2222-4333-8444-555555555555'
    const sessionId = asSessionId('grok-stamped-child')
    const host = createGrokAcpHost({ resources, homeDir: instanceHome, instanceUuid })
    const endpoint = await host.launch({
      sessionId,
      workdir,
      env: {
        PODIUM_TEST_LANDING: landing,
        PODIUM_TEST_MANAGED: 'rides-through',
        // Daemon-owned attribution must win over anything carried by the spawn frame.
        PODIUM_INSTANCE_UUID: 'spoofed-instance',
        PODIUM_SESSION_ID: 'spoofed-session',
      },
    })
    try {
      const seen = await readLanding(landing)
      expect(seen.HOME).toBe(instanceHome)
      expect(seen.HOME).not.toBe(process.env.HOME)
      expect(seen.MANAGED).toBe('rides-through')
      expect(seen.GROK_HOME).toBe(join(instanceHome, '.grok'))
      expect(seen.GROK_HOME).not.toBe('/daemon/operator/.grok')
      expect(seen.PODIUM_INSTANCE_UUID).toBe(instanceUuid)
      expect(seen.PODIUM_SESSION_ID).toBe(sessionId)
    } finally {
      await endpoint.kill()
    }
  }, 30_000)
})

it('the fake harness wrapper actually runs on this machine (test-rig sanity)', () => {
  // If /bin/sh or the exec'd runtime is unavailable the three tests above would
  // fail with a spawn ENOENT four layers deep; this names the rig problem.
  const result = spawnSync(join(instanceHome, '.local', 'bin', 'grok'), ['--rig-check'], {
    env: {
      ...process.env,
      PODIUM_TEST_LANDING: join(root, 'landing-rig.json'),
      HOME: instanceHome,
    },
    timeout: 10_000,
  })
  expect(result.error).toBeUndefined()
})
