import { addSink, type LogRecord } from '@podium/logger'
import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  admissionProbeDriver,
  launchServerDriverSession,
  reportDriverPreferenceDegrade,
  resolvedAdmissionExecutable,
} from '../control/session'
import {
  availableDriverIds,
  droppedDriverPreference,
  harnessOwningServerDriver,
  isServerDriver,
  isServerDriverId,
  resolveRuntimeDriver,
  runtimeDriverIntentForSpawn,
  selectionAuthForLogin,
  spawnNamedServerDriver,
  unhonouredSpawnDriver,
} from './registry'

const SESSION = asSessionId('11111111-1111-4111-8111-111111111111')


describe('availableDriverIds — grok-acp selection', () => {
  it('lists grok-acp only where the gate admitted the binary', () => {
    expect(availableDriverIds({ opencodeDrivable: false, grokDrivable: true })).toContain(
      'grok-acp',
    )
  })
})

describe('selection — server first, terminal fallback', () => {
  it('lists the driver only where the gate admitted the binary', () => {
    expect(availableDriverIds({ opencodeDrivable: false, codexDrivable: true })).toContain(
      'codex-app-server',
    )
    expect(availableDriverIds({ opencodeDrivable: false, codexDrivable: false })).not.toContain(
      'codex-app-server',
    )
  })

  it('treats an UNPROBED machine as unavailable rather than assuming yes', () => {
    // The failure mode on an unpinned binary is a session that hangs, so silence
    // must degrade to terminal rather than be read as a pass.
    expect(availableDriverIds({ opencodeDrivable: false })).not.toContain('codex-app-server')
  })

  it('recognizes it as codex own server driver', () => {
    expect(isServerDriver('codex', 'codex-app-server')).toBe(true)
    expect(isServerDriver('codex', 'generic-pty')).toBe(false)
    // …and not as anybody else's.
    expect(isServerDriver('opencode', 'codex-app-server')).toBe(false)
  })

  it('defaults to terminal when a spawn expresses no preference', () => {
    const resolved = resolveRuntimeDriver({
      agentKind: 'codex',
      requested: undefined,
      available: ['claude-pty', 'generic-pty', 'codex-app-server'],
      platform: 'linux',
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.driverId).toBe('generic-pty')
  })

  it('honours an explicit per-spawn preference', () => {
    const resolved = resolveRuntimeDriver({
      agentKind: 'codex',
      requested: 'codex-app-server',
      available: ['claude-pty', 'generic-pty', 'codex-app-server'],
      platform: 'linux',
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.driverId).toBe('codex-app-server')
  })

  it('DEGRADES to terminal when the machine cannot run it', () => {
    // An operator naming the driver on a box whose codex is out of the pinned
    // range gets a working terminal session rather than one that hangs on its
    // first tool call — the preference is routed THROUGH the policy, not around
    // it, so `available` still decides.
    const resolved = resolveRuntimeDriver({
      agentKind: 'codex',
      requested: 'codex-app-server',
      available: ['claude-pty', 'generic-pty'],
      platform: 'linux',
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(resolved.driverId).toBe('generic-pty')
  })

  it('REFUSES an id this build does not ship, rather than silently degrading', () => {
    // A typo that produced a working terminal session would read as "the
    // override did not work", which is the one failure an operator testing a
    // driver must not be handed.
    const resolved = resolveRuntimeDriver({
      agentKind: 'codex',
      requested: 'codex-app-sever' as never,
      available: ['generic-pty', 'codex-app-server'],
      platform: 'linux',
    })
    expect(resolved.ok).toBe(false)
  })
})

describe('which probe answers for which driver', () => {
  /**
   * THE RULE THAT WAS WRONG ONCE, so it is named and tested rather than
   * re-derived at each call site.
   *
   * W6 added a SECOND server driver with its own binary and its own version
   * probe. The spawn path refuses an explicit server-driver request when that
   * driver's probe came back `unprobeable` — and if it consults the WRONG
   * probe, one harness's healthy binary vouches for another harness's missing
   * one. The request then sails past the refusal, vanishes from `available`,
   * and comes back as a terminal session: exactly the silent downgrade the
   * unprobeable/unsupported split exists to prevent (POD-2056's measurement).
   */
  it('attributes each server driver to the harness that DECLARES it', () => {
    expect(harnessOwningServerDriver('codex-app-server')).toBe('codex')
    expect(harnessOwningServerDriver('opencode-server')).toBe('opencode')
  })

  it('attributes terminal and unknown ids to nobody', () => {
    // A terminal driver has no version-gated binary of its own to probe, and an
    // id this build does not ship must not be attributed to whichever harness
    // happened to be first in the manifest map. `headless` is harness-agnostic
    // — one driver serves every harness with a headless axis — so it has no
    // owning harness either, even though it is server-family.
    expect(harnessOwningServerDriver('generic-pty')).toBeUndefined()
    expect(harnessOwningServerDriver('claude-pty')).toBeUndefined()
    expect(harnessOwningServerDriver('headless')).toBeUndefined()
    expect(harnessOwningServerDriver('codex-app-sever')).toBeUndefined()
  })

  it('agrees with the server-driver predicate built on it', () => {
    expect(isServerDriverId('codex-app-server')).toBe(true)
    expect(isServerDriverId('headless')).toBe(true)
    expect(isServerDriverId('generic-pty')).toBe(false)
  })
})

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

describe('generation-resolved executables for admission', () => {
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
})
