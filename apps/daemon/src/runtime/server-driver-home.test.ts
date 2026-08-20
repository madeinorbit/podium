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
}

let root: string
let instanceHome: string
let workdir: string
let previousStateDir: string | undefined

/**
 * A fake harness binary. A `/bin/sh` wrapper exec's the test runtime itself
 * (`process.execPath`) on a helper that: writes its env to the landing file
 * named by `PODIUM_TEST_LANDING`, then — when launched as `opencode serve`
 * (`--port` present) — answers `/global/health` so `waitForReady` passes, or
 * otherwise just stays alive on a timer until the endpoint kills it.
 */
const HELPER_SOURCE = `
const fs = require('node:fs')
const crypto = require('node:crypto')
const http = require('node:http')
fs.writeFileSync(process.env.PODIUM_TEST_LANDING, JSON.stringify({
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  MANAGED: process.env.PODIUM_TEST_MANAGED,
}))
if (process.argv.includes('--rig-check')) process.exit(0)
const portIx = process.argv.indexOf('--port')
const listenIx = process.argv.indexOf('--listen')
if (listenIx >= 0 && process.argv[listenIx + 1]?.startsWith('unix://')) {
  const path = process.argv[listenIx + 1].slice('unix://'.length)
  try { fs.unlinkSync(path) } catch {}
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = crypto
      .createHash('sha1')
      .update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + accept,
      '',
      '',
    ].join('\\r\\n'))
    socket.on('data', () => {})
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
  process.env.PODIUM_STATE_DIR = join(root, 'state')
  for (const name of ['opencode', 'codex', 'grok']) installFakeBinary(name)
})

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.PODIUM_STATE_DIR
  else process.env.PODIUM_STATE_DIR = previousStateDir
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
      env: { PODIUM_TEST_LANDING: landing, PODIUM_TEST_MANAGED: 'rides-through' },
    })
    try {
      const seen = await readLanding(landing)
      expect(seen.HOME).toBe(instanceHome)
      expect(seen.HOME).not.toBe(process.env.HOME)
      expect(seen.MANAGED).toBe('rides-through')
      const socketPath = endpoint.clientAddress.slice('unix://'.length)
      expect(socketPath.startsWith(join(root, 'state', 'runtime'))).toBe(true)
      expect(statSync(join(root, 'state', 'runtime', 'codex-app-server-sockets')).mode & 0o777).toBe(
        0o700,
      )
      expect(statSync(socketPath).mode & 0o777).toBe(0o600)
    } finally {
      await endpoint.kill()
    }
  }, 30_000)

  it('grok agent stdio: the child itself reports the instance HOME — the live find', async () => {
    resetGrokAcpVersionProbe()
    expect((await grokAcpVersionProbe(() => ({ output: '0.2.23', ok: true }))).drivable).toBe(true)

    const landing = join(root, 'landing-grok.json')
    const host = createGrokAcpHost({ resources, homeDir: instanceHome })
    const endpoint = await host.launch({
      sessionId: asSessionId(crypto.randomUUID()),
      workdir,
      env: { PODIUM_TEST_LANDING: landing, PODIUM_TEST_MANAGED: 'rides-through' },
    })
    try {
      const seen = await readLanding(landing)
      expect(seen.HOME).toBe(instanceHome)
      expect(seen.HOME).not.toBe(process.env.HOME)
      expect(seen.MANAGED).toBe('rides-through')
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
