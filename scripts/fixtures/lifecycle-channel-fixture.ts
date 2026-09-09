/**
 * A stand-in server / daemon that speaks the REAL parent-child lifecycle line
 * (POD-3761), for lifecycle-channel.integration.test.ts.
 *
 * It is spawned by the real `ParentProcess` with the real invocation shape
 * (`bun --conditions=@podium/source <this file> <role> --takeover`, which is
 * what `installInvocation` builds under PODIUM_PARENT_CLI), so the descriptor
 * it talks over is the one the production spawn hands down. Everything it
 * hears or does is written to `run/<role>.<event>.json` in the state dir,
 * because the line it would otherwise report over is the thing under test.
 *
 * Env knobs:
 *   FIXTURE_<ROLE>_DEGRADED=<reason>   say degraded right after ready
 *   FIXTURE_PROBE_GRANDCHILD=1         spawn grandchildren and record what they can see
 *   FIXTURE_DIGEST                     the digest to claim in `ready`
 *   FIXTURE_HEARTBEAT_MS               heartbeat cadence (default 100)
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectLifecycleChannel } from '../../packages/runtime/src/lifecycle-channel'

const role = process.argv[2] as 'server' | 'daemon'
const stateDir = process.env.PODIUM_STATE_DIR ?? process.cwd()
const runDir = join(stateDir, 'run')
mkdirSync(runDir, { recursive: true })

function note(event: string, value: unknown): void {
  writeFileSync(join(runDir, `${role}.${event}.json`), JSON.stringify(value))
}

/** Say the last word, then leave; the frame needs a tick to reach the pipe. */
function leave(reason: string): void {
  lifecycle?.stopping(reason)
  setTimeout(() => process.exit(0), 50)
}

const lifecycle = connectLifecycleChannel({
  role,
  version: process.env.PODIUM_APP_VERSION ?? 'dev',
  ...(process.env.FIXTURE_DIGEST ? { digest: process.env.FIXTURE_DIGEST } : {}),
  heartbeatMs: Number(process.env.FIXTURE_HEARTBEAT_MS ?? 100),
})
note('channel', { present: lifecycle !== undefined, pid: process.pid })

lifecycle?.onIdentity((identity) => note('identity', identity))
lifecycle?.onStop((reason) => {
  note('stop', { reason })
  leave(`asked to stop: ${reason}`)
})
lifecycle?.onSupervisorGone(() => {
  note('gone', { atMs: Date.now() })
  process.exit(0)
})
process.on('SIGTERM', () => leave('SIGTERM'))

lifecycle?.ready(role === 'server' ? { port: Number(process.env.PODIUM_PORT) } : {})
const degraded = process.env[`FIXTURE_${role.toUpperCase()}_DEGRADED`]
if (degraded) lifecycle?.degraded(degraded)

/**
 * What a grandchild can see. The probe reads `process.send` and the type of
 * descriptor 3 from INSIDE the grandchild, so a leak would show as a function
 * and a socket. A control grandchild is deliberately handed a channel, to prove
 * the probe can see one when it is there — a "contained" verdict from a probe
 * that cannot detect a leak would mean nothing.
 */
const PROBE = `
  const fs = require('node:fs')
  let fd3 = 'closed'
  try { const st = fs.fstatSync(3); fd3 = st.isSocket() ? 'socket' : st.isFIFO() ? 'fifo' : 'other' } catch {}
  process.stdout.write(JSON.stringify({ send: typeof process.send, fd3, env: 'NODE_CHANNEL_FD' in process.env }))
`
function probeGrandchild(withChannel: boolean): Promise<unknown> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', PROBE], {
      stdio: withChannel ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout?.on('data', (chunk) => (out += chunk))
    child.on('close', () => {
      try {
        resolve(JSON.parse(out))
      } catch {
        resolve({ error: out })
      }
    })
    // A grandchild given a channel stays alive on it; the probe's one write is all we need.
    child.on('spawn', () => setTimeout(() => child.kill(), 2_000).unref())
  })
}
if (process.env.FIXTURE_PROBE_GRANDCHILD === '1') {
  void Promise.all([probeGrandchild(false), probeGrandchild(true)]).then(([ordinary, control]) =>
    note('grandchildren', { ordinary, control }),
  )
}

// A server that runs until told otherwise.
setInterval(() => {}, 1_000)
