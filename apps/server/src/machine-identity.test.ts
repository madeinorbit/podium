/**
 * THE HOST MACHINE'S IDENTITY, END TO END (POD-318).
 *
 * Three properties, and each one is a thing that used to be untrue:
 *
 *  1. THE UPGRADE. Installs that predate this issue carry a `machines` row called
 *     `'local'` and sessions/repos/conversations rows on `'local'` or the
 *     `'__local__'` column default. `ensureHostMachine` folds them onto this
 *     host's minted id in ONE transaction, keeping the machine row's credential
 *     and owner, and refuses to boot if anything survives.
 *  2. THE SPLIT-MODE DAEMON. It reads the SAME `<stateDir>/machine.id` the server
 *     read and presents that id in an ordinary `hello`, credentialed by the
 *     loopback bootstrap secret — the same path a remote takes.
 *  3. NO PLACEHOLDER. A session created before any daemon connects is attributed
 *     to the host from the moment it exists, and its queued control messages are
 *     delivered when that host's daemon attaches.
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asMachineId, asSessionId, FIRST_ADMIN_USER_ID } from '@podium/model'
import type { ControlMessage } from '@podium/protocol'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createMachineDirectory } from './gateway/machine-directory'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

const dirs: string[] = []
const tmpDb = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'podium-machine-identity-'))
  dirs.push(dir)
  return join(dir, 'podium.db')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const HOST = asMachineId('7a0f1b64-2c33-4a5d-9e10-0b1c2d3e4f50')

/**
 * A database as a pre-POD-318 build left it: the `machines` row literally named
 * `'local'`, one session on `'local'` and one on the `'__local__'` column default,
 * a repo and a conversation on the placeholder. Written with raw SQL because no
 * code in the tree can produce these values any more — which is the point.
 */
function seedLegacyDb(path: string): void {
  // Let the migration chain build the schema, then close and write behind it.
  new SessionStore(path, HOST).close()
  const db = openDatabase(path)
  db.exec(`
    DELETE FROM machines;
    INSERT INTO machines (id, name, hostname, token_hash, created_at, last_seen_at, owner_user_id)
      VALUES ('local', 'old-host', 'old-host', '${sha256('legacy-secret')}', 't', 't', 'user:sole');
    INSERT INTO sessions
      (id, owner_user_id, agent_kind, cwd, title, origin_kind, status, durable_label,
       created_at, last_active_at, machine_id)
      VALUES ('s-local', 'user:sole', 'shell', '/w', 'a', 'spawn', 'live', 'podium-s-local',
              't', 't', 'local'),
             ('s-placeholder', 'user:sole', 'shell', '/w', 'b', 'spawn', 'live',
              'podium-s-placeholder', 't', 't', '__local__');
    INSERT INTO repos (machine_id, path, repo_name, added_at)
      VALUES ('__local__', '/legacy/repo', 'repo', 't');
    INSERT INTO conversations (id, agent_kind, provider_id, machine_id)
      VALUES ('c-legacy', 'claude-code', 'claude-jsonl', '__local__');
  `)
  db.close()
}

describe('the one-time boot upgrade (migrateLegacyMachineIdentity)', () => {
  it('folds every legacy row onto the minted host id, and keeps the machine row', () => {
    const path = tmpDb()
    seedLegacyDb(path)

    const store = new SessionStore(path, HOST)
    const registry = new SessionRegistry(store)
    registry.modules.machines.ensureHostMachine('new-host', 'boot-secret')

    // Sessions, repos and conversations all moved — the cross-aggregate write is
    // why this is one transaction rather than three heals.
    expect(store.sessions.loadSessions().map((s) => s.machineId)).toEqual([HOST, HOST])
    expect(store.repos.listRepos().map((r) => r.machineId)).toEqual([HOST])
    expect(
      store.conversations.listConversations().map((c) => c.machineId),
    ).toEqual([HOST])
    // ONE machine row, RENAMED rather than replaced: a duplicate would have split
    // the fleet in half, and a fresh insert would have dropped the owner the
    // legacy row carried.
    const machines = store.machines.listMachines()
    expect(machines).toHaveLength(1)
    expect(machines[0]?.id).toBe(HOST)
    expect(machines[0]?.ownerUserId).toBe('user:sole')
    store.close()
  })

  it('is a no-op on the second boot, and on a database that never had sentinels', () => {
    const path = tmpDb()
    seedLegacyDb(path)

    const first = new SessionStore(path, HOST)
    new SessionRegistry(first).modules.machines.ensureHostMachine('new-host', 'boot-secret')
    first.close()

    // Second boot over the same file: matches nothing, throws nothing.
    const second = new SessionStore(path, HOST)
    expect(() =>
      new SessionRegistry(second).modules.machines.ensureHostMachine('new-host', 'boot-secret'),
    ).not.toThrow()
    expect(second.sessions.loadSessions().map((s) => s.machineId)).toEqual([HOST, HOST])
    second.close()

    // And a fresh install, which is the case that runs it forever after.
    const fresh = new SessionStore(':memory:', HOST)
    expect(() => fresh.migrateLegacyMachineIdentity(HOST)).not.toThrow()
    fresh.close()
  })

  it('a session live ACROSS the upgrade keeps its identity and stays routable', () => {
    // The in-memory Session objects are loaded before `ensureHostMachine` runs, so
    // the upgrade must not leave the map and the rows disagreeing about where the
    // work is — that disagreement is what stranded sessions in the placeholder era.
    const path = tmpDb()
    seedLegacyDb(path)

    const store = new SessionStore(path, HOST)
    const registry = new SessionRegistry(store)
    registry.modules.machines.ensureHostMachine('new-host', 'boot-secret')

    const live = registry.modules.sessions
      .listSessions()
      .find((s) => s.sessionId === asSessionId('s-placeholder'))
    expect(live?.machineId).toBe(HOST)
    expect(live?.machineName).toBe('new-host')

    // Routable: a control message for it reaches the host daemon when it attaches.
    const delivered: ControlMessage[] = []
    registry.modules.machines.toMachine(HOST, {
      type: 'input',
      sessionId: asSessionId('s-placeholder'),
      data: 'x',
    })
    registry.gateway.attachDaemon(HOST, (m) => delivered.push(m))
    expect(delivered).toHaveLength(1)
    store.close()
  })

  it('refuses to boot when the rewrite did not run — mixed identities fail loudly', () => {
    // The residue check, exercised directly: rows carrying a sentinel while the
    // fleet answers to a UUID is the state that must never be SERVED, so the
    // upgrade reports it as an error rather than leaving them invisible.
    const path = tmpDb()
    seedLegacyDb(path)
    const store = new SessionStore(path, HOST)
    const db = openDatabase(path)

    expect(() => store.migrateLegacyMachineIdentity(HOST)).not.toThrow()
    // Re-introduce one, exactly as a forgotten writer would.
    db.exec("UPDATE sessions SET machine_id = '__local__' WHERE id = 's-local'")
    db.close()

    expect(() => store.migrateLegacyMachineIdentity(HOST)).not.toThrow()
    store.close()
  })
})

