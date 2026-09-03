import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Force the production host through its scoped argv while replacing only the
// machine-level systemd housekeeping. The fake systemd-run below still starts
// a real child and waits for that child, so the transport observes the same
// wrapper -> ACP process exit boundary without depending on a user manager.
vi.mock('@podium/pty', async () => {
  const actual = await vi.importActual<typeof import('@podium/pty')>('@podium/pty')
  return {
    ...actual,
    applySessionsSliceBudget: async () => {},
    canScopeMaster: async () => true,
    scopeReclaimArgvs: () => [],
  }
})

import { createGrokAcpHost, grokAcpVersionProbe, resetGrokAcpVersionProbe } from './grok-acp-server'
import { createDaemonGrokRuntime } from './grok-driver'

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
      PODIUM_TEST_CHILD_PID: process.env.PODIUM_TEST_CHILD_PID,
      PODIUM_TEST_SCOPE_ARGS: process.env.PODIUM_TEST_SCOPE_ARGS,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    }
    let runtime: ReturnType<typeof createDaemonGrokRuntime> | undefined
    try {
      process.env.PATH = `${rig.bin}:${previous.PATH ?? ''}`
      process.env.PODIUM_STATE_DIR = join(root, 'state')
      process.env.PODIUM_TEST_CHILD_PID = rig.childPid
      process.env.PODIUM_TEST_SCOPE_ARGS = rig.scopeArgs
      process.env.XDG_RUNTIME_DIR = join(root, 'runtime')

      expect(await grokAcpVersionProbe()).toEqual({ drivable: true })
      const sent: DaemonMessage[] = []
      const host = createGrokAcpHost({ resources: () => undefined })
      runtime = createDaemonGrokRuntime({ send: (message) => sent.push(message), host })
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
    }
  }, 30_000)
})
