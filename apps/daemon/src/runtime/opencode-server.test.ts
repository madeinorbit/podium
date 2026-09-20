/**
 * THE DAEMON HALF OF THE opencode SERVER DRIVER (POD-1761 W5).
 *
 * What is tested here is exactly what could NOT live in the package: the
 * secret's placement, the driver resolution that decides whether a spawn even
 * reaches this family, and the journal that makes `adopt()` possible after the
 * daemon dies. The driver's own behaviour — receipts, events, interactions — is
 * proved by the conformance corpus against a real listener in
 * `packages/agent-runtime`.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSink, type LogRecord } from '@podium/logger'
import type { SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import type {
  DurableAdapter,
  DurableProcess,
  HeadlessAttachOptions,
  HeadlessSpawnOptions,
  HostAgentSession,
} from '@podium/process/durable'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  admissionProbeDriver,
  launchServerDriverSession,
  reportDriverPreferenceDegrade,
  resolvedAdmissionExecutable,
} from '../control/session'
import { runtimeDriverIdFor, sessionIsBehindContract } from './handlers'
import {
  createOpencodeHost,
  createOpencodeJournal,
  opencode2VersionProbe,
  OpencodeEngineLeaseRefused,
  opencodeScopeLabel,
  opencodeServeArgv,
  opencodeVersionDiagnostic,
  opencodeVersionProbe,
  opencodeVersionProbeForExecutable,
  probeHealth,
  resetOpencode2VersionProbe,
  resetOpencodeVersionProbe,
} from './opencode-server'
import {
  availableDriverIds,
  droppedDriverPreference,
  isServerDriver,
  isServerDriverId,
  resolveRuntimeDriver,
  runtimeDriverIntentForSpawn,
  selectionAuthForLogin,
  spawnNamedServerDriver,
  unhonouredSpawnDriver,
} from './registry'

const SESSION = asSessionId('11111111-1111-4111-8111-111111111111')

/**
 * A DurableProcess that captures headless spawns and answers attaches from a
 * script — the hermetic stand-in for podium-host in the engine-lifecycle tests.
 */
function fakeEngineDurable(hooks: {
  spawnHeadless?: (opts: HeadlessSpawnOptions) => Promise<HostAgentSession>
  attachHeadless?: (opts: HeadlessAttachOptions) => Promise<HostAgentSession>
  killed?: (label: string) => void
}): DurableProcess {
  const adapter: DurableAdapter = {
    kind: 'host',
    spawn: () => Promise.reject(new Error('terminal spawn is not under test')),
    spawnHeadless:
      hooks.spawnHeadless ?? (() => Promise.reject(new Error('unexpected spawnHeadless'))),
    attachHeadless:
      hooks.attachHeadless ?? (() => Promise.reject(new Error('no engine host answers'))),
    attach: () => Promise.reject(new Error('terminal attach is not under test')),
    has: async () => false,
    kill: async (label: string) => {
      hooks.killed?.(label)
    },
    list: async () => [],
    socketPath: async () => undefined,
    waitForSocket: () => Promise.reject(new Error('unused')),
    hasMasterSync: () => false,
    attachCommand: (target: string) => target,
  }
  return {
    backend: 'host',
    primary: adapter,
    all: [adapter],
    spawn: (opts) => adapter.spawn(opts),
    spawnHeadless: (opts) => adapter.spawnHeadless(opts),
    attachHeadless: (opts) => adapter.attachHeadless(opts),
    locate: async () => undefined,
    has: (label) => adapter.has(label),
    kill: (label) => adapter.kill(label),
    list: () => adapter.list(),
    hasMasterSync: (label, env) => adapter.hasMasterSync(label, env),
  }
}

/** A held engine attachment the test drives by hand: welcome on demand, EXITED
 *  by invoking the captured callbacks. */
function fakeEngineSession(input: { childPid?: number; lease?: boolean } = {}): {
  session: HostAgentSession
  exits: Array<(code: number, signal: number) => void>
} {
  const exits: Array<(code: number, signal: number) => void> = []
  const session = {
    ready: Promise.resolve({
      version: 1,
      hostPid: 111,
      childPid: input.childPid ?? 4242,
      hasPty: false,
      cols: 0,
      rows: 0,
      seqLow: 0n,
      seqHigh: 0n,
      lease: input.lease ?? true,
    }),
    connection: {
      onData: () => () => {},
      onExit: (cb: (code: number, signal: number) => void) => {
        exits.push(cb)
        return () => {}
      },
      signal: () => {},
    },
    dispose: () => {},
  } as unknown as HostAgentSession
  return { session, exits }
}

