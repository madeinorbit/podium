/**
 * THE HOST MACHINE'S IDENTITY, END TO END (POD-318).
 *
 * Three properties, and each one is a thing that used to be untrue:
 *
 *  1. THE SENTINELS ARE GONE. Installs that predate this issue carried a
 *     `machines` row called `'local'` and sessions/repos/conversations rows on
 *     `'local'` or the `'__local__'` column default. The one-time rewrite that
 *     folded them onto this host's minted id was retired at POD-3246, once no
 *     release could still be carrying one; what stayed is the refusal, which
 *     stops the boot rather than serving rows the fleet cannot see.
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
import { asMachineId, asSessionId, FIRST_ADMIN_USER_ID, type RepoId } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMachineDirectory } from './gateway/machine-directory'
import { SessionRegistry } from './relay'
import { deriveRepoId } from './repo-id'
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

describe('the boot refusal that replaced the one-time upgrade', () => {
  it('refuses to open a pre-POD-318 database, naming every place a sentinel is stored', () => {
    // The rewrite that used to fold these rows onto the host id was deleted at
    // POD-3246: the sentinels stopped being written on 2026-08-02 and the first
    // release of any kind is v0.1.0-edge.1 on 2026-08-17, so no database a
    // shipped Podium has ever written can contain one. A database that does is
    // one the fleet cannot see, and the boot says so instead of serving it.
    const path = tmpDb()
    seedLegacyDb(path)

    expect(() => new SessionStore(path, HOST)).toThrow(
      /retired machine sentinels.*machines\.id.*repos\.machine_id.*sessions\.machine_id/s,
    )
  })

  it('finds a sentinel in a table no hand-written list would have named', () => {
    // `issues.machine_id` is an issue's machine pin — ordinary user data that
    // could name the machine the UI called `local`, and the placeholder era did
    // ship a rewrite whose list was "sessions, repos, conversations". The scan
    // covers every machine column in the schema, which is what
    // `store/machines-sentinel-scan.test.ts` pins.
    const path = tmpDb()
    new SessionStore(path, HOST).close()
    const db = openDatabase(path)
    db.exec(`
      INSERT INTO issues (id, repo_path, seq, title, stage, parent_branch, default_agent,
                          created_at, updated_at, machine_id)
        VALUES ('iss_1', '/r', 1, 'pinned', 'backlog', 'main', 'claude-code', 't', 't', 'local');
    `)
    db.close()

    expect(() => new SessionStore(path, HOST)).toThrow(
      /retired machine sentinels.*issues\.machine_id/s,
    )
  })

  it('says nothing on a database no sentinel was ever written to', () => {
    const store = new SessionStore(':memory:', HOST)
    expect(store.machines.legacyMachineSentinelSites()).toEqual([])
    store.repos.addRepo('/w', HOST)
    expect(store.machines.legacyMachineSentinelSites()).toEqual([])
    store.close()
  })
})

/**
 * THE CASE THAT CAN ACTUALLY HURT SOMEBODY.
 *
 * Retiring an upgrade makes two databases easy to test — a fresh one and a
 * deliberately legacy one — and leaves the third untested: the one a person is
 * running RIGHT NOW, which went through those upgrades on some earlier boot and
 * must keep opening in silence. A refusal that fired on it would take a live
 * install down at the exact moment the code that used to repair it was deleted.
 *
 * So this seeds the pre-POD-318 shape, replays byte for byte what the two
 * retired upgrades wrote, and asserts the boot says nothing at all.
 */