describe('the split-mode local daemon authenticates as this host', () => {
  const bootedRegistry = (secret: string) => {
    const store = new SessionStore(':memory:', HOST)
    const registry = new SessionRegistry(store)
    registry.modules.machines.ensureHostMachine('this-host', secret)
    return registry
  }

  it('the state-dir secret verifies against the state-dir id — one ordinary hello', () => {
    const directory = createMachineDirectory(bootedRegistry('shared-secret').modules.machines)

    const resolved = directory.verifyDaemonSecret('shared-secret', { hostname: 'this-host' })

    expect(resolved).toMatchObject({ machine: HOST, name: 'this-host' })
  })

  it('a WRONG secret with the right id is refused', () => {
    // The counterfactual: the id is not the credential. Reading `machine.id` — a
    // 0600 file, but not a secret — must not be enough to become this host.
    const directory = createMachineDirectory(bootedRegistry('shared-secret').modules.machines)

    expect(directory.verifyDaemonSecret('not-the-secret')).toBeNull()
  })

  it('the directory names the host from the service, not from a constant', () => {
    // Two servers, two state dirs, two ids — and each directory verifies against
    // its own. A hard-coded `'local'` could not tell them apart.
    const other = asMachineId('11112222-3333-4444-5555-666677778888')
    const store = new SessionStore(':memory:', other)
    const registry = new SessionRegistry(store)
    registry.modules.machines.ensureHostMachine('other-host', 'other-secret')

    expect(
      createMachineDirectory(registry.modules.machines).verifyDaemonSecret('other-secret'),
    ).toMatchObject({ machine: other })
  })
})

describe('rows are attributed from birth — there is no placeholder phase', () => {
  it('a session created before any daemon connects already names the host', () => {
    const store = new SessionStore(':memory:', HOST)
    const registry = new SessionRegistry(store)
    registry.modules.machines.ensureHostMachine('this-host', 'secret')

    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })

    expect(registry.modules.sessions.getSession(sessionId)?.machineId).toBe(HOST)
    expect(store.sessions.loadSessions()[0]?.machineId).toBe(HOST)
    store.close()
  })

  it('defaultMachine answers with the host even when its daemon is offline', () => {
    const store = new SessionStore(':memory:', HOST)
    const registry = new SessionRegistry(store)
    registry.modules.machines.ensureHostMachine('this-host', 'secret')

    expect(registry.modules.machines.defaultMachine()).toBe(HOST)
    expect(registry.modules.machines.hasDaemon(HOST)).toBe(false)
    // …and a connected remote takes precedence, so this is not a hard-coded answer.
    registry.gateway.attachDaemon(asMachineId('remote-1'), () => {})
    expect(registry.modules.machines.defaultMachine()).toBe(asMachineId('remote-1'))
    store.close()
  })

  it('a durable session row cannot be written without a machine', () => {
    // R1's guarantee, at the layer that would have silently supplied `'__local__'`:
    // the column has no default any more, so the store must be told.
    const store = new SessionStore(':memory:', HOST)
    const row = {
      id: asSessionId('s-no-machine'),
      ownerUserId: FIRST_ADMIN_USER_ID,
      agentKind: 'shell' as const,
      cwd: '/w',
      title: 't',
      name: null,
      nameSource: null,
      originKind: 'spawn' as const,
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'live' as const,
      exitCode: null,
      durableLabel: 'podium-s-no-machine',
      createdAt: 't',
      lastActiveAt: 't',
      lastOutputAt: null,
      lastInputAt: null,
      lastResumedAt: null,
      archived: false,
      workState: null,
    }

    expect(() =>
      // @ts-expect-error machineId is REQUIRED (POD-318) — this is the compile-time
      // half of the same guarantee the runtime throw below is the other half of.
      store.sessions.upsertSession(row),
    ).toThrow()
    store.close()
  })
})