describe('driver resolution', () => {
  const available = ['claude-pty', 'generic-pty', 'opencode-server'] as const
  it('applies interactive-login selection before probing a server binary', () => {
    expect(admissionProbeDriver('opencode-server', 'logged-out')).toBeUndefined()
    expect(admissionProbeDriver('codex-app-server', 'logged-out')).toBeUndefined()
    expect(admissionProbeDriver('grok-acp', 'logged-out')).toBeUndefined()
    expect(admissionProbeDriver('opencode-server', 'unknown')).toBe('opencode-server')
  })

  it('keeps an unsettled Codex login off app-server without widening other harnesses', () => {
    expect(selectionAuthForLogin('codex', 'out')).toBe('logged-out')
    expect(selectionAuthForLogin('codex', 'unknown')).toBe('logged-out')
    expect(selectionAuthForLogin('codex', 'in')).toBe('unknown')
    expect(selectionAuthForLogin('codex', undefined)).toBe('unknown')
    expect(selectionAuthForLogin('opencode', 'unknown')).toBe('unknown')
    expect(selectionAuthForLogin('grok', 'unknown')).toBe('unknown')
  })

  it('degrades a default Codex grace-window spawn but preserves explicit refusal', () => {
    const auth = selectionAuthForLogin('codex', 'unknown')
    const defaultResolution = resolveRuntimeDriver({
      agentKind: 'codex',
      requested: undefined,
      available: ['codex-app-server', 'generic-pty'],
      platform: 'linux',
      auth,
    })
    expect(defaultResolution).toEqual({ ok: true, driverId: 'generic-pty' })
    expect(unhonouredSpawnDriver({ perSpawn: undefined, resolved: 'generic-pty' })).toBeUndefined()

    const explicitResolution = resolveRuntimeDriver({
      agentKind: 'codex',
      requested: 'codex-app-server',
      available: ['codex-app-server', 'generic-pty'],
      platform: 'linux',
      auth,
    })
    expect(explicitResolution).toEqual({ ok: true, driverId: 'generic-pty' })
    expect(
      unhonouredSpawnDriver({
        perSpawn: 'codex-app-server',
        resolved: 'generic-pty',
      }),
    ).toBe('codex-app-server')
  })

  it.each([
    ['opencode', 'opencode-server'],
    ['codex', 'codex-app-server'],
    ['grok', 'grok-acp'],
  ] as const)('%s defaults to its terminal, degrades visibly, and preserves explicit overrides', (agentKind, serverDriver) => {
    expect(
      runtimeDriverIntentForSpawn({
        agentKind,
        perSpawn: undefined,
      }),
    ).toEqual({ requested: undefined, preferred: undefined })

    const supported = resolveRuntimeDriver({
      agentKind,
      requested: undefined,
      available: [serverDriver, 'generic-pty'],
      platform: 'linux',
    })
    expect(supported).toEqual({ ok: true, driverId: 'generic-pty' })

    const loggedOut = resolveRuntimeDriver({
      agentKind,
      requested: undefined,
      available: [serverDriver, 'generic-pty'],
      platform: 'linux',
      auth: 'logged-out',
    })
    expect(loggedOut).toEqual({ ok: true, driverId: 'generic-pty' })
    const explicitLoggedOut = resolveRuntimeDriver({
      agentKind,
      requested: serverDriver,
      available: [serverDriver, 'generic-pty'],
      platform: 'linux',
      auth: 'logged-out',
    })
    expect(explicitLoggedOut).toEqual({ ok: true, driverId: 'generic-pty' })
    expect(
      unhonouredSpawnDriver({
        perSpawn: serverDriver,
        resolved: 'generic-pty',
      }),
    ).toBe(serverDriver)

    const fallback = resolveRuntimeDriver({
      agentKind,
      requested: undefined,
      available: ['generic-pty'],
      platform: 'linux',
    })
    expect(fallback).toEqual({ ok: true, driverId: 'generic-pty' })
    const records: LogRecord[] = []
    const dispose = addSink({
      name: 'default-driver-degrade-test',
      write: (record) => records.push(record),
    })
    const requestedDriverId = reportDriverPreferenceDegrade({
      sessionId: SESSION,
      agentKind,
      preference: serverDriver,
      resolved: 'generic-pty',
      reason: 'driver probe did not admit this machine',
    })
    dispose()
    expect(requestedDriverId).toBe(serverDriver)
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: 'the preferred runtime driver was not available; using fallback',
        preferred: serverDriver,
        resolved: 'generic-pty',
      }),
    )

    expect(
      resolveRuntimeDriver({
        agentKind,
        requested: 'generic-pty',
        available: [serverDriver, 'generic-pty'],
        platform: 'linux',
      }),
    ).toEqual({ ok: true, driverId: 'generic-pty' })

    expect(
      resolveRuntimeDriver({
        agentKind,
        requested: `${serverDriver}-bogus`,
        available: [serverDriver, 'generic-pty'],
        platform: 'linux',
      }).ok,
    ).toBe(false)
  })

  it('defaults to the terminal when no per-spawn choice exists', () => {
    const resolved = resolveRuntimeDriver({
      agentKind: 'opencode',
      requested: undefined,
      available: [...available],
      platform: 'linux',
    })
    expect(resolved).toEqual({ ok: true, driverId: 'generic-pty' })
    expect(isServerDriver('opencode', 'opencode-server')).toBe(true)
  })

  it('omitted requests stay headed: no policy probe, terminal driver', () => {
    // POD-4426: the `true` spelling ("consult the manifest policy") is gone.
    // Absent means the manifest's headed terminal default, unconditionally.
    const resolved = resolveRuntimeDriver({
      agentKind: 'opencode',
      requested: undefined,
      available: [...available],
      platform: 'linux',
    })
    expect(resolved).toEqual({ ok: true, driverId: 'generic-pty' })
  })

  it('honours an explicit opt-in', () => {
    const resolved = resolveRuntimeDriver({
      agentKind: 'opencode',
      requested: 'opencode-server',
      available: [...available],
      platform: 'linux',
    })
    expect(resolved).toEqual({ ok: true, driverId: 'opencode-server' })
    expect(isServerDriver('opencode', 'opencode-server')).toBe(true)
  })

  it("resolves an explicit headless preference without a manifest select() or a version probe", () => {
    const resolved = resolveRuntimeDriver({
      agentKind: 'codex',
      requested: 'headless',
      available: ['generic-pty'],
      platform: 'linux',
    })
    expect(resolved).toEqual({ ok: true, driverId: 'headless' })
    expect(isServerDriver('codex', 'headless')).toBe(true)
    expect(isServerDriverId('headless')).toBe(true)
  })

  it('DEGRADES an opt-in the machine cannot run, rather than failing the spawn', () => {
    // A machine whose opencode is missing or out of the pinned range does not
    // list the driver. Honouring the preference anyway would turn a stale
    // settings value into a session that cannot start.
    const resolved = resolveRuntimeDriver({
      agentKind: 'opencode',
      requested: 'opencode-server',
      available: ['generic-pty'],
      platform: 'linux',
    })
    expect(resolved).toEqual({ ok: true, driverId: 'generic-pty' })
  })

  it('…but the SPAWN that named it is told, rather than handed a terminal session', () => {
    /**
     * THE OTHER HALF OF THE DEGRADE ABOVE (POD-2113). `resolveRuntimeDriver`
     * still answers `generic-pty` — the resolution is unchanged and stays a
     * degrade — and the spawn path then asks whether the ID CAME FROM THIS
     * SPAWN. It did, so the session is refused instead of quietly started.
     *
     * The two are not in tension. Resolution answers "what can run here", which
     * is a fact about the machine; this answers "may I quietly substitute it",
     * which is a fact about who asked and how recently.
     */
    expect(unhonouredSpawnDriver({ perSpawn: 'opencode-server', resolved: 'generic-pty' })).toBe(
      'opencode-server',
    )
    // AN OMITTED REQUEST IS NOT A PER-SPAWN REQUEST, and this is the line that
    // keeps the degrade alive. With the machine-wide default gone (POD-4426),
    // the only preference left is the per-spawn field — so an omitted spawn
    // degrades a manifest-default preference instead of failing it.
    expect(unhonouredSpawnDriver({ perSpawn: undefined, resolved: 'generic-pty' })).toBeUndefined()
    // Honoured is honoured.
    expect(
      unhonouredSpawnDriver({ perSpawn: 'opencode-server', resolved: 'opencode-server' }),
    ).toBeUndefined()
    // A SERVER DRIVER ASKED OF A HARNESS THAT DECLARES NONE is refused for the
    // same reason, and it is the case a typo in `agentKind` produces: claude
    // resolves to `claude-pty` and the opencode request evaporates.
    expect(unhonouredSpawnDriver({ perSpawn: 'opencode-server', resolved: 'claude-pty' })).toBe(
      'opencode-server',
    )
    // TERMINAL IDS DO NOT REFUSE. Both reach the same PTY launch, so a spawn
    // that named one and resolved to the other got what it asked for in every
    // way it can observe — refusing would be pedantry about a label.
    expect(
      unhonouredSpawnDriver({ perSpawn: 'claude-pty', resolved: 'generic-pty' }),
    ).toBeUndefined()
  })

  it('asks ONE question for both refusals: only this spawn can refuse it', () => {
    /**
     * THE DEFECT THIS PINS (POD-2113, found by review). The spawn path refuses in
     * two places — before resolution when a probe could not answer, and after it
     * when the driver was not the one picked — and only the second asked whether
     * THIS SPAWN named the driver. The first asked the env-folded value.
     *
     * That is not a cosmetic asymmetry. A probe reports `unprobeable` on ENOENT,
     * not just on a timeout, and that verdict is deliberately not permanent —
     * so on a daemon whose PATH lacks the binary (installed under
     * `~/.opencode/bin`, daemon started from a systemd unit) a stale default
     * refused EVERY spawn of EVERY harness. POD-4426 deleted the env source, so
     * the per-spawn field is the only preference left and both refusals ask it.
     */
    expect(spawnNamedServerDriver('opencode-server')).toBe('opencode-server')
    // W6'S SECOND SERVER DRIVER, which doubled the ways into the defect without
    // changing its shape. Read off the manifests rather than matched by name, so
    // a third family is covered when it is declared, not when someone remembers
    // this test.
    expect(spawnNamedServerDriver('codex-app-server')).toBe('codex-app-server')
    // AN OMITTED REQUEST NEVER REACHES THIS FUNCTION as a refusal — it arrives
    // as `undefined` here, and the manifest default it degrades to is handled
    // by the degrade path, never refused.
    expect(spawnNamedServerDriver(undefined)).toBeUndefined()
    // Terminal ids are not the server family and all reach the same PTY launch.
    expect(spawnNamedServerDriver('generic-pty')).toBeUndefined()
    expect(spawnNamedServerDriver('claude-pty')).toBeUndefined()
    // An unknown id is not refused HERE — `resolveRuntimeDriver` owns that
    // refusal and names the id. Answering for it too would be two places
    // deciding one thing, which is the class of bug this whole test is about.
    expect(spawnNamedServerDriver('not-a-real-driver')).toBeUndefined()
    // AND THE TWO REFUSALS AGREE BY CONSTRUCTION: the post-resolution one is
    // written in terms of this same predicate, so the rule cannot be
    // half-applied again the way it was.
    expect(unhonouredSpawnDriver({ perSpawn: 'codex-app-server', resolved: 'generic-pty' })).toBe(
      'codex-app-server',
    )
  })

  it('pins the degrade warning and the requested-driver projection together', () => {
    const records: LogRecord[] = []
    const dispose = addSink({
      name: 'driver-degrade-test',
      write: (record) => records.push(record),
    })
    const requestedDriverId = reportDriverPreferenceDegrade({
      sessionId: SESSION,
      agentKind: 'opencode',
      preference: 'opencode-server',
      resolved: 'generic-pty',
      reason: 'opencode version unsupported',
    })
    dispose()
    expect(requestedDriverId).toBe('opencode-server')
    expect(records).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: 'the preferred runtime driver was not available; using fallback',
        sessionId: SESSION,
        preferred: 'opencode-server',
        resolved: 'generic-pty',
        reason: 'opencode version unsupported',
      }),
    )
    /**
     * A preferred server driver that becomes a terminal session must emit the
     * warning above and return the preferred id for the bind read surface. The
     * shared guard prevents those two facts from drifting.
     *
     * The emission is asserted above; the remaining cases pin the guard negatives.
     */
    expect(
      droppedDriverPreference({ preference: 'opencode-server', resolved: 'generic-pty' }),
    ).toBe('opencode-server')
    expect(
      droppedDriverPreference({ preference: 'codex-app-server', resolved: 'claude-pty' }),
    ).toBe('codex-app-server')
    // Honoured: nothing was dropped, so warning would be noise — and noise here
    // is what teaches an operator to skip the one line that matters.
    expect(
      droppedDriverPreference({ preference: 'opencode-server', resolved: 'opencode-server' }),
    ).toBeUndefined()
    // No preference at all is the overwhelmingly common spawn.
    expect(
      droppedDriverPreference({ preference: undefined, resolved: 'generic-pty' }),
    ).toBeUndefined()
    // A terminal id resolving to its sibling is not a degrade: both reach the
    // same PTY launch, so nothing was lost to report.
    expect(
      droppedDriverPreference({ preference: 'claude-pty', resolved: 'generic-pty' }),
    ).toBeUndefined()
  })

  it('REFUSES an unknown id rather than quietly giving it a terminal session', () => {
    // The distinction `select()` cannot draw: "this build ships no such driver"
    // wants an error, "this machine cannot run it" wants a degrade. A spawn that
    // asked for `opencode-sever` and got a working terminal session would read
    // as proof the override works.
    const resolved = resolveRuntimeDriver({
      agentKind: 'opencode',
      requested: 'opencode-sever',
      available: [...available],
      platform: 'linux',
    })
    expect(resolved.ok).toBe(false)
    if (!resolved.ok) expect(resolved.reason).toContain('opencode-sever')
  })

  it('never puts a NON-opencode harness on the opencode driver', () => {
    // `select()` reads the harness's own manifest, so a preference for a driver
    // that harness does not declare is simply not in its ranking.
    const resolved = resolveRuntimeDriver({
      agentKind: 'claude-code',
      requested: 'opencode-server',
      available: [...available],
      platform: 'linux',
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(isServerDriver('claude-code', resolved.driverId)).toBe(false)
  })

  it('lists the server driver only when the version gate admits the binary', () => {
    expect(availableDriverIds({ opencodeDrivable: true })).toContain('opencode-server')
    expect(availableDriverIds({ opencodeDrivable: false, opencode2Drivable: true })).toContain(
      'opencode2-server',
    )
    expect(availableDriverIds({ opencodeDrivable: true, opencode2Drivable: false })).not.toContain(
      'opencode2-server',
    )
    expect(availableDriverIds({ opencodeDrivable: false })).not.toContain('opencode-server')
    // The terminal ids are unconditional either way — their mechanism is
    // Podium's own.
    expect(availableDriverIds({ opencodeDrivable: false })).toContain('generic-pty')
  })
})

