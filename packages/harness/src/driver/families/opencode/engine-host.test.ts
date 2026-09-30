/**
 * THE OPENCODE ENGINE HOST (moved from apps/daemon/src/runtime/opencode-server.test.ts
 * in 1.5 with the code it pins).
 *
 * The family is handed its engine through injected supervision ports and never
 * spawns, journals or kills: the fakes below stand in for the supervisor's
 * durable process, and every harness-shaped value (serve argv, scope tokens,
 * strip lists, preview flavor) is read off the adapter's sections through the
 * flavor facts. The same host drives the preview speaker with different
 * flavor facts, no edits.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { EngineBindUnrecoverable } from '../engine-supervision.js'
import { isDriverRefusal } from '../../errors.js'
import { asSessionId } from '@podium/model'
import {
  type OpencodeEngineHostDeps,
  createOpencodeEngineHost,
  evaluateOpencode2VersionProbe,
  evaluateOpencodeVersionProbe,
  OpencodeEngineLeaseRefused,
  opencodeScopeLabel,
  probeHealth,
} from './engine-host.js'
import { opencode2Flavor, opencodeFlavor } from './engine-facts.js'
import { createOpencodeClient } from './client.js'
import { manifestFor } from '../../../registry.js'
import type {
  EngineAttachment,
  EngineProcessOwner,
  EngineSupervisor,
  SessionEngineOwner,
} from '../engine-supervision.js'
import { createMemoryBindingRecords, createTestEngineOwner } from '../../testing/binding-records.js'
import type { OpencodeJournalEntry } from './runtime.js'

const SESSION = asSessionId('11111111-1111-4111-8111-111111111111')
const FLAVOR = opencodeFlavor(manifestFor('opencode')!)
const FLAVOR2 = opencode2Flavor(manifestFor('opencode')!)

it('passes the isolated store to the v2 pending-admission reader', () => {
  const configs: unknown[] = []
  const host = engineHost({
    flavor: FLAVOR2,
    flavorEnv: { OPENCODE_DB: '/instance/state/opencode2.db' },
    makeClient: (config) => {
      configs.push(config)
      return createOpencodeClient(config)
    },
  })
  host.makeClient!({
    baseUrl: 'http://127.0.0.1:41427',
    username: 'opencode',
    password: 'fixture',
    directory: '/repo',
  })
  expect(configs).toMatchObject([{ databasePath: '/instance/state/opencode2.db' }])
})

function engineHost(extra: Partial<OpencodeEngineHostDeps> = {}) {
  return createOpencodeEngineHost({
    flavor: FLAVOR,
    stageAttachment: async () => { throw new Error('attachments are not under test') },
    resources: () => undefined,
    buildEnv: () => ({}),
    gracefulExitMs: 1,
    checkVersion: async () => null,
    freePort: async () => 41234,
    ...extra,
  })
}

/** A held engine attachment the test drives by hand. */
function fakeEngineSession(input: { childPid?: number; lease?: boolean } = {}): {
  session: EngineAttachment
  exits: Array<(code: number, signal: number) => void>
} {
  const exits: Array<(code: number, signal: number) => void> = []
  const session: EngineAttachment = {
    ready: Promise.resolve({
      lease: input.lease ?? true,
      childPid: input.childPid ?? 4242,
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
  }
  return { session, exits }
}

/**
 * Both ports the family consumes, built from one set of hooks: the
 * session-owned process verbs (`engines`) carry the behavior under test,
 * while the scope port (`supervision`) answers nothing on this platform.
 * Spread at the call site: `...fakePorts({ startEngine: ... })`.
 */
function fakePorts(hooks: {
  startEngine?: (opts: {
    label: string
    cmd: string
    args: string[]
    cwd: string
    env: Record<string, string>
    stripEnv: readonly string[]
  }) => Promise<EngineAttachment>
  reattachEngine?: (opts: { label: string; fromSeq: 'tail' }) => Promise<EngineAttachment>
  destroyed?: (label: string) => void
  /** What the session layer recorded for the session. */
  recorded?: OpencodeJournalEntry
  /** Every fact set the family reported as bound. */
  reported?: OpencodeJournalEntry[]
}): {
  supervision: Pick<EngineSupervisor, 'scopeUnitFor'>
  engines: SessionEngineOwner<OpencodeJournalEntry>
} {
  const records = createMemoryBindingRecords<OpencodeJournalEntry>(
    hooks.recorded ? [hooks.recorded] : [],
  )
  const owner = createTestEngineOwner<OpencodeJournalEntry>(
    {
      ...(hooks.startEngine ? { startEngine: hooks.startEngine } : {}),
      ...(hooks.reattachEngine
        ? { reattachEngine: (input) => hooks.reattachEngine!({ label: input.label, fromSeq: 'tail' }) }
        : {}),
      destroyEngine: async (label) => {
        hooks.destroyed?.(label)
      },
    },
    { records },
  )
  return {
    supervision: { scopeUnitFor: () => undefined },
    engines: {
      ...owner,
      bound: (facts) => {
        hooks.reported?.push(facts)
        owner.bound(facts)
      },
    },
  }
}

  it('admits only the OpenCode 2 betas whose API boundary is exercised', async () => {
    expect(evaluateOpencode2VersionProbe('0.0.0-beta-18743', true)).toEqual({ drivable: true })
    expect(evaluateOpencode2VersionProbe('0.0.0-beta-18866', true)).toEqual({ drivable: true })
    const future = evaluateOpencode2VersionProbe('0.0.0-beta-18867', true)
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
    const launched: Array<Parameters<EngineProcessOwner['startEngine']>[0]> = []
    const stopped = new Error('stop after argv capture')
    const host = engineHost({
      executablePath: executable,
      checkVersion: async () => null,
      ...fakePorts({
        startEngine: async (opts) => {
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
      label: opencodeScopeLabel(FLAVOR, SESSION),
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
    const launched: Array<Parameters<EngineProcessOwner['startEngine']>[0]> = []
    const host = engineHost({
      flavor: FLAVOR2,
      flavorEnv: { OPENCODE_DB: '/instance/state/opencode2.db' },
      checkVersion: async () => null,
      ...fakePorts({
        startEngine: async (opts) => {
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
    // The stem is the adapter's `runtime.server.spawn` section, with the
    // resolved executable and the supervisor-picked port substituted.
    expect(FLAVOR.serveArgs('/opt/resolved/opencode', 41234)).toEqual([
      '/opt/resolved/opencode',
      'serve',
      '--port',
      '41234',
      '--hostname',
      '127.0.0.1',
    ])
    expect(FLAVOR.serveArgs('/usr/bin/opencode', 41234)[0]).toBe('/usr/bin/opencode')
    expect(FLAVOR.serveArgs('opencode', 41234)[0]).toBe('opencode')
  })

  describe('headless adopt (POD-4433)', () => {
    const journalled = {
      sessionId: SESSION,
      opencodeSessionId: 'ses_adoptme',
      baseUrl: 'http://127.0.0.1:41234',
      username: 'podium',
      secret: 'journalled-secret',
      workdir: '/tmp',
      databasePath: '/original-home/opencode.db',
      process: { key: opencodeScopeLabel(FLAVOR, SESSION), pid: 4242 },
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
      process: { key: opencodeScopeLabel(FLAVOR, SESSION) },
      bindingVersion: 1,
    } as never

    function adoptHost(hooks: {
      reattachEngine?: (opts: { label: string; fromSeq: 'tail' }) => Promise<EngineAttachment>
    }) {
      return engineHost({
        ...fakePorts({ ...hooks, recorded: journalled }),
      })
    }

    it('adopts a surviving server in place: same port and secret, no second spawn', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
      const spawned: Array<Parameters<EngineProcessOwner['startEngine']>[0]> = []
      const { session } = fakeEngineSession({ childPid: 4242 })
      const host = engineHost({
        checkVersion: async () => null,
        freePort: async () => 49999,
        ...fakePorts({
          recorded: journalled,
          startEngine: async (opts) => {
            spawned.push(opts)
            throw new Error('a live server must be adopted, never re-spawned')
          },
          reattachEngine: async () => session,
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
        expect(endpoint.databasePath).toBe(journalled.databasePath)
        expect(spawned).toHaveLength(0)
      } finally {
        fetch.mockRestore()
      }
    })

    it('host.adopt rebinds the survivor for the driver', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
      const { session } = fakeEngineSession({ childPid: 4242 })
      const host = adoptHost({ reattachEngine: async () => session })
      try {
        const endpoint = await host.adopt(binding)
        expect(endpoint?.baseUrl).toBe(journalled.baseUrl)
        expect(endpoint?.password).toBe(journalled.secret)
        expect(endpoint?.process.key).toBe(opencodeScopeLabel(FLAVOR, SESSION))
        expect(endpoint?.databasePath).toBe(journalled.databasePath)
      } finally {
        fetch.mockRestore()
      }
    })

    it('a writer lease held elsewhere refuses loudly instead of spawning beside it', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
      const spawned: Array<Parameters<EngineProcessOwner['startEngine']>[0]> = []
      const { session } = fakeEngineSession({ childPid: 4242, lease: false })
      const host = engineHost({
        checkVersion: async () => null,
        freePort: async () => 49999,
        ...fakePorts({
          recorded: journalled,
          startEngine: async (opts) => {
            spawned.push(opts)
            throw new Error('must not spawn beside a leased engine')
          },
          reattachEngine: async () => session,
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
      const directory = mkdtempSync(join(tmpdir(), 'opencode-host-exit-'))
      const databasePath = join(directory, 'history.db')
      const db = openDatabase(databasePath)
      db.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_updated INTEGER)')
      db.exec('CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER)')
      db.close()
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
      const { session, exits } = fakeEngineSession({ childPid: 4242 })
      const host = engineHost({
        checkVersion: async () => null,
        freePort: async () => 41234,
        buildEnv: () => ({ OPENCODE_DB: 'history.db' }),
        ...fakePorts({ startEngine: async () => session }),
      })
      try {
        const endpoint = await host.launch({
          sessionId: SESSION,
          workdir: directory,
          secret: 'secret',
          username: 'podium',
        })
        expect(endpoint.engineExit?.()).toBeUndefined()
        expect(endpoint.databasePath).toBe(databasePath)
        expect(await endpoint.readHistoryAfterExit?.('ses_exit')).toBeUndefined()
        for (const fire of exits) fire(3, 0)
        expect(endpoint.engineExit?.()).toEqual({ code: 3, signal: 0 })
        expect(await endpoint.readHistoryAfterExit?.('ses_exit')).toEqual([])
      } finally {
        fetch.mockRestore()
        rmSync(directory, { recursive: true, force: true })
      }
    })
  })

  it('admits recorded and newer versions', async () => {
    expect(evaluateOpencodeVersionProbe('1.18.16', true)).toEqual({ drivable: true })
    const verdict = evaluateOpencodeVersionProbe('2.0.0', true)
    expect(verdict.drivable).toBe(true)
    expect(verdict.diagnostic?.body).toContain('session runs normally')
  })

  it('refuses too old but admits an unknown version', async () => {
    const unsupported = evaluateOpencodeVersionProbe('1.17.99', true)
    expect(unsupported.drivable).toBe(false)
    expect(unsupported.diagnostic?.body).toContain('Install opencode 1.18 or newer')
    const unprobeable = evaluateOpencodeVersionProbe('opencode ETIMEDOUT', false)
    expect(unprobeable).toMatchObject({ drivable: true, reason: 'unprobeable' })
    expect(unprobeable.diagnostic?.body).toContain('session runs normally')
  })

describe('the scope label', () => {
  it('is per-session and stable, which is what `adopt()` matches on', () => {
    const label = opencodeScopeLabel(FLAVOR, SESSION)
    expect(label).toContain(SESSION)
    // A PURE FUNCTION OF THE SESSION ID, and that is the property `adopt()`
    // depends on: the process identity must survive a restart that gives the
    // server a DIFFERENT port. A key derived from the port would let `adopt()`
    // bind to whatever process inherited it — the kernel recycles one within
    // seconds — which the contract calls worse than not adopting.
    expect(opencodeScopeLabel(FLAVOR, SESSION)).toBe(label)
    const other = asSessionId('33333333-3333-4333-8333-333333333333')
    expect(opencodeScopeLabel(FLAVOR, other)).not.toBe(label)
  })
})

describe('spec §6 — the secret rides the env', () => {
  it('keeps a secret out of the serve argv this daemon constructs', () => {
    const secret = 'a-very-secret-value'
    // The argv shape the launch path builds, read off the same section it
    // reads: port and hostname, and nothing else that could carry a
    // credential.
    const serveArgv = FLAVOR.serveArgs('opencode', 41234)
    expect(serveArgv.join(' ')).not.toContain(secret)
    // …and loopback is not a setting. A `--hostname 0.0.0.0` here would put spec
    // §6's whole argument in a config file.
    expect(serveArgv).toContain('127.0.0.1')
    expect(serveArgv).not.toContain('0.0.0.0')
  })
})

describe('§4.8 failure ownership — bind failure keeps the engine', () => {
  it('engine up but server silent: launch rejects typed, kills nothing, journals nothing', async () => {
    // §4.8 step 4, same shape as the codex family's: the health wait expires
    // with the engine running. Our hold is released but the engine is KEPT —
    // killing it would destroy what the lifecycle owner could still adopt
    // from this error's address and secret. The secret rides a field, never
    // the message.
    const killed: string[] = []
    const written: OpencodeJournalEntry[] = []
    const { session } = fakeEngineSession()
    const host = engineHost({
      checkVersion: async () => null,
      freePort: async () => 41234,
      ...fakePorts({
        reported: written,
        startEngine: async () => session,
        destroyed: (label) => void killed.push(label),
      }),
    })
    const error = await host
      .launch({ sessionId: SESSION, workdir: '/tmp', secret: 's3cret', username: 'podium' })
      .then(
        () => null,
        (err: unknown) => err,
      )
    expect(error).toBeInstanceOf(EngineBindUnrecoverable)
    expect((error as EngineBindUnrecoverable).during).toBe('launch')
    expect((error as EngineBindUnrecoverable).address).toBe('http://127.0.0.1:41234')
    expect((error as EngineBindUnrecoverable).secret).toBe('s3cret')
    expect(String((error as Error).message)).not.toContain('s3cret')
    expect(killed).toEqual([])
    expect(written).toEqual([])
  }, 90_000)
})

describe('readHistory — the Store read over the sqlite database', () => {
  const NATIVE = 'ses-history-probe'
  const PODIUM = asSessionId('55555555-5555-4555-8555-555555555555')

  const OPENCODE_SCHEMA = {
    session: `CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'proj',
      parent_id TEXT,
      slug TEXT NOT NULL DEFAULT 'slug',
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1',
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER,
      workspace_id TEXT,
      path TEXT,
      agent TEXT,
      model TEXT,
      cost REAL NOT NULL DEFAULT 0,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      metadata TEXT
    )`,
    message: `CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    )`,
    part: `CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    )`,
  }

  interface SeedPart {
    partId: string
    messageId: string
    role: 'user' | 'assistant'
    part: Record<string, unknown>
    timeUpdated: number
  }

  /** Build a temp opencode home with one session and a list of parts, in the
   *  order given. Each part rides its own message row (role lives on the message). */
  async function seedOpencode(sessionId: string, parts: SeedPart[]): Promise<{ homeDir: string }> {
    const homeDir = await mkdtemp(join(tmpdir(), 'pod-4781-oc-hist-'))
    const root = join(homeDir, '.local', 'share', 'opencode')
    await mkdir(root, { recursive: true })
    const db = openDatabase(join(root, 'opencode.db'))
    db.exec(OPENCODE_SCHEMA.session)
    db.exec(OPENCODE_SCHEMA.message)
    db.exec(OPENCODE_SCHEMA.part)
    db.prepare(
      `INSERT INTO session (id, directory, title, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(sessionId, '/tmp/opencode-history-probe', 't', 1, 2)
    const seenMessages = new Set<string>()
    const insMsg = db.prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?)`,
    )
    const insPart = db.prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const p of parts) {
      if (!seenMessages.has(p.messageId)) {
        seenMessages.add(p.messageId)
        insMsg.run(p.messageId, sessionId, p.timeUpdated, p.timeUpdated, JSON.stringify({ role: p.role }))
      }
      insPart.run(p.partId, p.messageId, sessionId, p.timeUpdated, p.timeUpdated, JSON.stringify(p.part))
    }
    db.close()
    return { homeDir }
  }

  function textPart(
    partId: string,
    messageId: string,
    role: 'user' | 'assistant',
    text: string,
    timeUpdated: number,
  ): SeedPart {
    return { partId, messageId, role, timeUpdated, part: { type: 'text', text } }
  }

  function hostFor(homeDir: string) {
    return engineHost({ homeDir })
  }

  it('reads the sqlite user message and assistant reply through the resume value', async () => {
    // THE PRODUCTION READER, against a real sqlite store: the driver's history
    // delegates here, so this is the half the conformance suite cannot see
    // (that suite supplies its own readHistory over the fake's map).
    const { homeDir } = await seedOpencode(NATIVE, [
      textPart('prt-u1', 'msg-u1', 'user', 'hello from disk', 100),
      textPart('prt-a1', 'msg-a1', 'assistant', 'reply from disk', 101),
    ])
    try {
      const host = hostFor(homeDir)
      const page = await host.readHistory(
        {
          sessionId: PODIUM,
          agentKind: 'opencode',
          cwd: '/tmp/opencode-history-probe',
          resume: { kind: 'opencode-session', value: NATIVE },
        },
        { limit: 50 },
      )
      expect(page.items.map((item) => [item.role, item.text])).toEqual([
        ['user', 'hello from disk'],
        ['assistant', 'reply from disk'],
      ])
      expect(page.hasMore).toBe(false)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it("pages older items through the returned cursor ('before' limit 1, then head)", async () => {
    const { homeDir } = await seedOpencode(NATIVE, [
      textPart('prt-u1', 'msg-u1', 'user', 'hello from disk', 100),
      textPart('prt-a1', 'msg-a1', 'assistant', 'reply from disk', 101),
    ])
    try {
      const host = hostFor(homeDir)
      const session = {
        sessionId: PODIUM,
        agentKind: 'opencode' as const,
        cwd: '/tmp/opencode-history-probe',
        resume: { kind: 'opencode-session' as const, value: NATIVE },
      }
      const newest = await host.readHistory(session, { limit: 1 })
      expect(newest.items.map((item) => item.text)).toEqual(['reply from disk'])
      expect(newest.hasMore).toBe(true)
      expect(newest.head).toBeDefined()
      const earlier = await host.readHistory(session, {
        from: newest.head,
        limit: 10,
      })
      expect(earlier.items.map((item) => item.text)).toEqual(['hello from disk'])
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('a session with no messages yet reads as an empty page, not an error', async () => {
    // No rows for this native session id: history before the first turn is
    // empty — the slice layer returns empty for a missing session, so no
    // existence check is needed here beyond what the Store already does.
    const { homeDir } = await seedOpencode(NATIVE, [
      textPart('prt-u1', 'msg-u1', 'user', 'hello from disk', 100),
    ])
    try {
      const host = hostFor(homeDir)
      const page = await host.readHistory(
        {
          sessionId: PODIUM,
          agentKind: 'opencode' as const,
          cwd: '/tmp/opencode-history-probe',
          resume: { kind: 'opencode-session' as const, value: 'ses-not-yet-written' },
        },
        { limit: 50 },
      )
      expect(page).toEqual({ items: [], hasMore: false })
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('refuses a foreign history cursor instead of reading another session', async () => {
    const { homeDir } = await seedOpencode(NATIVE, [
      textPart('prt-u1', 'msg-u1', 'user', 'hello from disk', 100),
      textPart('prt-a1', 'msg-a1', 'assistant', 'reply from disk', 101),
    ])
    try {
      const host = hostFor(homeDir)
      const session = {
        sessionId: PODIUM,
        agentKind: 'opencode' as const,
        cwd: '/tmp/opencode-history-probe',
        resume: { kind: 'opencode-session' as const, value: NATIVE },
      }
      await expect(
        host.readHistory(session, {
          from: { segmentId: 'history:someone-else:ses-other', pathHint: 'x', components: {} },
          limit: 10,
        }),
      ).rejects.toSatisfy((err: unknown) => isDriverRefusal(err) && err.refusal.reason === 'invalid_value')
      // Same segment but no anchor is equally foreign: cursors are opaque.
      const own = await host.readHistory(session, { limit: 50 })
      expect(own.head).toBeDefined()
      await expect(
        host.readHistory(session, {
          from: { segmentId: own.head!.segmentId, components: {} },
          limit: 10,
        }),
      ).rejects.toSatisfy((err: unknown) => isDriverRefusal(err) && err.refusal.reason === 'invalid_value')
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})
