import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Force the production host through its scoped argv while replacing only the
// machine-level systemd housekeeping. The fake systemd-run below still starts
// a real podium-host (which daemonizes the ACP child), so the transport
// observes the same wrapper -> host -> ACP process exit boundary without
// depending on a user manager. The child's SIGKILL surfaces as the host's
// EXITED frame, which is what the daemon reports.
vi.mock('@podium/process/durable', async () => {
  const actual = await vi.importActual<typeof import('@podium/process/durable')>('@podium/process/durable')
  return {
    ...actual,
    applySessionsSliceBudget: async () => {},
    canScopeMaster: async () => true,
    scopeReclaimArgvs: () => [],
  }
})

import { createGrokEngineHost, grokEngineFacts } from '@podium/harness/driver/host'
import { manifestFor } from '@podium/harness'
import { grokAcpVersionProbe, resetGrokAcpVersionProbe } from './version-probe'
import { composeEngineEnv } from './host'
import { createSessionEngineScope } from '../session/engines.js'
import { SERVER_GRACEFUL_EXIT_MS } from './server-teardown-budget'
import { createDurableProcess } from '@podium/process/durable'
import { createGrokSessionRuntime } from '@podium/harness/driver/host'
import { driverSlotsOver } from '../session/driver-slots.js'
import { testSessions } from '../session/testing.js'
import { SessionRegistry } from '../session/registry.js'

const CHILD_HELPER = `
const fs = require('node:fs')

if (process.argv.includes('--version')) {
  process.stdout.write('grok 0.2.23\\n')
  process.exit(0)
}

fs.writeFileSync(process.env.PODIUM_TEST_CHILD_PID, String(process.pid))
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let boundary = buffer.indexOf('\\n')
  while (boundary >= 0) {
    const line = buffer.slice(0, boundary)
    buffer = buffer.slice(boundary + 1)
    boundary = buffer.indexOf('\\n')
    if (!line.trim()) continue
    let request
    try { request = JSON.parse(line) } catch { continue }
    if (request.id === undefined) continue
    let result = {}
    if (request.method === 'initialize') {
      result = { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    } else if (request.method === 'session/new') {
      result = { sessionId: 'native-real-child-exit' }
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
setInterval(() => {}, 60_000)
`

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function installScopedRig(root: string): { bin: string; childPid: string; scopeArgs: string } {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const helper = join(root, 'grok-helper.cjs')
  const childPid = join(root, 'child.pid')
  const scopeArgs = join(root, 'scope-args.txt')
  writeFileSync(helper, CHILD_HELPER)
  const grok = join(bin, 'grok')
  writeFileSync(grok, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helper)} "$@"\n`)
  chmodSync(grok, 0o755)

  // This is a synchronous scope wrapper with inherited stdio, matching the
  // `systemd-run --scope` contract that the host relies on for ACP framing.
  const systemdRun = join(bin, 'systemd-run')
  writeFileSync(
    systemdRun,
    `#!/bin/sh