describe('the version gate, as the daemon reads it', () => {
  beforeEach(() => {
    resetOpencodeVersionProbe()
    resetOpencode2VersionProbe()
  })
  afterEach(() => {
    resetOpencodeVersionProbe()
    resetOpencode2VersionProbe()
  })

  const answered = (output: string) => () => ({ output, ok: true })
  const silent =
    (output = '') =>
    () => ({ output, ok: false })

  it('uses a resolved absolute executable when no bare OpenCode command exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolved-opencode-'))
    const executable = join(dir, 'resolved-opencode')
    const previousPath = process.env.PATH
    try {
      writeFileSync(executable, '#!/bin/sh\nprintf "1.18.16\n"\n')
      chmodSync(executable, 0o755)
      process.env.PATH = '/usr/bin:/bin'
      await expect(opencodeVersionProbeForExecutable(executable)).resolves.toEqual({
        drivable: true,
      })
    } finally {
      process.env.PATH = previousPath
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('selects only the generation-resolved OpenCode executable for admission', () => {
    const executables = new Map([
      ['opencode', { path: '/home/rig/.opencode/bin/opencode' }],
      ['opencode2', { path: '/home/rig/.opencode/bin/opencode2' }],
      ['codex', { path: '/usr/bin/codex' }],
    ])
    expect(resolvedAdmissionExecutable('opencode-server', executables)).toBe(
      '/home/rig/.opencode/bin/opencode',
    )
    expect(resolvedAdmissionExecutable('opencode2-server', executables)).toBe(
      '/home/rig/.opencode/bin/opencode2',
    )
    expect(resolvedAdmissionExecutable('codex-app-server', executables)).toBeUndefined()
    expect(resolvedAdmissionExecutable('opencode-server', undefined)).toBeUndefined()
  })

  it('passes the generation-resolved executable through the real session admission boundary', async () => {
    const executable = '/home/rig/.opencode/bin/opencode'
    let probedExecutable: string | undefined
    const sent: unknown[] = []
    const ctx = {
      send: (message: unknown) => sent.push(message),
      harnessLoginState: () => 'in',
      harnessRuntime: {
        current: async () => ({
          executables: new Map([['opencode', { path: executable }]]),
        }),
      },
    } as never

    await expect(
      launchServerDriverSession(
        ctx,
        {
          type: 'spawn',
          sessionId: SESSION,
          agentKind: 'opencode',
          cwd: '/tmp',
          geometry: { cols: 80, rows: 24 },
          requestedDriverId: 'opencode-server',
        } as never,
        async (_driverId, _policy, executablePath) => {
          probedExecutable = executablePath
          return {
            drivable: false,
            reason: 'unprobeable',
            diagnostic: { title: 'probe refused', body: 'no answer' },
          }
        },
      ),
    ).resolves.toEqual({ handled: true })

    expect(probedExecutable).toBe(executable)
    expect(sent.at(-1)).toMatchObject({ type: 'spawnError', sessionId: SESSION })
  })

  it('admits only the OpenCode 2 betas whose API boundary is exercised', async () => {
    await expect(opencode2VersionProbe(answered('0.0.0-beta-18743'))).resolves.toEqual({
      drivable: true,
    })
    resetOpencode2VersionProbe()
    await expect(opencode2VersionProbe(answered('0.0.0-beta-18866'))).resolves.toEqual({
      drivable: true,
    })
    resetOpencode2VersionProbe()
    const future = await opencode2VersionProbe(answered('0.0.0-beta-18867'))
    expect(future.drivable).toBe(false)
    if (!future.drivable) expect(future.reason).toBe('unsupported')
  })
  it('probes the OpenCode 2 health route with its configured username', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    try {
      await expect(
        probeHealth('http://127.0.0.1:41427', 'secret', 'opencode', '/api/health'),
      ).resolves.toBe(true)
      expect(fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:41427/api/health',
        expect.objectContaining({
          headers: { authorization: 'Basic b3BlbmNvZGU6c2VjcmV0' },
        }),
      )
    } finally {
      fetch.mockRestore()
    }
  })

  it('spawns the resolved executable headless under the session label', async () => {
    const executable = '/home/rig/.opencode/bin/opencode'
    const launched: HeadlessSpawnOptions[] = []
    const stopped = new Error('stop after argv capture')
    const host = createOpencodeHost({
      resources: () => undefined,
      executablePath: executable,
      versionProbe: async () => ({ output: '1.18.16', ok: true }),
      freePort: async () => 41234,
      journal: { read: () => undefined, write: () => {}, clear: () => {} },
      durable: fakeEngineDurable({
        spawnHeadless: async (opts) => {
          launched.push(opts)
          throw stopped
        },
      }),
    })

    await expect(
      host.launch({
        sessionId: SESSION,
        workdir: '/tmp',
        secret: 'secret',
        username: 'podium',
      }),
    ).rejects.toBe(stopped)

    // ONE engine per session, headless under podium-host: the label names the
    // session (so a restart re-adopts it), the argv is bare `serve`, and the
    // systemd scope the old spawn wrapped here is the host's own discipline now.
    expect(launched).toHaveLength(1)
    expect(launched[0]).toMatchObject({
      label: opencodeScopeLabel(SESSION),
      cmd: executable,
      args: ['serve', '--port', '41234', '--hostname', '127.0.0.1'],
      cwd: '/tmp',
    })
    // RULE 2, pinned: the secret rides the env, never argv — and provider keys
    // are stripped by the host after the merge, exactly as the old delete loop.
    expect(launched[0]?.env).toMatchObject({
      OPENCODE_SERVER_USERNAME: 'podium',
      OPENCODE_SERVER_PASSWORD: 'secret',
    })
    expect(JSON.stringify(launched[0]?.args)).not.toContain('secret')
    expect(launched[0]?.stripEnv).toContain('ANTHROPIC_API_KEY')
  })

  it('passes the isolated database path to the OpenCode 2 server process', async () => {
    const stopped = new Error('stop after env capture')
    const launched: HeadlessSpawnOptions[] = []
    const host = createOpencodeHost({
      resources: () => undefined,
      freePort: async () => 41234,
      journal: { read: () => undefined, write: () => {}, clear: () => {} },
      variant: {
        driverId: 'opencode2-server',
        executable: 'opencode2',
        username: 'opencode',
        healthPath: '/api/health',
        scopeToken: 'oc2',
        journalNamespace: 'opencode2-servers',
        env: {
          OPENCODE_DB: '/instance/state/opencode2.db',
          OPENCODE_DISABLE_AUTOUPDATE: '1',
        },
        versionDiagnostic: async () => null,
      },
      durable: fakeEngineDurable({
        spawnHeadless: async (opts) => {
          launched.push(opts)
          throw stopped
        },
      }),
    })

    await expect(
      host.launch({
        sessionId: SESSION,
        workdir: '/tmp',
        secret: 'secret',
        username: 'opencode',
      }),
    ).rejects.toBe(stopped)
    expect(host.driverId).toBe('opencode2-server')
    expect(launched).toHaveLength(1)
    expect(launched[0]).toMatchObject({
      label: 'podium-oc2-11111111-1111-4111-8111-111111111111',
      cmd: 'opencode2',
      args: ['serve', '--port', '41234', '--hostname', '127.0.0.1'],
    })
    expect(launched[0]?.env).toMatchObject({
      OPENCODE_DB: '/instance/state/opencode2.db',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    })
  })

  it('builds serve argv from the resolved executable without changing PATH installs', () => {
    expect(opencodeServeArgv('/opt/resolved/opencode', 41234)).toEqual([
      '/opt/resolved/opencode',
      'serve',
      '--port',
      '41234',
      '--hostname',
      '127.0.0.1',
    ])
    expect(opencodeServeArgv('/usr/bin/opencode', 41234)[0]).toBe('/usr/bin/opencode')
    expect(opencodeServeArgv('opencode', 41234)[0]).toBe('opencode')
  })

  describe('headless adopt (POD-4433)', () => {
    const journalled = {
      sessionId: SESSION,
      opencodeSessionId: 'ses_adoptme',
      baseUrl: 'http://127.0.0.1:41234',
      username: 'podium',
      secret: 'journalled-secret',
      workdir: '/tmp',
      process: { key: opencodeScopeLabel(SESSION), pid: 4242 },
      seq: 7,
      turnEpoch: 2,
      bindingVersion: 1,
    }
    const binding = {
      sessionId: SESSION,
      driver: 'opencode-server',
      family: 'server',
      harness: 'opencode',
      workdir: '/tmp',
      resume: null,
      process: { key: opencodeScopeLabel(SESSION) },
      bindingVersion: 1,
    } as never

    function adoptHost(hooks: {
      attachHeadless?: (opts: HeadlessAttachOptions) => Promise<HostAgentSession>
    }) {
      return createOpencodeHost({
        resources: () => undefined,
        journal: {
          read: () => journalled,
          write: () => {},
          clear: () => {},
        },
        durable: fakeEngineDurable(hooks),
      })
    }

    it('adopts a surviving server in place: same port and secret, no second spawn', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
      const spawned: HeadlessSpawnOptions[] = []
      const { session } = fakeEngineSession({ childPid: 4242 })
      const host = createOpencodeHost({
        resources: () => undefined,
        versionProbe: async () => ({ output: '1.18.16', ok: true }),
        freePort: async () => 49999,
        journal: {
          read: () => journalled,
          write: () => {},
          clear: () => {},
        },
        durable: fakeEngineDurable({
          spawnHeadless: async (opts) => {
            spawned.push(opts)
            throw new Error('a live server must be adopted, never re-spawned')
          },
          attachHeadless: async () => session,
        }),
      })
      try {
        const endpoint = await host.launch({
          sessionId: SESSION,
          workdir: '/tmp',
          secret: 'fresh-secret',
          username: 'podium',
        })
        expect(endpoint.baseUrl).toBe(journalled.baseUrl)
        expect(endpoint.password).toBe(journalled.secret)
        expect(spawned).toHaveLength(0)
      } finally {
        fetch.mockRestore()
      }
    })

    it('host.adopt rebinds the survivor for the driver', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
      const { session } = fakeEngineSession({ childPid: 4242 })
      const host = adoptHost({ attachHeadless: async () => session })
      try {
        const endpoint = await host.adopt(binding)
        expect(endpoint?.baseUrl).toBe(journalled.baseUrl)
        expect(endpoint?.password).toBe(journalled.secret)
        expect(endpoint?.process.key).toBe(opencodeScopeLabel(SESSION))
      } finally {
        fetch.mockRestore()
      }
    })

    it('a writer lease held elsewhere refuses loudly instead of spawning beside it', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
      const spawned: HeadlessSpawnOptions[] = []
      const { session } = fakeEngineSession({ childPid: 4242, lease: false })
      const host = createOpencodeHost({
        resources: () => undefined,
        versionProbe: async () => ({ output: '1.18.16', ok: true }),
        freePort: async () => 49999,
        journal: {
          read: () => journalled,
          write: () => {},
          clear: () => {},
        },
        durable: fakeEngineDurable({
          spawnHeadless: async (opts) => {
            spawned.push(opts)
            throw new Error('must not spawn beside a leased engine')
          },
          attachHeadless: async () => session,
        }),
      })
      try {
        await expect(
          host.launch({
            sessionId: SESSION,
            workdir: '/tmp',
            secret: 'fresh-secret',
            username: 'podium',
          }),
        ).rejects.toBeInstanceOf(OpencodeEngineLeaseRefused)
        expect(spawned).toHaveLength(0)
      } finally {
        fetch.mockRestore()
      }
    })

    it('the host EXITED frame records the real status for the daemon', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
      const { session, exits } = fakeEngineSession({ childPid: 4242 })
      const host = createOpencodeHost({
        resources: () => undefined,
        versionProbe: async () => ({ output: '1.18.16', ok: true }),
        freePort: async () => 41234,
        journal: { read: () => undefined, write: () => {}, clear: () => {} },
        durable: fakeEngineDurable({ spawnHeadless: async () => session }),
      })
      try {
        const endpoint = await host.launch({
          sessionId: SESSION,
          workdir: '/tmp',
          secret: 'secret',
          username: 'podium',
        })
        expect(endpoint.engineExit?.()).toBeUndefined()
        for (const fire of exits) fire(3, 0)
        expect(endpoint.engineExit?.()).toEqual({ code: 3, signal: 0 })
      } finally {
        fetch.mockRestore()
      }
    })
  })

  it('admits recorded and newer versions', async () => {
    await expect(opencodeVersionProbe(answered('1.18.16'))).resolves.toEqual({ drivable: true })
    resetOpencodeVersionProbe()
    const verdict = await opencodeVersionProbe(answered('2.0.0'))
    expect(verdict.drivable).toBe(true)
    expect(verdict.diagnostic?.body).toContain('session runs normally')
  })

  it('MEMOIZES a DEFINITIVE answer, because the binary does not change under a daemon', async () => {
    let calls = 0
    const probe = (): { output: string; ok: boolean } => {
      calls += 1
      return { output: '1.18.16', ok: true }
    }
    await opencodeVersionProbe(probe)
    await opencodeVersionProbe(probe)
    await opencodeVersionProbe(probe)
    // One fork of a 180MB binary per daemon, not one per session.
    expect(calls).toBe(1)
  })

  it('temporarily memoizes a probe that could not answer', async () => {
    /**
     * POD-2056 MEASURED `opencode --version` AT 11–15s on the build host, against
     * what was then a 15s budget. Caching that miss would disable the server
     * driver for the daemon's whole life because one spawn was unlucky, which is
     * a far worse outcome than paying for a second probe.
     */
    let calls = 0
    const probe = (): { output: string; ok: boolean } => {
      calls += 1
      return calls === 1 ? { output: 'ETIMEDOUT', ok: false } : { output: '1.18.16', ok: true }
    }
    expect((await opencodeVersionProbe(probe)).drivable).toBe(true)
    // A spawn burst reuses the inconclusive result instead of repeating the
    // expensive process. Expiry behavior is pinned by version-probe.test.ts.
    expect((await opencodeVersionProbe(probe)).drivable).toBe(true)
    expect(calls).toBe(1)
  })

  it('refuses too old but admits an unknown version', async () => {
    const unsupported = await opencodeVersionProbe(answered('1.17.99'))
    expect(unsupported.drivable).toBe(false)
    expect(unsupported.diagnostic?.body).toContain('Install opencode 1.18 or newer')
    resetOpencodeVersionProbe()
    const unprobeable = await opencodeVersionProbe(silent('opencode ETIMEDOUT'))
    expect(unprobeable).toMatchObject({ drivable: true, reason: 'unprobeable' })
    expect(unprobeable.diagnostic?.body).toContain('session runs normally')
  })

  it('exposes only refusals through the old diagnostic surface', async () => {
    await expect(opencodeVersionDiagnostic(answered('1.18.16'))).resolves.toBeNull()
    resetOpencodeVersionProbe()
    await expect(opencodeVersionDiagnostic(silent('ENOENT'))).resolves.toBeNull()
  })
})