describe('a database that already ran the retired upgrades', () => {
  /** Exactly what `migrateLegacyMachineIdentity` and `migrateLegacyRepoIdentity`
   *  left behind: sentinels folded onto the host id (the `machines` row RENAMED,
   *  not re-inserted), an identity and a prefix on the repo, and the spent-once
   *  marker in `meta`. */
  function replayRetiredUpgrades(path: string): RepoId {
    const db = openDatabase(path)
    const repoId = deriveRepoId({ machineId: HOST, path: '/legacy/repo' })
    db.exec(`
      UPDATE OR REPLACE machines SET id = '${HOST}' WHERE id IN ('local', '__local__');
      UPDATE OR REPLACE sessions SET machine_id = '${HOST}'
        WHERE machine_id IN ('local', '__local__');
      UPDATE OR REPLACE repos SET machine_id = '${HOST}'
        WHERE machine_id IN ('local', '__local__');
      UPDATE OR REPLACE conversations SET machine_id = '${HOST}'
        WHERE machine_id IN ('local', '__local__');
      UPDATE repos SET repo_id = '${repoId}' WHERE repo_id IS NULL;
      INSERT INTO repo_prefixes (repo_id, prefix) VALUES ('${repoId}', 'LEG');
      INSERT INTO meta (key, value) VALUES ('repo-identity-upgrade', 't');
    `)
    db.close()
    return repoId
  }

  it('opens in silence, and keeps every row the upgrades moved', () => {
    const path = tmpDb()
    seedLegacyDb(path)
    const repoId = replayRetiredUpgrades(path)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = new SessionStore(path, HOST)

      // Nothing refused, and nothing warned either — a live install's boot log
      // does not gain a line because an upgrade was deleted underneath it.
      expect(warn).not.toHaveBeenCalled()
      expect(store.machines.legacyMachineSentinelSites()).toEqual([])

      // And the rows are exactly where the upgrades put them.
      expect(store.sessions.loadSessions().map((s) => s.machineId)).toEqual([HOST, HOST])
      expect(store.repos.listRepos().map((r) => r.machineId)).toEqual([HOST])
      expect(store.repos.listRepos()[0]?.repoId).toBe(repoId)
      expect(store.repos.prefixForRepoId(repoId)).toBe('LEG')
      const machines = store.machines.listMachines()
      expect(machines).toHaveLength(1)
      expect(machines[0]?.id).toBe(HOST)
      // The RENAME is why this survived: a fresh insert would have dropped the
      // owner the legacy row carried, and split the fleet in half.
      expect(machines[0]?.ownerUserId).toBe('user:sole')
      store.close()
    } finally {
      warn.mockRestore()
    }
  })

  it('and the seed itself would have been refused — the assertion above is not vacuous', () => {
    const path = tmpDb()
    seedLegacyDb(path)
    expect(() => new SessionStore(path, HOST)).toThrow(/retired machine sentinels/)
  })
})

describe('the split-mode local daemon authenticates as this host', () => {
  const bootedRegistry = (secret: string) => {
    const store = new SessionStore(':memory:', HOST)
    const registry = SessionRegistry.create(store, undefined, { instanceId: 'default' })
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
    const registry = SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registry.modules.machines.ensureHostMachine('other-host', 'other-secret')

    expect(
      createMachineDirectory(registry.modules.machines).verifyDaemonSecret('other-secret'),
    ).toMatchObject({ machine: other })
  })
})

describe('composition threads deployment identity explicitly', () => {
  it('derives fleet and durable-session namespaces from the constructor parameter', () => {
    const store = new SessionStore(':memory:', HOST)
    const registry = SessionRegistry.create(store, undefined, { instanceId: 'blue' })

    expect(registry.modules.machines.instanceId).toBe('blue')
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    const session = store.sessions.getSession(sessionId)
    expect(session?.durableLabel).toBe('podium-blue-' + sessionId)

    const headless = registry.modules.sessions.headless.createHeadlessSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    expect(store.sessions.getSession(headless.sessionId)?.durableLabel).toBe(
      'podium-blue-' + headless.sessionId,
    )
    registry.dispose()
    store.close()
  })
})

describe('rows are attributed from birth — there is no placeholder phase', () => {
  it('a session created before any daemon connects already names the host', () => {
    const store = new SessionStore(':memory:', HOST)
    const registry = SessionRegistry.create(store, undefined, { instanceId: 'default' })
    registry.modules.machines.ensureHostMachine('this-host', 'secret')

    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })

    expect(
      registry.modules.sessions.listSessions().find((s) => s.sessionId === sessionId)?.machineId,
    ).toBe(HOST)
    expect(store.sessions.loadSessions()[0]?.machineId).toBe(HOST)
    store.close()
  })

  it('defaultMachine answers with the host even when its daemon is offline', () => {
    const store = new SessionStore(':memory:', HOST)
    const registry = SessionRegistry.create(store, undefined, { instanceId: 'default' })
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
