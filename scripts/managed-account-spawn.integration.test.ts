/**
 * END-TO-END: a managed credential reaches a REAL spawned process's environment (#216).
 *
 * Every layer of the managed-account path has unit tests. What none of them prove is the
 * thing the feature actually promises — that the credential Podium holds server-side ends
 * up in the environment of the agent process the daemon forks. This test proves it by
 * dumping a real process's real environment and reading the value back out of the PTY.
 *
 * It drives the WHOLE chain, no layer faked:
 *
 *   a credential              (its record, held in memory here; the vault read is
 *                              attachAccess's, tested in apps/server)
 *     -> resolveSessionAccess apps/server/src/modules/credentials/access.ts
 *                              (the harness's declared `accepts` line -> env var)
 *     -> the `access` field   (epic Task 5: never the frame's plain `env`)
 *     -> SpawnMessage.parse   packages/protocol/.../terminal.ts      (real zod wire round-trip)
 *     -> sessionHandlers.spawn apps/daemon/src/control/session.ts    (the real handler,
 *                              which keeps the access in the daemon's memory store)
 *     -> the terminal launch  -> a real /bin/bash standing in for claude, on a real PTY
 *     -> `env` -> assert on the bytes the child actually printed
 *
 * Lives in scripts/ because it is the only tier permitted to compose apps/server AND
 * apps/daemon in one process (check-boundaries rule 5, same allowance scripts/host.ts uses).
 *
 * PTY HYGIENE: Podium leaks detached PTY masters when a test forgets to reap (see the
 * agent-bridge notes). Backend is 'none' — a bare Bun.Terminal child, no process host to
 * outlive us — and every spawn is disposed by explicit pid and confirmed dead. Nothing here
 * ever pattern-kills, which would be capable of killing the developer's live agents.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentLaunchCommand } from '@podium/harness'
import { asCredentialId, asMachineId, asSessionId, asUserId, type SessionId } from '@podium/model'
import {
  createDurableProcess,
  type DurableProcess,
  directPtyDurableForTests,
  isHostAvailable,
} from '@podium/process/durable'
import { type AccessField, SpawnMessage } from '@podium/protocol'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryMarkers, SessionAccessStore } from '../apps/daemon/src/control/access'
import type { DaemonContext } from '../apps/daemon/src/control/context'
import { launchTerminalProcess, sessionHandlers } from '../apps/daemon/src/control/session'
import { SessionRegistry } from '../apps/daemon/src/session/registry.js'
import { testTerminalRuntime } from '../apps/daemon/src/session/testing.js'
import {
  type AccessDeps,
  resolveSessionAccess,
} from '../apps/server/src/modules/credentials/access'

/** Whose key it is: the session owner (POD-6360, managed keys are per user). */
const OWNER = asUserId('user:spawn-probe-owner')

const CREDENTIAL = 'sk-test-xyz'

/** The owner runs on their own machine. */
const ownMachine = asMachineId('machine-owner')

/**
 * The server side: a credential of `type`, resolved for claude-code on the
 * owner's own machine, as the `access` field the spawn frame carries (epic
 * Task 5). The secret stands in for what `attachAccess` reads from the vault.
 */
async function resolvedAccess(type: string, secret: string): Promise<AccessField> {
  const id = asCredentialId('cred_00000000-0000-4000-8000-000000000216')
  const record = {
    id,
    ownerUserId: OWNER,
    label: type,
    type,
    identity: {},
    status: 'ok',
    statusReason: null,
    expiresAt: null,
    verifiedAt: null,
    legacyId: null,
    legacyKey: null,
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: '2026-11-13T00:00:00.000Z',
  }
  // Only what the resolver reads: the record, the machine's custodian, the event trail.
  const deps = {
    credentials: { get: async () => record, isMachineAllowed: async () => false },
    machines: { custodian: async () => OWNER, getMachine: async () => undefined },
    settingsAudit: { append: async () => {} },
    // The owner uses their own credential: no grant is read for it, none exist.
    grants: { loadForResource: async () => [] },
  } as unknown as AccessDeps
  const plan = await resolveSessionAccess(deps, {
    harness: 'claude-code',
    credentialId: id,
    actingUserId: OWNER,
    machineId: ownMachine,
  })
  if (!plan.ok || plan.delivery.kind !== 'env') {
    throw new Error(`no env delivery for ${type}: ${JSON.stringify(plan)}`)
  }
  return { credentialId: id, delivery: { ...plan.delivery, secret } }
}