describe('the binding journal', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-oc-journal-'))
    previous = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = previous
  })

  const entry = {
    sessionId: SESSION,
    opencodeSessionId: 'ses_abc',
    baseUrl: 'http://127.0.0.1:41234',
    username: 'podium',
    secret: 'the-per-session-secret',
    workdir: '/tmp/work',
    process: { key: opencodeScopeLabel(SESSION), pid: 4242, scopeUnit: 'x.scope' },
    seq: 7,
    turnEpoch: 3,
    bindingVersion: 1,
  }

  it('round-trips what `adopt()` needs after a daemon restart', () => {
    createOpencodeJournal().write(entry)
    // A FRESH journal — no cache — because that is the state a restarted daemon
    // is actually in. Reading through the write-through cache would test
    // nothing about survival.
    const read = createOpencodeJournal().read(SESSION)
    expect(read).toEqual(entry)
  })

  it('writes the file 0600, because it holds the secret', () => {
    createOpencodeJournal().write(entry)
    const path = join(dir, 'opencode-servers', `${encodeURIComponent(SESSION)}.json`)
    // The secret has to survive to make `adopt()` possible at all, so the file's
    // mode is part of the mechanism rather than hygiene.
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8')).secret).toBe('the-per-session-secret')
  })

  it('clears on kill, so a dead session leaves no adoptable entry', () => {
    const journal = createOpencodeJournal()
    journal.write(entry)
    journal.clear(SESSION)
    expect(journal.read(SESSION)).toBeUndefined()
    expect(createOpencodeJournal().read(SESSION)).toBeUndefined()
  })

  it('answers undefined for a session it never saw, rather than throwing', () => {
    expect(
      createOpencodeJournal().read(asSessionId('22222222-2222-4222-8222-222222222222')),
    ).toBeUndefined()
  })
})

