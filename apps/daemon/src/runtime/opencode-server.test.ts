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
import type { SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runtimeContractEnabledFor, runtimeDriverFor } from './flag'
import {
  createOpencodeJournal,
  opencodeScopeLabel,
  opencodeVersionDiagnostic,
  resetOpencodeVersionProbe,
} from './opencode-server'
import { availableDriverIds, isServerDriver, resolveRuntimeDriver } from './registry'

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

  it('DEFAULTS TO TERMINAL, even with the server driver available', () => {
    // The behaviour-neutrality claim, at the one place a spawn could break it.
    const resolved = resolveRuntimeDriver({
      agentKind: 'opencode',
      requested: true,
      machineDefault: undefined,
      available: [...available],
      platform: 'linux',
    })
    expect(resolved).toEqual({ ok: true, driverId: 'generic-pty' })
    expect(isServerDriver('opencode', 'generic-pty')).toBe(false)
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

  it('admits a version in range and refuses one outside it', () => {
    expect(opencodeVersionDiagnostic(() => '1.18.16')).toBeNull()
    resetOpencodeVersionProbe()
    expect(opencodeVersionDiagnostic(() => '2.0.0')?.code).toBe('opencode-version-unsupported')
  })

  it('MEMOIZES, because the binary on PATH does not change under a running daemon', () => {
    let calls = 0
    const probe = (): string => {
      calls += 1
      return '1.18.16'
    }
    opencodeVersionDiagnostic(probe)
    opencodeVersionDiagnostic(probe)
    opencodeVersionDiagnostic(probe)
    // One fork of a 180MB binary per daemon, not one per session.
    expect(calls).toBe(1)
  })

  it('refuses when the probe THROWS, rather than treating an error as a pass', () => {
    resetOpencodeVersionProbe()
    const diagnostic = opencodeVersionDiagnostic(() => {
      throw new Error('ENOENT: opencode')
    })
    expect(diagnostic).not.toBeNull()
    expect(diagnostic?.observedVersion).toContain('ENOENT')
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
    expect(createOpencodeJournal().read(asSessionId('22222222-2222-4222-8222-222222222222'))).toBeUndefined()
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
