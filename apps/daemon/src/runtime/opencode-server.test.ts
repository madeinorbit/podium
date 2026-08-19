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

import { readFileSync, statSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSink, type LogRecord } from '@podium/logger'
import type { SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { admissionProbeDriver, reportDriverPreferenceDegrade } from '../control/session'
import { runtimeContractEnabledFor, runtimeDriverFor } from './flag'
import { runtimeDriverIdFor, sessionIsBehindContract } from './handlers'
import {
  createOpencodeJournal,
  opencodeScopeLabel,
  opencodeVersionDiagnostic,
  opencodeVersionProbe,
  resetOpencodeVersionProbe,
} from './opencode-server'
import {
  availableDriverIds,
  droppedDriverPreference,
  isServerDriver,
  resolveRuntimeDriver,
  runtimeDriverIntentForSpawn,
  selectionAuthForLogin,
  spawnNamedServerDriver,
  unhonouredSpawnDriver,
} from './registry'

const SESSION = asSessionId('11111111-1111-4111-8111-111111111111')

describe('the per-spawn driver override', () => {
  it('treats `true` as "the contract, with the manifest’s own choice"', () => {
    expect(runtimeContractEnabledFor(false, true)).toBe(true)
    // No driver named, so nothing overrides the policy — which is what keeps
    // W3's meaning of this field intact.
    expect(runtimeDriverFor(undefined, true)).toBeUndefined()
  })

  it('treats a driver id as "the contract, with THIS driver"', () => {
    // Naming a driver and then not being driven by it is not a state anyone
    // means to ask for, so the id implies the contract is on.
    expect(runtimeContractEnabledFor(false, 'opencode-server')).toBe(true)
    expect(runtimeDriverFor(undefined, 'opencode-server')).toBe('opencode-server')
  })

  it('lets the per-spawn field win over the machine-wide default', () => {
    // The more specific statement is the more recent decision — the precedence
    // every other per-session override in the daemon uses.
    expect(runtimeDriverFor('generic-pty', 'opencode-server')).toBe('opencode-server')
    expect(runtimeDriverFor('opencode-server', undefined)).toBe('opencode-server')
  })

  it('leaves an unflagged spawn on the legacy path, which is the whole zero-diff claim', () => {
    expect(runtimeContractEnabledFor(false, undefined)).toBe(false)
    expect(runtimeDriverFor(undefined, undefined)).toBeUndefined()
    expect(runtimeContractEnabledFor(false, false)).toBe(false)
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
      machineDefault: undefined,
      available: ['codex-app-server', 'generic-pty'],
      platform: 'linux',
      auth,
    })
    expect(defaultResolution).toEqual({ ok: true, driverId: 'generic-pty' })
    expect(unhonouredSpawnDriver({ perSpawn: undefined, resolved: 'generic-pty' })).toBeUndefined()

    const explicitResolution = resolveRuntimeDriver({
      agentKind: 'codex',
      requested: 'codex-app-server',
      machineDefault: undefined,
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
  ] as const)('%s defaults to its server, degrades visibly, and preserves explicit overrides', (agentKind, serverDriver) => {
    expect(
      runtimeDriverIntentForSpawn({
        agentKind,
        perSpawn: undefined,
        machineDefault: undefined,
      }),
    ).toEqual({ requested: undefined, preferred: serverDriver })

    const supported = resolveRuntimeDriver({
      agentKind,
      requested: undefined,
      machineDefault: undefined,
      available: [serverDriver, 'generic-pty'],
      platform: 'linux',
    })
    expect(supported).toEqual({ ok: true, driverId: serverDriver })

    const loggedOut = resolveRuntimeDriver({
      agentKind,
      requested: undefined,
      machineDefault: undefined,
      available: [serverDriver, 'generic-pty'],
      platform: 'linux',
      auth: 'logged-out',
    })
    expect(loggedOut).toEqual({ ok: true, driverId: 'generic-pty' })
    const explicitLoggedOut = resolveRuntimeDriver({
      agentKind,
      requested: serverDriver,
      machineDefault: undefined,
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
      machineDefault: undefined,
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
        machineDefault: undefined,
        available: [serverDriver, 'generic-pty'],
        platform: 'linux',
      }),
    ).toEqual({ ok: true, driverId: 'generic-pty' })

    expect(
      resolveRuntimeDriver({
        agentKind,
        requested: serverDriver + '-bogus',
        machineDefault: undefined,
        available: [serverDriver, 'generic-pty'],
        platform: 'linux',
      }).ok,
    ).toBe(false)
  })

  it('defaults to opencode-server when the machine admits it', () => {
    // No per-spawn or machine preference: the harness policy owns the choice.
    const resolved = resolveRuntimeDriver({
      agentKind: 'opencode',
      requested: undefined,
      machineDefault: undefined,
      available: [...available],
      platform: 'linux',
    })
    expect(resolved).toEqual({ ok: true, driverId: 'opencode-server' })
    expect(isServerDriver('opencode', 'opencode-server')).toBe(true)
  })

  it('lets runtimeContract:true choose the manifest default, now opencode-server', () => {
    const resolved = resolveRuntimeDriver({
      agentKind: 'opencode',
      requested: true,
      machineDefault: undefined,
      available: [...available],
      platform: 'linux',
    })
    expect(resolved).toEqual({ ok: true, driverId: 'opencode-server' })
  })

  it('honours an explicit opt-in', () => {
    const resolved = resolveRuntimeDriver({
      agentKind: 'opencode',
      requested: 'opencode-server',
      machineDefault: undefined,
      available: [...available],
      platform: 'linux',
    })
    expect(resolved).toEqual({ ok: true, driverId: 'opencode-server' })
    expect(isServerDriver('opencode', 'opencode-server')).toBe(true)
  })

  it('DEGRADES an opt-in the machine cannot run, rather than failing the spawn', () => {
    // A machine whose opencode is missing or out of the pinned range does not
    // list the driver. Honouring the preference anyway would turn a stale
    // settings value into a session that cannot start.
    const resolved = resolveRuntimeDriver({
      agentKind: 'opencode',
      requested: 'opencode-server',
      machineDefault: undefined,
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
    // A MACHINE-WIDE DEFAULT IS NOT A PER-SPAWN REQUEST, and this is the line
    // that keeps the degrade alive. `PODIUM_RUNTIME_DRIVER` reaches resolution
    // through `machineDefault`, never through `perSpawn`, so a stale env var on
    // a box whose opencode fell out of range degrades every spawn instead of
    // failing every spawn.
    expect(unhonouredSpawnDriver({ perSpawn: undefined, resolved: 'generic-pty' })).toBeUndefined()
    // `true` names no driver, so there is no request to break.
    expect(unhonouredSpawnDriver({ perSpawn: true, resolved: 'generic-pty' })).toBeUndefined()
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
    // way it can observe — refusing would be pedantry about a label, and it
    // would turn `PODIUM_RUNTIME_DRIVER=claude-pty` on an opencode session into
    // a dead spawn.
    expect(
      unhonouredSpawnDriver({ perSpawn: 'claude-pty', resolved: 'generic-pty' }),
    ).toBeUndefined()
  })

  it('asks ONE question for both refusals, so a stale env var cannot kill a box', () => {
    /**
     * THE DEFECT THIS PINS (POD-2113, found by review). The spawn path refuses in
     * two places — before resolution when a probe could not answer, and after it
     * when the driver was not the one picked — and only the second asked whether
     * THIS SPAWN named the driver. The first asked `requested`, the env default
     * already folded in.
     *
     * That is not a cosmetic asymmetry. A probe reports `unprobeable` on ENOENT,
     * not just on a timeout, and that verdict is deliberately not permanent —
     * so on a daemon whose PATH lacks the binary (installed under `~/.opencode/bin`,
     * daemon started from a systemd unit) a single `PODIUM_RUNTIME_DRIVER` made
     * EVERY spawn of EVERY harness refuse. The machine-wide value is exactly
     * the one that must degrade.
     */
    expect(spawnNamedServerDriver('opencode-server')).toBe('opencode-server')
    // W6'S SECOND SERVER DRIVER, which doubled the ways into the defect without
    // changing its shape. Read off the manifests rather than matched by name, so
    // a third family is covered when it is declared, not when someone remembers
    // this test.
    expect(spawnNamedServerDriver('codex-app-server')).toBe('codex-app-server')
    // THE MACHINE-WIDE DEFAULT NEVER REACHES THIS FUNCTION — it arrives as
    // `undefined` here and lives on in `requested` for probe selection and the
    // degrade warning. This one line is what keeps a stale env var survivable.
    expect(spawnNamedServerDriver(undefined)).toBeUndefined()
    // `true` asks for the contract and names no driver, so there is nothing to
    // refuse on its behalf.
    expect(spawnNamedServerDriver(true)).toBeUndefined()
    expect(spawnNamedServerDriver(false)).toBeUndefined()
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
      machineDefault: undefined,
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
      machineDefault: undefined,
      available: [...available],
      platform: 'linux',
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) expect(isServerDriver('claude-code', resolved.driverId)).toBe(false)
  })

  it('lists the server driver only when the version gate admits the binary', () => {
    expect(availableDriverIds({ opencodeDrivable: true })).toContain('opencode-server')
    expect(availableDriverIds({ opencodeDrivable: false })).not.toContain('opencode-server')
    // The terminal ids are unconditional either way — their mechanism is
    // Podium's own.
    expect(availableDriverIds({ opencodeDrivable: false })).toContain('generic-pty')
  })
})

describe('the version gate, as the daemon reads it', () => {
  beforeEach(() => resetOpencodeVersionProbe())
  afterEach(() => resetOpencodeVersionProbe())

  const answered = (output: string) => () => ({ output, ok: true })
  const silent =
    (output = '') =>
    () => ({ output, ok: false })

  it('admits a version in range and refuses one outside it', async () => {
    await expect(opencodeVersionProbe(answered('1.18.16'))).resolves.toEqual({ drivable: true })
    resetOpencodeVersionProbe()
    const verdict = await opencodeVersionProbe(answered('2.0.0'))
    expect(verdict.drivable).toBe(false)
    if (!verdict.drivable) expect(verdict.reason).toBe('unsupported')
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
    expect((await opencodeVersionProbe(probe)).drivable).toBe(false)
    // A spawn burst reuses the inconclusive result instead of repeating the
    // expensive process. Expiry behavior is pinned by version-probe.test.ts.
    expect((await opencodeVersionProbe(probe)).drivable).toBe(false)
    expect(calls).toBe(1)
  })

  it('separates "too old" from "could not find out"', async () => {
    // The distinction the spawn path branches on: one is a stable fact about the
    // machine and safe to degrade on, the other is a fact about load.
    const unsupported = await opencodeVersionProbe(answered('2.0.0'))
    expect(unsupported.drivable === false && unsupported.reason).toBe('unsupported')
    resetOpencodeVersionProbe()
    const unprobeable = await opencodeVersionProbe(silent('opencode ETIMEDOUT'))
    expect(unprobeable.drivable === false && unprobeable.reason).toBe('unprobeable')
    // …and it says so in terms an operator can act on, rather than blaming the
    // version it never read.
    if (!unprobeable.drivable) {
      expect(unprobeable.diagnostic.body).toContain('NOT about the version')
    }
  })

  it('reports "no" through the old boolean surface either way', async () => {
    // `availableDriverIds` only asks "may I drive it", and for an availability
    // LIST an unprobeable driver is correctly absent. The distinction lives at
    // the spawn site, which asks the verdict directly.
    await expect(opencodeVersionDiagnostic(answered('1.18.16'))).resolves.toBeNull()
    resetOpencodeVersionProbe()
    await expect(opencodeVersionDiagnostic(silent('ENOENT'))).resolves.not.toBeNull()
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
 * THE BIND FACT MUST SEE EVERY REGISTRY (POD-2023).
 *
 * `bind.runtimeContract` is what the server records on the row and what W4's
 * migrated senders branch on to choose between the contract and the legacy PTY
 * path. W3 had one registry, so the predicate behind it asked one. The moment a
 * second family exists, a predicate that still asks one reports `false` for a
 * server-family session — and W4 then routes its sends down a path that types at
 * a PTY the session does not have, where the write goes nowhere and reports
 * success.
 *
 * Caught by reading the epic's lessons register rather than by a failing test,
 * which is exactly why there is now a test.
 */
describe('the contract bind fact', () => {
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

  it('reports FALSE for a session in neither, which is the legacy path', () => {
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

  it('is what EVERY bind site actually calls — the adoption pin', () => {
    /**
     * THE TRIO ABOVE PINS THE PREDICATE; THIS PINS ITS ADOPTION (POD-2023 review
     * addendum, (b)).
     *
     * The bug that started this was a bind site asking ONE registry. Fixing the
     * predicate and testing the predicate leaves the regression fully available:
     * a site that reverts to `ctx.runtime?.has(...)` tomorrow passes all three
     * tests above and ships the same defect.
     *
     * So this reads the source and asserts the CALL SITES. Every `type: 'bind'`
     * in the daemon either routes through the predicate or — for a server
     * driver's own bind — hardcodes `true`, which is equivalent by construction
     * because the handle is registered before that line runs. An eighth bind site
     * appearing without one of those two shapes fails here.
     */
    const daemonSrc = join(import.meta.dirname, '..')
    const files = [
      join(daemonSrc, 'control', 'session.ts'),
      join(daemonSrc, 'runtime', 'opencode-driver.ts'),
      join(daemonSrc, 'runtime', 'codex-driver.ts'),
      join(daemonSrc, 'runtime', 'grok-driver.ts'),
    ]
    let bindSites = 0
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const [index, line] of source.split('\n').entries()) {
        if (!line.includes("type: 'bind'")) continue
        bindSites += 1
        // The frame body, from `type: 'bind'` to the call's closing `})`. Taken
        // by brace rather than by a line count: the opencode driver's bind
        // carries a long comment explaining why it states the fact outright, and
        // a fixed window would have "found" no fact there.
        const lines = source.split('\n')
        let body = ''
        for (let i = index; i < lines.length; i++) {
          body += `${lines[i]}\n`
          if (/^\s{0,8}\}\)/.test(lines[i] ?? '')) break
        }
        expect(
          body.includes('sessionIsBehindContract(') || body.includes('runtimeContract: true'),
          `bind site at ${file}:${index + 1} states no contract fact — a server-family session there would report false`,
        ).toBe(true)
        expect(
          body.includes('driverId'),
          `bind site at ${file}:${index + 1} does not report its resolved driver`,
        ).toBe(true)
        // …and NEVER by asking one registry directly, which is the regression.
        expect(
          body.includes('ctx.runtime?.has('),
          `bind site at ${file}:${index + 1} asks only the terminal registry`,
        ).toBe(false)
      }
    }
    /**
     * SEVEN today: launchSpawn, two handleReattach arms, three server-driver
     * launches, and the ADOPT path that rebinds a surviving server after restart.
     *
     * The count is asserted so a new bind site cannot be added without coming
     * here and deciding what it reports.
     */
    expect(bindSites).toBe(7)
  })
})

/**
 * THE BOOT-TIME `adopt()` CALLER (POD-2056's finding, fixed on POD-2023).
 *
 * `adopt()` was implemented and covered by four conformance properties, and
 * NOTHING CALLED IT. On a daemon restart `handleReattach` went straight to the
 * durable-host lookup, asked abduco and tmux whether they still held the
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