describe('the scope label', () => {
  it('is per-session and stable, which is what `adopt()` matches on', () => {
    const label = opencodeScopeLabel(SESSION)
    expect(label).toContain(SESSION)
    // A PURE FUNCTION OF THE SESSION ID, and that is the property `adopt()`
    // depends on: the process identity must survive a restart that gives the
    // server a DIFFERENT port. A key derived from the port would let `adopt()`
    // bind to whatever process inherited it — the kernel recycles one within
    // seconds — which the contract calls worse than not adopting.
    expect(opencodeScopeLabel(SESSION)).toBe(label)
    const other = asSessionId('33333333-3333-4333-8333-333333333333')
    expect(opencodeScopeLabel(other)).not.toBe(label)
  })
})

/**
 * THE SECRET IS NEVER IN ARGV (spec §6).
 *
 * Asserted against the argv the launch path BUILDS, because that is the thing
 * `/proc/<pid>/cmdline` ends up holding. The live proof that opencode enforces
 * the credential is `packages/agent-runtime/src/drivers/opencode/live-secret.test.ts`;
 * this is the proof that we do not hand it to every local user on the way in.
 */
describe('spec §6 — the secret rides the env', () => {
  it('keeps a secret out of the serve argv this daemon constructs', () => {
    const secret = 'a-very-secret-value'
    // The argv shape the launch path builds, restated here as the assertion's
    // subject: port and hostname, and nothing else that could carry a
    // credential.
    const serveArgv = ['opencode', 'serve', '--port', '41234', '--hostname', '127.0.0.1']
    expect(serveArgv.join(' ')).not.toContain(secret)
    // …and loopback is not a setting. A `--hostname 0.0.0.0` here would put spec
    // §6's whole argument in a config file.
    expect(serveArgv).toContain('127.0.0.1')
    expect(serveArgv).not.toContain('0.0.0.0')
  })
})

