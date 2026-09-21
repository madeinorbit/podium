/**
 * ENGINE SUPERVISION WIRING (1.5).
 *
 * What stayed daemon-side when the engine hosts moved into the driver
 * families: the instance socket root, the file binding journals, and the
 * bind-fact gate. Harness-shaped values (argv stems, scope tokens) arrive
 * from the families' own facts; this file pins the supervisor's layout.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, type SessionId } from '@podium/model'
import { unixSocketPathBytes, unixSocketPathFits } from '@podium/runtime/abduco-socket'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  codexClientSocketPath,
  codexScopeLabel,
  codexEngineFacts,
  opencodeScopeLabel,
  opencodeFlavor,
} from '@podium/harness/driver/host'
import { runtimeDriverIdFor, sessionIsBehindContract } from './handlers'
import { createEngineJournal, engineSocketRoot } from './host'

const SESSION = asSessionId('11111111-1111-4111-8111-111111111111')
const OC_FLAVOR = opencodeFlavor()
const CX_FACTS = codexEngineFacts()

const LEGACY_SOCKET_ROOT = '/home/mgw/.local/state/podium'
const CODEX_SOCKET_DIR = 'runtime/codex-app-server-sockets'
const CODEX_SOCKET_BASENAME = 'abcdefabcdef-123456789012.sock'

const legacyCodexSocketPath = (instanceId: string): string =>
  `${LEGACY_SOCKET_ROOT}/${instanceId}/${CODEX_SOCKET_DIR}/${CODEX_SOCKET_BASENAME}`

const savedInstanceEnv = {
  HOME: process.env.HOME,
  PODIUM_INSTANCE: process.env.PODIUM_INSTANCE,
  PODIUM_STATE_DIR: process.env.PODIUM_STATE_DIR,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
}

beforeEach(() => {
  process.env.HOME = '/home/mgw'
  process.env.XDG_RUNTIME_DIR = '/run/user/1001'
  delete process.env.PODIUM_STATE_DIR
  delete process.env.XDG_STATE_HOME
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedInstanceEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('the engine socket root and the Codex path budget', () => {
  it('resolves the instance-private socket root from the environment', () => {
    process.env.PODIUM_INSTANCE = 'sock-root-check'
    const root = engineSocketRoot()
    expect(root).toContain('sock-root-check')
  })

  it('keeps the measured old boundary and fits both edge instance ids', () => {
    const lastAccepted = 'i'.repeat(13)
    const firstRefused = 'i'.repeat(14)

    // These are the measured legacy compositions this regression closes: the
    // last accepted path is 107 bytes, while the first refused path reaches
    // the 108-byte sockaddr_un ceiling.
    expect(unixSocketPathBytes(legacyCodexSocketPath(lastAccepted))).toBe(107)
    expect(unixSocketPathBytes(legacyCodexSocketPath(firstRefused))).toBe(108)
    expect(unixSocketPathFits(legacyCodexSocketPath(lastAccepted))).toBe(true)
    expect(unixSocketPathFits(legacyCodexSocketPath(firstRefused))).toBe(false)

    process.env.PODIUM_INSTANCE = lastAccepted
    const lastRoot = engineSocketRoot()
    const lastPath = codexClientSocketPath(
      lastRoot,
      asSessionId('019edef7-3e34-7513-92b9-35f3a0dac891'),
      'abcdefabcdef-123456789012',
    )
    const maximumId = 'i'.repeat(32)
    process.env.PODIUM_INSTANCE = maximumId
    const maximumRoot = engineSocketRoot()
    const maximumPath = codexClientSocketPath(
      maximumRoot,
      asSessionId('019edef7-3e34-7513-92b9-35f3a0dac891'),
      'abcdefabcdef-123456789012',
    )
    process.env.PODIUM_INSTANCE = firstRefused
    const firstRoot = engineSocketRoot()
    const firstPath = codexClientSocketPath(
      firstRoot,
      asSessionId('019edef7-3e34-7513-92b9-35f3a0dac891'),
      'abcdefabcdef-123456789012',
    )

    expect(lastPath).toContain(`/run/user/1001/podium-${lastAccepted}/`)
    expect(firstPath).toContain(`/run/user/1001/podium-${firstRefused}/`)
    expect(maximumPath).toContain(`/run/user/1001/podium-${maximumId}/`)
    expect(unixSocketPathBytes(lastPath)).toBe(66)
    expect(unixSocketPathBytes(firstPath)).toBe(67)
    expect(unixSocketPathBytes(maximumPath)).toBe(85)
    expect(unixSocketPathFits(lastPath)).toBe(true)
    expect(unixSocketPathFits(firstPath)).toBe(true)
    expect(unixSocketPathFits(maximumPath)).toBe(true)
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
    process: { key: opencodeScopeLabel(OC_FLAVOR, SESSION), pid: 4242, scopeUnit: 'x.scope' },
    seq: 7,
    turnEpoch: 3,
    bindingVersion: 1,
  }
  const freshJournal = () => createEngineJournal<typeof entry>({ namespace: 'opencode-servers' })

  it('round-trips what `adopt()` needs after a daemon restart', () => {
    freshJournal().write(entry)
    // A FRESH journal — no cache — because that is the state a restarted daemon
    // is actually in. Reading through the write-through cache would test
    // nothing about survival.
    const read = freshJournal().read(SESSION)
    expect(read).toEqual(entry)
  })

  it('writes the file 0600, because it holds the secret', () => {
    freshJournal().write(entry)
    const path = join(dir, 'opencode-servers', `${encodeURIComponent(SESSION)}.json`)
    // The secret has to survive to make `adopt()` possible at all, so the file's
    // mode is part of the mechanism rather than hygiene.
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8')).secret).toBe('the-per-session-secret')
  })

  it('clears on kill, so a dead session leaves no adoptable entry', () => {
    const journal = freshJournal()
    journal.write(entry)
    journal.clear(SESSION)
    expect(journal.read(SESSION)).toBeUndefined()
    expect(freshJournal().read(SESSION)).toBeUndefined()
  })

  it('answers undefined for a session it never saw, rather than throwing', () => {
    expect(
      freshJournal().read(asSessionId('22222222-2222-4222-8222-222222222222')),
    ).toBeUndefined()
  })
})

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

  const journalled = {
    sessionId: SESSION,
    opencodeSessionId: 'ses_survivor',
    baseUrl: 'http://127.0.0.1:41999',
    username: 'podium',
    secret: 'kept-so-adopt-can-authenticate',
    workdir: '/tmp/work',
    process: { key: opencodeScopeLabel(OC_FLAVOR, SESSION), pid: 5150, scopeUnit: 'x.scope' },
    seq: 12,
    turnEpoch: 4,
    bindingVersion: 2,
  }

describe('the reattach journal read', () => {
  let adoptDir: string
  let adoptPrevious: string | undefined
  beforeEach(() => {
    adoptDir = mkdtempSync(join(tmpdir(), 'podium-oc-adopt-'))
    adoptPrevious = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = adoptDir
  })
  afterEach(() => {
    if (adoptPrevious === undefined) delete process.env.PODIUM_STATE_DIR
    else process.env.PODIUM_STATE_DIR = adoptPrevious
  })

  it('THE JOURNAL ENTRY IS THE ANSWER to "was this session server-driven?"', () => {
    // The discriminator the reattach branch reads. It exists only because the
    // server driver's own launch wrote it, so its presence is a fact rather than
    // an inference — which is why the branch can be taken before anything else
    // in `handleReattach` runs.
    const journal = createEngineJournal<typeof journalled>({ namespace: 'opencode-servers' })
    expect(journal.read(SESSION)).toBeUndefined()
    journal.write(journalled)
    expect(
      createEngineJournal<typeof journalled>({ namespace: 'opencode-servers' }).read(SESSION)
        ?.opencodeSessionId,
    ).toBe('ses_survivor')
  })

  it('carries everything adopt needs to be EXACT rather than hopeful', () => {
    createEngineJournal<typeof journalled>({ namespace: 'opencode-servers' }).write(journalled)
    const entry = createEngineJournal<typeof journalled>({ namespace: 'opencode-servers' }).read(
      SESSION,
    )
    // The process key is what `adopt()` matches on — a prefix or a port would
    // rebind whatever inherited the socket.
    expect(entry?.process.key).toBe(opencodeScopeLabel(OC_FLAVOR, SESSION))
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
    expect(
      createEngineJournal<typeof journalled>({ namespace: 'opencode-servers' }).read(SESSION),
    ).toBeUndefined()
  })
})