printf '%s\\n' "$*" > "$PODIUM_TEST_SCOPE_ARGS"
while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done
if [ "$#" -eq 0 ]; then exit 64; fi
shift
# dash redirects an async command's stdin to /dev/null even with <&0;
# duplicate the wrapper's protocol pipe before backgrounding the ACP child.
exec 3<&0
"$@" <&3 &
child=$!
trap 'kill "$child" 2>/dev/null || true' TERM INT HUP
wait "$child"
status=$?
exit "$status"
`,
  )
  chmodSync(systemdRun, 0o755)
  return { bin, childPid, scopeArgs }
}

afterEach(() => resetGrokAcpVersionProbe())

describe('Grok ACP real scoped child boundary', () => {
  it('emits a daemon exit when the exact child inside the scope is killed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-grok-acp-exit-'))
    const rig = installScopedRig(root)
    const previous = {
      PATH: process.env.PATH,
      PODIUM_STATE_DIR: process.env.PODIUM_STATE_DIR,
      PODIUM_HOST_SOCKET_DIR: process.env.PODIUM_HOST_SOCKET_DIR,
      PODIUM_TEST_CHILD_PID: process.env.PODIUM_TEST_CHILD_PID,
      PODIUM_TEST_SCOPE_ARGS: process.env.PODIUM_TEST_SCOPE_ARGS,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    }
    let runtime: ReturnType<typeof createGrokSessionRuntime> | undefined
    let hostSockets = ''
    try {
      process.env.PATH = `${rig.bin}:${previous.PATH ?? ''}`
      process.env.PODIUM_STATE_DIR = join(root, 'state')
      // The engine runs under a REAL podium-host here (POD-4433): its socket
      // path carries instance + label and must fit sun_path, which the deep
      // test root cannot afford — shortest writable system tmp wins.
      hostSockets = shortSockRoot()
      process.env.PODIUM_HOST_SOCKET_DIR = hostSockets
      process.env.PODIUM_TEST_CHILD_PID = rig.childPid
      process.env.PODIUM_TEST_SCOPE_ARGS = rig.scopeArgs
      process.env.XDG_RUNTIME_DIR = join(root, 'runtime')

      expect(await grokAcpVersionProbe()).toEqual({ drivable: true })
      const sent: DaemonMessage[] = []
      const facts = grokEngineFacts(manifestFor('grok')!)
      const durable = createDurableProcess('host', { host: true, abduco: false })
      const engines = createSessionEngineScope(durable, { sessions: new SessionRegistry() })
      const host = createGrokEngineHost({
        facts,
        engines: engines.ownerFor(facts.journalNamespace),
        supervision: engines,
        resources: () => undefined,
        buildEnv: composeEngineEnv,
        gracefulExitMs: SERVER_GRACEFUL_EXIT_MS,
        checkVersion: () => grokAcpVersionProbe(),
      })
      runtime = createGrokSessionRuntime({ driverSlots: driverSlotsOver(testSessions()),
        facts,
        engine: host,
        send: (message) => sent.push(message),
        emitBind: (bind) => {
          sent.push({ type: 'bind', ...bind })
        },
        sessionReady: () => {},
        traceRuntimeEvent: () => {},
        startMailContinuation: () => () => {},
      })
      const sessionId = asSessionId('grok-real-scoped-exit')

      await runtime.launch({ sessionId, cwd: root })
      expect(readFileSync(rig.scopeArgs, 'utf8')).toContain('--scope')
      const childPid = Number(readFileSync(rig.childPid, 'utf8'))
      expect(childPid).toBeGreaterThan(0)
      expect(sent).toContainEqual(expect.objectContaining({ type: 'bind', sessionId }))

      process.kill(childPid, 'SIGKILL')

      await vi.waitFor(
        () =>
          expect(sent).toContainEqual(
            expect.objectContaining({
              type: 'agentExit',
              sessionId,
              code: 0,
              observerGeneration: 1,
            }),
          ),
        { timeout: 10_000 },
      )
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: 'runtimeEvent',
          sessionId,
          event: expect.objectContaining({
            t: 'process',
            ev: expect.objectContaining({ ev: 'exited' }),
          }),
        }),
      )
      expect(runtime.handleFor(sessionId)).toBeUndefined()
    } finally {
      runtime?.dispose()
      try {
        const childPid = Number(readFileSync(rig.childPid, 'utf8'))
        process.kill(childPid, 'SIGKILL')
      } catch {
        // The exact child already exited.
      }
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
      if (hostSockets) rmSync(hostSockets, { recursive: true, force: true })
    }
  }, 30_000)
})

/** The shortest writable system tmp: host socket paths must fit sun_path. */
function shortSockRoot(): string {
  for (const base of ['/tmp', '/var/tmp', tmpdir()]) {
    try {
      return mkdtempSync(join(base, 'pod-4433-h-'))
    } catch {
      // Next candidate.
    }
  }
  throw new Error('no writable tmp base for podium-host sockets')
}