/**
 * THE DRIVER FACT ON EVERY BIND (POD-2023; the flag removed by POD-4426).
 *
 * `driverId` presence is what the server records on the row and what its
 * senders key on to choose the contract path. W3 had one registry, so the
 * predicate behind the old boolean asked one. The moment a second family
 * exists, a predicate that still asks one reports `false` for a server-family
 * session — and senders then route down a path that types at a PTY the session
 * does not have, where the write goes nowhere and reports success.
 *
 * Caught by reading the epic's lessons register rather than by a failing test,
 * which is exactly why there is now a test.
 */
describe('the driver bind fact', () => {
  const ctxWith = (opts: {
    terminal?: SessionId[]
    opencode?: SessionId[]
  }): Parameters<typeof sessionIsBehindContract>[0] => {
    const sessions = [...(opts.terminal ?? []), ...(opts.opencode ?? [])]
    return {
      ...(opts.terminal || opts.opencode
        ? { agentRuntime: { has: (id: SessionId) => sessions.includes(id) } }
        : {}),
    } as unknown as Parameters<typeof sessionIsBehindContract>[0]
  }

  it('reports a TERMINAL session behind the contract', () => {
    expect(sessionIsBehindContract(ctxWith({ terminal: [SESSION] }), SESSION)).toBe(true)
  })

  it('reports a SERVER session behind the contract — the regression', () => {
    // The bug: a server-family session is registered in `opencodeRuntime`, never
    // in `runtime`, so a terminal-only predicate answered `false` for a session
    // that is fully behind the contract.
    expect(sessionIsBehindContract(ctxWith({ opencode: [SESSION] }), SESSION)).toBe(true)
  })

  it('reports FALSE for a session with no handle — a shell, or not yet bound', () => {
    expect(sessionIsBehindContract(ctxWith({ terminal: [], opencode: [] }), SESSION)).toBe(false)
    // …and for a daemon with no runtimes wired at all.
    expect(sessionIsBehindContract(ctxWith({}), SESSION)).toBe(false)
  })

  it('reports the driver from the registry handle that owns the session', () => {
    const ctx = {
      agentRuntime: {
        handleFor: () => ({ binding: { driver: 'opencode-server' } }),
      },
    } as unknown as Parameters<typeof runtimeDriverIdFor>[0]

    expect(runtimeDriverIdFor(ctx, SESSION)).toBe('opencode-server')
  })

  it('is what EVERY driven bind states — the adoption pin', () => {
    /**
     * THE TRIO ABOVE PINS THE PREDICATE; THIS PINS ITS ADOPTION (POD-2023 review
     * addendum, (b)).
     *
     * The bug that started this was a bind site asking ONE registry. Fixing the
     * predicate and testing the predicate leaves the regression fully available:
     * a site that reverts to `ctx.runtime?.has(...)` tomorrow passes all three
     * tests above and ships the same defect.
     *
     * So this reads the source and asserts the CALL SITES. Since POD-4426 every
     * bind for a driven session states `driverId` outright — the handle is
     * registered before that line runs, so a probe could only agree — and a
     * shell bind states none. A NEW bind site appearing without `driverId`
     * fails here.
     *
     * THE MARKER IS `bindFrame(` SINCE POD-3290, not `type: 'bind'`. That
     * literal now appears in exactly one file — the one builder — and
     * `control/applied-geometry.test.ts` is the gate that keeps it there. So the
     * two suites together still cover the whole surface: a hand-rolled bind
     * anywhere fails that gate, and a driven bind built here without its driver
     * fails this one.
     */
    const daemonSrc = join(import.meta.dirname, '..')
    const files = [
      join(daemonSrc, 'control', 'session.ts'),
      join(daemonSrc, 'runtime', 'opencode-driver.ts'),
      join(daemonSrc, 'runtime', 'codex-driver.ts'),
      join(daemonSrc, 'runtime', 'grok-driver.ts'),
      // ADDED WITH THE BUILDER (POD-3290). The embedded Claude bind states the
      // same fact and was simply never in this list; now that every bind
      // has one shape there is no reason to leave it out.
      join(daemonSrc, 'runtime', 'claude-sdk-driver.ts'),
    ]
    let bindSites = 0
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const [index, line] of source.split('\n').entries()) {
        if (!line.includes('bindFrame(')) continue
        bindSites += 1
        // The frame body, from the builder call to its closing `}),`. Taken by
        // brace rather than by a line count: the opencode driver's bind carries
        // a long comment explaining why it states the fact outright, and a fixed
        // window would have "found" no fact there.
        const lines = source.split('\n')
        let body = ''
        for (let i = index; i < lines.length; i++) {
          body += `${lines[i]}\n`
          if (/^\s{0,10}\}\),?$/.test(lines[i] ?? '')) break
        }
        // Shell binds carry no driver by structure; every other site states the
        // driver outright. A site that states neither is a session the server
        // cannot drive and cannot distinguish from a shell.
        const isShellBind = body.includes("agentKind: 'shell'") && !body.includes('driverId')
        expect(
          body.includes('driverId') || isShellBind,
          `bind site at ${file}:${index + 1} states no driver — a driven session there would be indistinguishable from a shell`,
        ).toBe(true)
        // The driven signal is `driverId` presence alone: no other field may
        // carry a parallel "is this session driven" fact for readers to
        // disagree on. (Spelled as a fragment so this guard itself stays out
        // of the deletion grep: it matches any reintroduction.)
        expect(
          body.includes('untimeContract'),
          `bind site at ${file}:${index + 1} carries a parallel driven fact beside driverId`,
        ).toBe(false)
        // …and NEVER by asking one registry directly, which is the regression.
        expect(
          body.includes('ctx.runtime?.has('),
          `bind site at ${file}:${index + 1} asks only the terminal registry`,
        ).toBe(false)
      }
    }
    /**
     * ELEVEN today: launchSpawn, two handleReattach arms, three server-driver
     * launches, the ADOPT path that rebinds a surviving server after restart,
     * `resumeJournalledServerSession` (added by `fix(runtime): let a parked
     * server session come back`), which rebuilds a PARKED server session from
     * its binding journal — and, counted here since POD-3290, the embedded
     * Claude driver's `emitClaudeBinding` — plus the two headless adopt arms
     * (`adoptHeadlessSession` adopt success and its resume fallback), which
     * rebind a process-per-turn session that holds no server journal and no
     * PTY.
     *
     * EVERY ONE STATES `driverId` OUTRIGHT, which is what the count is for:
     * the handle is registered before each of those lines runs, so stating the
     * driver is stating a fact rather than asking a question.
     *
     * The count is asserted so a new bind site cannot be added without coming
     * here and deciding what it reports.
     */
    expect(bindSites).toBe(11)
  })
})