interface Harness {
  ctx: DaemonContext
  sent: DaemonMessage[]
  /** Everything the child wrote to its PTY, as the daemon relayed it. */
  output(): string
  /** Resolves once no new PTY frame has arrived for `quietMs` — so an absence
   *  assertion can't pass merely because the output hadn't arrived yet. */
  settled(quietMs?: number): Promise<void>
  /** Ends a podium-host session by its label (the real-host harness only). */
  hostKill?(label: string): Promise<void>
}

function makeHarness(
  settingsDir: string,
  // The real podium-host, for a credential that goes in on a pipe (POD-7378):
  // only the host hands one over; the direct-pty double refuses it.
  host?: DurableProcess,
): Harness {
  const sent: DaemonMessage[] = []
  let buffer = ''
  let lastFrameAt = Date.now()
  const ctx = {
    send: (m: DaemonMessage) => sent.push(m),
    // 'none' + the direct-pty test double = a bare Bun.Terminal child. No durable
    // master can survive this test. A daemon with no durable process refuses to
    // spawn at all (POD-4617), so the double is what stands in for one.
    machineId: 'local',
    instanceId: 'blue',
    durableLabelFor: (id: string) => `podium-blue-${id}`,
    sessions: new SessionRegistry(),
    homeDir: home,
    backend: 'none',
    durable: host ?? directPtyDurableForTests(),
    // The REAL launch table for a shell; a claude session runs an interactive
    // bash in claude's place, so the test can ask the process for its env
    // while the daemon's whole claude launch (context, strip, credential,
    // hide-from-commands) runs for real around it.
    launch: (kind: string, opts: { cwd: string }) =>
      kind === 'shell'
        ? agentLaunchCommand('shell', opts)
        : { cmd: '/bin/bash', args: ['--norc', '--noprofile', '-i'], cwd: opts.cwd },
    settingsDir,
    // Draft sync is outside this env-propagation lane; keep the real spawn,
    // frame, and exit path explicit while disabling its optional driver.
    composerEngine: {
      attach: () => false,
      onData: () => {},
      // The real host reports its size; the double never does.
      onResize: () => {},
      detach: () => {},
      has: () => false,
    },
    // wireBridge pipes every PTY frame here — this is the daemon's real relay seam,
    // so we assert on exactly the bytes the daemon would have shipped to the server.
    outputScheduler: {
      enqueue: (_id: string, data: string) => {
        buffer += Buffer.from(data, 'base64').toString('utf8')
        lastFrameAt = Date.now()
      },
      remove: () => {},
    },
    observers: { initSessionObservers: () => {}, clearSession: () => {} },
    // Both methods the real spawn handler reaches for: it pins the launch cwd on every
    // spawn (unawaited) and clears on exit. A stub missing one throws from inside the
    // handler, which surfaces here as a spawnError, not as a type error — `as unknown as
    // DaemonContext` below erases the shape, and scripts/ is outside the typecheck.
    sessionCwdTracker: { setLaunchCwd: async () => {}, clear: () => {} },
    primeInjector: { reset: () => {} },
    // Binding semantics have their own transition suite. This lane observes the
    // downstream real PTY environment, so it supplies an accepted transition
    // service while still requiring the server-authored instruction below.
    sessionBinding: {
      transition: async (input: { event: 'spawn' }) => ({
        status: 'unchanged' as const,
        event: input.event,
        binding: {} as never,
      }),
    },
    hookEndpointFor: (id: string) => `http://127.0.0.1:1/hook/${id}`,
    agentRelayEndpointFor: (id: string) => `http://127.0.0.1:1/relay/${id}`,
    access: new SessionAccessStore({ markers: memoryMarkers() }),
  } as unknown as DaemonContext
  // An agent spawn needs a runtime to create it; this one runs the daemon's
  // real terminal launch.
  ctx.agentRuntime = testTerminalRuntime(
    ctx,
    launchTerminalProcess,
  ) as unknown as DaemonContext['agentRuntime']

  return {
    ctx,
    sent,
    ...(host ? { hostKill: (label: string) => host.kill(label) } : {}),
    output: () => buffer,
    async settled(quietMs = 250) {
      while (Date.now() - lastFrameAt < quietMs) await new Promise((r) => setTimeout(r, 25))
    },
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let settingsDir: string
let home: string

beforeEach(() => {
  settingsDir = mkdtempSync(join(tmpdir(), 'podium-spawn-settings-'))
  home = mkdtempSync(join(tmpdir(), 'podium-spawn-home-'))
  // The daemon hands its OWN environment down to the agent (spawnAgent spreads
  // process.env), so the negative case can only mean "PODIUM injected nothing" if the
  // ambient environment is clean. Pin all three inputs that would otherwise make this
  // test read the developer's machine instead of the code:
  //   HOME   -> an empty dir, so an interactive bash sources no ~/.bashrc that might
  //             export ANTHROPIC_API_KEY itself (that would be the SHELL's doing, not
  //             Podium's, and would fail the negative case for the wrong reason).
  //   SHELL  -> bash, so `env` behaves identically on a fish/zsh developer's box.
  //   ANTHROPIC_API_KEY -> unset, for the same reason as HOME.
  vi.stubEnv('HOME', home)
  vi.stubEnv('SHELL', '/bin/bash')
  vi.stubEnv('ANTHROPIC_API_KEY', undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(settingsDir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

/**
 * Spawn a real shell through the daemon's real spawn handler, make it print its
 * environment, and return what it printed. `env` (not `echo $VAR`) on purpose: the
 * child enumerates its own environ, so we observe the process's actual environment
 * rather than a shell expansion we could have fooled ourselves with.
 */
async function spawnAndDumpEnv(
  h: Harness,
  sessionId: SessionId,
  access: AccessField | undefined,
  /** Typed after the env dump; its output follows the dump's. */
  then?: { command: string; until: string },
): Promise<string> {
  // The real wire frame, through the real schema — an env the protocol would have
  // rejected can never reach the daemon in production, so it must not here either.
  const msg = SpawnMessage.parse(
    JSON.parse(
      JSON.stringify({
        type: 'spawn',
        sessionId,
        agentKind: 'claude-code',
        cwd: process.cwd(),
        geometry: { cols: 120, rows: 30 },
        binding: {
          transitionId: `managed-account:${sessionId}`,
          machineAccess: 'allowed',
          principal: { kind: 'user', userId: 'managed-account-test-user' },
        },
        ...(access ? { access } : {}),
      }),
    ),
  )
  // The credential crosses only in `access`: the plain env carries none.
  expect(msg.env).toBeUndefined()

  await sessionHandlers.spawn(h.ctx, msg)

  await waitFor(() => h.sent.some((m) => m.type === 'bind' || m.type === 'spawnError'))
  const bind = h.sent.find((m) => m.type === 'bind')
  const spawnError = h.sent.find((m) => m.type === 'spawnError')
  expect(spawnError, `daemon refused to spawn: ${JSON.stringify(spawnError)}`).toBeUndefined()
  expect(bind, 'daemon never bound the session').toBeDefined()

  const terminal = h.ctx.sessions.get(sessionId)?.terminal
  if (!terminal) throw new Error('no terminal for the spawned session')
  const session = terminal.attachment
  const pid = terminal.pid

  try {
    // The shell is up and talking.
    await waitFor(() => h.output().length > 0).catch((error) => {
      const sent = JSON.stringify(
        h.sent.filter((m) => m.type !== 'sessionAuth' || true).map((m) => m),
      ).slice(0, 1500)
      let state = 'gone'
      try {
        const { readFileSync, readlinkSync } = require('node:fs') as typeof import('node:fs')
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
        const exe = readlinkSync(`/proc/${pid}/exe`)
        const wchan = readFileSync(`/proc/${pid}/wchan`, 'utf8')
        state = `${exe} ${stat.split(' ')[2]} wchan=${wchan}`
      } catch {}
      throw new Error(`${error}: no output from pid ${pid} (${state}); the daemon sent ${sent}`)
    })
    // By absolute path: the launch seam's harness context carries no command
    // environment, so the stand-in shell may have no PATH of its own.
    terminal.writeBase64(Buffer.from('/usr/bin/env\n', 'utf8').toString('base64'))
    // PODIUM_SESSION_ID is bound by the daemon on EVERY spawn, so seeing it in the
    // dump is proof the env actually printed and that this process really came out of
    // Podium's spawn path — which is what makes the absence of ANTHROPIC_API_KEY in
    // the negative case meaningful rather than merely a dump we failed to wait for.
    await waitFor(() => h.output().includes(`PODIUM_SESSION_ID=${sessionId}`)).catch((error) => {
      throw new Error(`${error}: the child printed ${JSON.stringify(h.output().slice(-2000))}`)
    })
    await h.settled()
    if (then) {
      terminal.writeBase64(Buffer.from(`${then.command}\n`, 'utf8').toString('base64'))
      await waitFor(() => h.output().includes(then.until)).catch((error) => {
        throw new Error(`${error}: the child printed ${JSON.stringify(h.output().slice(-2000))}`)
      })
      await h.settled()
    }
    expect(h.ctx.sessions.get(sessionId)?.label).toBe(`podium-blue-${sessionId}`)
    return h.output()
  } finally {
    // Reap by explicit pid. Never pattern-kill: a `pkill -f bash` here would take the
    // developer's live agent sessions with it. A host-held child is ended by its label.
    terminal.park()
    if (h.hostKill) {
      // The host owns and reaps its child: the session is gone when its label is.
      const label = `podium-blue-${sessionId}`
      await h.hostKill(label)
      const until = Date.now() + 5_000
      while ((await h.ctx.durable.has(label)) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(await h.ctx.durable.has(label), `leaked podium-host session ${label}`).toBe(false)
    } else {
      await waitFor(() => !alive(pid), 5_000)
      expect(alive(pid), `leaked PTY child pid ${pid}`).toBe(false)
    }
  }
}

describe('a session credential -> real spawned process env (#216, epic Task 5)', () => {
  it.skipIf(process.platform === 'linux')(
    'POSITIVE: an anthropic api-key in access lands in the terminal process ENVIRONMENT (acceptance 5, 8)',
    async () => {
      const access = await resolvedAccess('anthropic.api-key', CREDENTIAL)
      // The server resolved the stored credential into exactly the documented variable.
      expect(access.delivery).toEqual({
        kind: 'env',
        variable: 'ANTHROPIC_API_KEY',
        secret: CREDENTIAL,
      })

      const h = makeHarness(settingsDir)
      const dump = await spawnAndDumpEnv(h, asSessionId('sess-managed'), access)

      // The child's own `env` listed it — a real process, a real environment.
      expect(dump).toContain(`ANTHROPIC_API_KEY=${CREDENTIAL}`)
      // Claude Code's switch that keeps it out of the commands the agent runs.
      expect(dump).toContain('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1')
      // ...and the credential did not displace Podium's own per-session wiring.
      expect(dump).toContain('PODIUM_SESSION_ID=sess-managed')
      expect(dump).toContain('PODIUM_INSTANCE=blue')
      expect(dump).toContain('PODIUM_SESSION_INSTANCE=blue')
    },
  )

  describe.runIf(process.platform === 'linux' && isHostAvailable())(
    'on Linux, through the real podium-host (POD-7378)',
    () => {
      let hostRoot = ''
      beforeEach(() => {
        // Short: the session socket path must fit Linux's 108-byte sun_path.
        hostRoot = mkdtempSync(join(tmpdir(), 'psh-'))
        vi.stubEnv('PODIUM_STATE_DIR', join(hostRoot, 'state'))
        vi.stubEnv('PODIUM_HOST_SOCKET_DIR', join(hostRoot, 'sock'))
        // The scope has its own tests; this one reads the child's environment.
        vi.stubEnv('PODIUM_NO_SCOPE', '1')
      })
      afterEach(() => {
        if (hostRoot) rmSync(hostRoot, { recursive: true, force: true })
      })

      const cases = [
        [
          'anthropic.api-key',
          CREDENTIAL,
          'ANTHROPIC_API_KEY',
          'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
          'key',
        ],
        [
          'anthropic.claude-token',
          'oat-test-1',
          'CLAUDE_CODE_OAUTH_TOKEN',
          'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
          'tok',
        ],
      ] as const
      for (const [type, secret, variable, descriptor, tag] of cases) {
        it(`POSITIVE: ${type} reaches the process on a pipe, in no variable`, async () => {
          const access = await resolvedAccess(type, secret)
          expect(access.delivery).toMatchObject({ variable })
          const h = makeHarness(settingsDir, createDurableProcess())
          const dump = await spawnAndDumpEnv(h, asSessionId(`sp-${tag}`), access, {
            // Read through the shell's own descriptor: the pipe it inherited.
            command: `echo "PIPE=$(/bin/cat /proc/$$/fd/$${descriptor})END"`,
            until: 'END\r\n',
          })
          // Canary first: the secret did reach the process, on the pipe.
          expect(dump).toContain(`PIPE=${secret}END`)
          // The env dump, before the read: the descriptor is named, the secret
          // is in no variable, and no scrub switch is set.
          const env = dump.slice(0, dump.indexOf('echo "PIPE='))
          expect(env).toContain(`PODIUM_SESSION_ID=sp-${tag}`)
          expect(env).toMatch(new RegExp(`${descriptor}=\\d+`))
          expect(env).not.toContain(`${variable}=`)
          expect(env).not.toContain(secret)
          expect(env).not.toContain('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=')
        })
      }
    },
  )

  it('NEGATIVE: no credential (no access on the frame) injects NO ANTHROPIC_API_KEY', async () => {
    // This is the regression that would silently re-auth every existing user: a spawn
    // carrying no credential must leave the agent's credentials exactly as the CLI's
    // own on-disk login left them. Podium must add nothing.
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-inherited-from-the-daemon')
    const h = makeHarness(settingsDir)
    const dump = await spawnAndDumpEnv(h, asSessionId('sess-native'), undefined)

    expect(dump).toContain('PODIUM_SESSION_ID=sess-native') // the dump really happened
    // Neither a delivered key nor one inherited from the daemon's own environment.
    expect(dump).not.toContain('ANTHROPIC_API_KEY=')
    expect(dump).not.toContain('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=')
  })

  it.skipIf(process.platform === 'linux')(
    'a Claude token rides the same path as CLAUDE_CODE_OAUTH_TOKEN',
    async () => {
      const access = await resolvedAccess('anthropic.claude-token', 'oat-test-1')
      expect(access.delivery).toMatchObject({ variable: 'CLAUDE_CODE_OAUTH_TOKEN' })

      const h = makeHarness(settingsDir)
      const dump = await spawnAndDumpEnv(h, asSessionId('sess-oauth'), access)

      expect(dump).toContain('CLAUDE_CODE_OAUTH_TOKEN=oat-test-1')
      expect(dump).not.toContain('ANTHROPIC_API_KEY=') // a token must not also set the api-key var
    },
  )
})