/**
 * THE BOOT-TIME `adopt()` CALLER (POD-2056's finding, fixed on POD-2023).
 *
 * `adopt()` was implemented and covered by four conformance properties, and
 * NOTHING CALLED IT. On a daemon restart `handleReattach` went straight to the
 * durable-host lookup, asked abduco whether it still held the
 * session's label, got "no" from both — because a server-family session has no
 * PTY and never had a master — and answered `reattachFailed: session not found`
 * while a healthy `opencode serve` kept running orphaned on its port.
 *
 * These pin the DECISION the reattach path now makes, at the seam where it makes
 * it. The rebind itself is the contract's, and the corpus proves that.
 */
describe('reattach routes a server-family session to adopt, not to abduco', () => {
  let dir: string
  let previous: string | undefined
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'podium-oc-adopt-'))
    previous = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = dir
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = previous
  })

  const journalled = {
    sessionId: SESSION,
    opencodeSessionId: 'ses_survivor',
    baseUrl: 'http://127.0.0.1:41999',
    username: 'podium',
    secret: 'kept-so-adopt-can-authenticate',
    workdir: '/tmp/work',
    process: { key: opencodeScopeLabel(SESSION), pid: 5150, scopeUnit: 'x.scope' },
    seq: 12,
    turnEpoch: 4,
    bindingVersion: 2,
  }

  it('THE JOURNAL ENTRY IS THE ANSWER to "was this session server-driven?"', () => {
    // The discriminator the reattach branch reads. It exists only because the
    // server driver's own launch wrote it, so its presence is a fact rather than
    // an inference — which is why the branch can be taken before anything else
    // in `handleReattach` runs.
    const journal = createOpencodeJournal()
    expect(journal.read(SESSION)).toBeUndefined()
    journal.write(journalled)
    expect(createOpencodeJournal().read(SESSION)?.opencodeSessionId).toBe('ses_survivor')
  })

  it('carries everything adopt needs to be EXACT rather than hopeful', () => {
    createOpencodeJournal().write(journalled)
    const entry = createOpencodeJournal().read(SESSION)
    // The process key is what `adopt()` matches on — a prefix or a port would
    // rebind whatever inherited the socket.
    expect(entry?.process.key).toBe(opencodeScopeLabel(SESSION))
    // …and the secret, without which the health probe cannot tell a live server
    // from a recycled port answering someone else's traffic.
    expect(entry?.secret).toBe('kept-so-adopt-can-authenticate')
    expect(entry?.baseUrl).toBe('http://127.0.0.1:41999')
    // The epoch survives, so the rebound stream cannot rewind and look like new
    // work.
    expect(entry?.turnEpoch).toBe(4)
    expect(entry?.seq).toBe(12)
  })

  it('leaves a TERMINAL session alone — no entry, no branch', () => {
    // Every terminal session reaches the same code path. The branch must be
    // silent for them, or one journal read would divert the whole fleet.
    expect(createOpencodeJournal().read(SESSION)).toBeUndefined()
  })
})
