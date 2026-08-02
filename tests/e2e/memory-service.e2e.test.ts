/**
 * POD-1390 — THE MEMORY SERVICE, ON THE REAL STACK.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * The Phase 4 exit criterion (POD-425) demands an end-to-end proof covering
 * session, issue AND memory. The isolated e2e lane attributed the first two and
 * said nothing at all about the third: nothing in tests/e2e named a transcript
 * lake, a transcript index, an omni-search hit, or the memory service's
 * behaviour at shutdown. This file is that missing attribution, and it is
 * deliberately split into FOUR separately-named tests — one per clause of the
 * criterion — so the gate can point at a test per clause instead of at one
 * green dot that covers everything and distinguishes nothing.
 *
 *   1. transcript persistence → 'persists the native transcript …'
 *   2. index                  → 'indexes conversational prose …'
 *   3. search                 → 'omni-search finds the indexed record …'
 *   4. clean shutdown         → 'shuts down quietly …'
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL HERE
 * ---------------------------------------------------------------------------
 *
 * A real daemon boots against an isolated HOME holding genuine Claude Code
 * JSONL. The real Claude Code discovery provider walks that HOME, the daemon's
 * own wire projection shapes the result, and the frame enters the server through
 * the gateway call the authenticated daemon socket itself makes. From there the
 * whole memory pipeline is the product: the server's MirrorService pulls the
 * transcript bytes back OVER THE REAL DAEMON SOCKET (the daemon's ranged-read
 * handler answers from the real file), its TranscriptIndexer turns those lake
 * bytes into FTS rows, and the search assertion is issued as an HTTP tRPC call
 * by a real client rather than by reaching into the service. NOTHING seeds the
 * lake, the index or the store directly — a fixture that wrote storage itself
 * would go inert the moment the product stopped reading that path, and would
 * prove the fixture rather than the pipeline (docs/agents/testing.md; the same
 * trap POD-425 called out).
 *
 * The ONE hop not taken over the socket is the discovery frame itself, and the
 * reason is recorded at `publishDiscovery` below: the daemon runs discovery in a
 * Bun Worker that cannot resolve workspace packages from a vitest fork. That is
 * a lane defect, filed separately, not a property of the memory service.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ASSERTIONS DISCRIMINATE
 * ---------------------------------------------------------------------------
 *
 * "Seed a record, find the record" proves a fixture. Every clause here is
 * written so that a passing run rules something OUT as well as in:
 *
 *  - Two conversations carry two DIFFERENT nonce tokens. Searching one must
 *    return that one and not the other, so a search that returns everything
 *    fails as loudly as a search that returns nothing.
 *  - SYSTEM_NONCE lives in a `type:'system'` record. Those bytes ARE in the
 *    lake (clause 1 compares the lake to the native file byte-for-byte), and
 *    the indexer must NOT index them (only user/assistant prose is searchable).
 *    So a search for it must come back empty — which is what separates "search
 *    reads the index" from "search greps the transcript".
 *  - ABSENT_NONCE occurs nowhere on disk at all: the plain no-hit control.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanAgentConversations } from '@podium/harness'
import type { SearchResultWire } from '@podium/protocol'
import { readOrCreateLocalMachineId } from '@podium/runtime/local-machine'
import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { diagnosticToWire, summaryToWire } from '../../apps/daemon/src/conversation-wire'
import { type DaemonOptions, startDaemon } from '../../apps/daemon/src/daemon'
import type { AppRouter } from '../../apps/server/src/router'
import { startServer } from '../../apps/server/src/server'
import { applyHarnessEnv, harnessEnv, reapHarnessSessions } from './harness-env'

/** THIS HOST's machine id (POD-318) — the same file the server and the daemon
 *  read. A FUNCTION, not a module-level constant: applyHarnessEnv() repoints
 *  PODIUM_STATE_DIR after the imports run, and a constant would have minted an
 *  id into the developer's REAL state dir before that happened. */
const hostMachineId = (): string => readOrCreateLocalMachineId()

// Isolation, before startServer()/startDaemon() read the env: an isolated state
// dir (its own podium.db AND its own transcript lake), an isolated abduco socket
// dir, and an isolated discovery HOME. Without it this file would mirror the
// developer's real transcripts into the real ~/.podium.
const ISOLATION_PORT = 9924
reapHarnessSessions(ISOLATION_PORT)
const DIRS = applyHarnessEnv(ISOLATION_PORT)
afterAll(() => reapHarnessSessions(ISOLATION_PORT))

/** Nonce tokens. Nothing else in a podium store contains these, so a hit is
 *  attributable to this fixture and only to it. */
const ALPHA_NONCE = 'zarquonite'
const BETA_NONCE = 'bellerophon'
/** Present in the transcript BYTES (a `type:'system'` record) but not indexable. */
const SYSTEM_NONCE = 'slartibartfast'
/** Present nowhere on disk. */
const ABSENT_NONCE = 'plutonium'

const ALPHA_ID = '11111111-1111-4111-8111-111111111111'
const BETA_ID = '22222222-2222-4222-8222-222222222222'
/** Seeded LATE, right before shutdown, so clause 4 closes with mirror + index
 *  work genuinely in flight rather than over a settled store. */
const LATE_ID = '33333333-3333-4333-8333-333333333333'

const PROJECT_SLUG = '-tmp-podium-memory-e2e'

/** Sessions here exist to make transcripts VISIBLE, not to run an agent — spawn
 *  the pty fixture rather than a real CLI, exactly as the other e2e files do. */
const fixtureLaunch: NonNullable<DaemonOptions['launch']> = () => ({
  cmd: process.execPath,
  args: [fileURLToPath(new URL('../../packages/pty/test/fixtures/fixture-tui.mjs', import.meta.url))],
  cwd: '/tmp',
})

/** Genuine Claude Code JSONL. The lake is byte-verbatim, so the fixture has to
 *  be the real record shape (summary/system/user/assistant envelopes, uuid,
 *  timestamp) rather than something that merely parses. Ends with a newline
 *  because the indexer consumes COMPLETE LINES only — a file with a partial
 *  trailing line legitimately leaves that line unindexed. */
function claudeTranscript(opts: {
  id: string
  title: string
  userText: string
  assistantText: string
  padding?: number
}): string {
  const lines = [
    JSON.stringify({ type: 'summary', customTitle: opts.title, sessionId: opts.id }),
    JSON.stringify({
      type: 'system',
      uuid: `${opts.id}-sys`,
      timestamp: '2026-07-01T09:59:00.000Z',
      content: `session bootstrap note ${SYSTEM_NONCE}`,
    }),
    JSON.stringify({
      type: 'user',
      uuid: `${opts.id}-u1`,
      timestamp: '2026-07-01T10:00:00.000Z',
      cwd: '/tmp/podium-memory-e2e',
      sessionId: opts.id,
      message: { role: 'user', content: opts.userText },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: `${opts.id}-a1`,
      timestamp: '2026-07-01T10:00:05.000Z',
      cwd: '/tmp/podium-memory-e2e',
      sessionId: opts.id,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: opts.assistantText }],
        stop_reason: 'end_turn',
      },
    }),
  ]
  // Optional bulk so the mirror needs several paced chunks (CHUNK_BYTES 256 KiB,
  // 25ms breather) — clause 4 uses it to guarantee in-flight work at close.
  for (let i = 0; i < (opts.padding ?? 0); i++) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        uuid: `${opts.id}-p${i}`,
        timestamp: '2026-07-01T10:01:00.000Z',
        sessionId: opts.id,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `padding record ${i} ${'x'.repeat(512)}` }],
          stop_reason: 'end_turn',
        },
      }),
    )
  }
  return `${lines.join('\n')}\n`
}

function writeConversation(id: string, body: string): string {
  const dir = join(DIRS.discoveryHomeDir, '.claude', 'projects', PROJECT_SLUG)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.jsonl`)
  writeFileSync(path, body)
  return path
}

async function until(pred: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await pred()) return
    if (Date.now() > deadline) throw new Error('until: timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('POD-1390 · memory service end-to-end (real daemon → server → client)', () => {
  const machineId = hostMachineId()
  const lakeDir = join(DIRS.stateDir, 'transcripts')
  let identityDir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let daemon: Awaited<ReturnType<typeof startDaemon>>
  let trpc: ReturnType<typeof createTRPCClient<AppRouter>>
  let alphaPath: string

  const store = () => server.registry.sessionStore
  const lakePath = (id: string) => join(lakeDir, machineId, `${id}.jsonl`)

  /**
   * Discovery, driven by the SHIPPED collaborators rather than by hand-written
   * rows: the real Claude Code provider walks the isolated HOME
   * (`scanAgentConversations`), the daemon's own projection turns each summary
   * into the wire shape it would put on the socket (`summaryToWire`), and the
   * frame enters the server through `gateway.routeDaemonFrame` — the exact call
   * the authenticated daemon socket makes on every `conversationsChanged`
   * (apps/server/src/server.ts). From there down, nothing is a fixture: the
   * server's MirrorService pulls the bytes back OVER THE REAL DAEMON SOCKET.
   *
   * Why the scan itself runs in-process instead of via `rpc.scan()`: the daemon
   * spawns its discovery scan in a Bun Worker, and a Worker started from a
   * vitest fork cannot resolve `@podium/harness` — the `@podium/source`
   * condition reaches neither NODE_OPTIONS nor `poolOptions.forks.execArgv`
   * (both probed), and no package `dist` exists in a cold checkout, so the
   * worker crash-loops. That is a lane defect in its own right, filed
   * separately; it is not a property of the memory service, and paying for it
   * with a package build inside this file would make this suite green only on a
   * tree that had been built by something else — the exact failure POD-1389
   * was refused for.
   */
  const publishDiscovery = async (): Promise<string[]> => {
    const scan = await scanAgentConversations({
      homeDir: DIRS.discoveryHomeDir,
      agents: ['claude-code'],
    })
    const conversations = scan.conversations.map(summaryToWire)
    server.registry.gateway.routeDaemonFrame(machineId, {
      type: 'conversationsChanged',
      conversations,
      removed: [],
      diagnostics: scan.diagnostics.map(diagnosticToWire),
    })
    return conversations.map((c) => c.id)
  }

  /** Bind a real podium session to a native conversation, exactly the way a live
   *  agent does it: the server mints the session, the daemon reports the resume
   *  ref it observed, and the frame arrives through the gateway. */
  const bindSession = (nativeId: string): string => {
    const { sessionId } = server.registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/tmp/podium-memory-e2e',
      machineId,
    })
    server.registry.gateway.routeDaemonFrame(machineId, {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: nativeId },
    })
    return sessionId
  }

  const searchAll = (text: string) => trpc.search.query.query({ text, limit: 100 })
  const searchTranscripts = async (text: string): Promise<SearchResultWire[]> =>
    (await searchAll(text)).filter((r) => r.kind === 'transcript')

  beforeAll(async () => {
    // Guard against a silently-mispointed harness before anything writes: every
    // path below must live under the isolated base, never the real ~/.podium.
    expect(DIRS.stateDir.startsWith(harnessEnv(ISOLATION_PORT).base)).toBe(true)
    expect(process.env.PODIUM_STATE_DIR).toBe(DIRS.stateDir)

    identityDir = mkdtempSync(join(tmpdir(), 'podium-memory-e2e-'))

    // Make the isolated HOME a coherent "Claude Code installed and logged in"
    // machine. The daemon probes THIS home for its harness inventory, and
    // createSession refuses to place a claude-code session on a machine whose
    // inventory says otherwise — so without it the session↔transcript binding
    // below could not be created through the real path at all. Placeholder
    // content in a temp dir; no credential material, real or imitation.
    mkdirSync(join(DIRS.discoveryHomeDir, '.claude'), { recursive: true })
    writeFileSync(
      join(DIRS.discoveryHomeDir, '.claude', '.credentials.json'),
      JSON.stringify({ podiumE2eFixture: true }),
    )
    writeFileSync(
      join(DIRS.discoveryHomeDir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'memory-e2e@podium.invalid' } }),
    )

    alphaPath = writeConversation(
      ALPHA_ID,
      claudeTranscript({
        id: ALPHA_ID,
        title: 'Engine notes',
        userText: `where is the ${ALPHA_NONCE} coupling mounted?`,
        assistantText: `The ${ALPHA_NONCE} coupling is mounted in engine.ts`,
      }),
    )
    writeConversation(
      BETA_ID,
      claudeTranscript({
        id: BETA_ID,
        title: 'Lens notes',
        userText: `how do I calibrate the ${BETA_NONCE} lens?`,
        assistantText: `Calibrate the ${BETA_NONCE} lens from lens.ts`,
      }),
    )

    server = await startServer({ port: 0 })
    trpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: `http://127.0.0.1:${server.port}/trpc` })],
    })
    daemon = await startDaemon({
      serverUrl: `ws://localhost:${server.port}`,
      bootstrapToken: server.bootstrapToken,
      machineId,
      identityDir,
      backend: 'none',
      // background:false keeps the 15s tick and the connect-time snapshot off —
      // this file drives discovery EXPLICITLY below so the proof is not racing a
      // timer it does not control.
      discovery: {
        background: false,
        cachePath: join(identityDir, 'discovery.db'),
        homeDir: DIRS.discoveryHomeDir,
      },
      metrics: { background: false },
      hooks: { port: 0, settingsDir: join(identityDir, 'hooks') },
      launch: fixtureLaunch,
      agentRelay: { port: 0 },
    })

    // The daemon probes its harness inventory asynchronously after attaching;
    // placing a claude-code session before that lands would be a race, so wait
    // for the machine to actually report the harness rather than sleeping.
    await until(() =>
      server.registry.modules.machines
        .listMachines()
        .some(
          (m) =>
            m.id === machineId &&
            m.online &&
            (m.inventory?.agents ?? []).some(
              (a) => a.kind === 'claude-code' && a.installed && a.login.state === 'in',
            ),
        ),
    )

    // A transcript is visible ONLY through a session the reader may read
    // (MemoryVisibilityPolicy: transcripts are 'personal', and the evidence that
    // ties one to a user is a session row bound to the same native conversation).
    // Binding real sessions here is therefore not scaffolding — it is the
    // session↔memory join the phase criterion asks for, and without it clause 3
    // could only ever prove "search returns nothing".
    bindSession(ALPHA_ID)
    bindSession(BETA_ID)

    const discovered = await publishDiscovery()
    expect(discovered.sort()).toEqual([ALPHA_ID, BETA_ID].sort())

    // Wait for the pipeline the scan kicked off: bytes mirrored, then indexed.
    await until(
      () =>
        store().conversations.transcriptIndex.indexedCursor(machineId, ALPHA_ID) > 0 &&
        store().conversations.transcriptIndex.indexedCursor(machineId, BETA_ID) > 0,
    )
  }, 60_000)

  afterAll(async () => {
    // Clause 4 owns the shutdown; these are no-ops if it already ran.
    await daemon?.close?.()
    await server?.close?.()
    rmSync(identityDir, { recursive: true, force: true })
  })

  // ---- clause 1: transcript persistence ----------------------------------
  it('persists the native transcript into the server transcript lake byte-verbatim', () => {
    const native = readFileSync(alphaPath)
    const mirrored = readFileSync(lakePath(ALPHA_ID))

    // Byte-verbatim, not "parses to the same thing": the lake is the server's
    // copy of the native file and later reads re-parse it as native JSONL.
    expect(mirrored.equals(native)).toBe(true)
    // The durable cursor agrees with what is on disk — a lake file with a stale
    // cursor is a lake that will never be indexed or re-read correctly.
    expect(store().conversations.mirror.mirrorCursor(machineId, ALPHA_ID)).toBe(native.byteLength)
    // The SYSTEM record's bytes are in the lake. Clause 2 requires them NOT to
    // be in the index; asserting their presence here is what makes that a real
    // distinction rather than an accident of a fixture that never had them.
    expect(mirrored.toString('utf8')).toContain(SYSTEM_NONCE)
  })

  // ---- clause 2: index ---------------------------------------------------
  it('indexes conversational prose from the mirrored bytes and skips non-prose records', () => {
    const rows = store().conversations.transcriptIndex.rows(machineId, ALPHA_ID)
    const contents = rows.map((r) => r.content)

    expect(contents.some((c) => c.includes(`where is the ${ALPHA_NONCE} coupling mounted?`))).toBe(
      true,
    )
    expect(
      contents.some((c) => c.includes(`The ${ALPHA_NONCE} coupling is mounted in engine.ts`)),
    ).toBe(true)
    // In the lake (asserted above), never in the index: system records are not
    // conversational prose.
    expect(contents.some((c) => c.includes(SYSTEM_NONCE))).toBe(false)
    // Every row carries the item uuid the transcript assigned, so a hit can be
    // resolved back to a position in the conversation rather than just a file.
    expect(rows.map((r) => r.itemUuid)).toContain(`${ALPHA_ID}-a1`)
    // The index consumed the whole mirrored file — a cursor short of the mirror
    // is an index that silently stops finding the newest messages.
    expect(store().conversations.transcriptIndex.indexedCursor(machineId, ALPHA_ID)).toBe(
      store().conversations.mirror.mirrorCursor(machineId, ALPHA_ID),
    )
  })

  // ---- clause 3: search --------------------------------------------------
  it('omni-search finds the indexed record over the wire and discriminates against the rest', async () => {
    const alpha = await searchTranscripts(ALPHA_NONCE)
    expect(alpha.length).toBeGreaterThan(0)
    // The RIGHT record, not merely a non-empty result set.
    expect(new Set(alpha.map((r) => r.nativeId))).toEqual(new Set([ALPHA_ID]))
    expect(alpha[0]?.machineId).toBe(machineId)
    expect(alpha.some((r) => r.snippet?.toLowerCase().includes(ALPHA_NONCE))).toBe(true)

    // The OTHER conversation answers its own token — a search that returned
    // everything would fail here, and one that returned nothing fails above.
    const beta = await searchTranscripts(BETA_NONCE)
    expect(new Set(beta.map((r) => r.nativeId))).toEqual(new Set([BETA_ID]))

    // In the transcript bytes, deliberately not in the index: this is what
    // proves search reads the INDEX rather than grepping the lake.
    expect(await searchTranscripts(SYSTEM_NONCE)).toEqual([])
    // Nowhere on disk at all: the plain no-hit control.
    expect(await searchTranscripts(ABSENT_NONCE)).toEqual([])
  })

  // ---- clause 4: clean shutdown ------------------------------------------
  // retry:0 deliberately (the lane's default is 1). This test CLOSES the shared
  // server; a retry would re-run it against a dead store and report "Cannot use a
  // closed database" instead of whatever actually failed.
  it('shuts down quietly with memory work in flight and restarts on the durable index', { retry: 0, timeout: 60_000 }, async () => {
    // Give the memory service genuine in-flight work to be interrupted: a fresh
    // multi-chunk conversation, discovered but deliberately NOT waited for. With
    // a settled store the "quiet" assertion below could not fail, and an
    // assertion that cannot fail carries no information.
    const latePath = writeConversation(
      LATE_ID,
      claudeTranscript({
        id: LATE_ID,
        title: 'Late arrival',
        userText: `late ${BETA_NONCE} question`,
        assistantText: `late ${BETA_NONCE} answer`,
        padding: 1200,
      }),
    )
    // Deterministic guarantee that work OUTLIVES the scan reply: the file is
    // wider than one mirror chunk (MirrorService.CHUNK_BYTES, 256 KiB) and each
    // chunk is followed by a 25ms breather, so the pull cannot have finished by
    // the time scan() resolves.
    expect(statSync(latePath).size).toBeGreaterThan(2 * 256 * 1024)
    expect(await publishDiscovery()).toContain(LATE_ID)

    // Daemon first, so nothing below is daemon reconnect noise.
    await daemon.close()

    const memory = server.registry.modules.memory

    const noise: string[] = []
    const warn = console.warn
    const error = console.error
    console.warn = (...args: unknown[]) => void noise.push(args.map(String).join(' '))
    console.error = (...args: unknown[]) => void noise.push(args.map(String).join(' '))
    try {
      await server.close()
      // The offending callbacks land AFTER close returns, so judging immediately
      // would judge nothing. Wait on a SIGNAL rather than a duration: the mirror
      // read the shutdown interrupted is a pending daemon request, and a clean
      // stop abandons it as it disposes. `pendingLakeReads` hits zero at once
      // on a correct tree; on a broken one it stays up for the full 10s read
      // timeout and the late warning lands inside this same wait, which is what
      // gives the assertion below the power to fail. (Measured on the unfixed
      // tree: '[podium] transcript mirror failed for …: Error: timeout', ~10s
      // after a "clean" close.)
      await until(() => memory.pendingLakeReads === 0, 15_000)
      // Plus a couple of paced turns (indexer/mirror breather is 25ms), so a
      // loop that merely hadn't reached its next checkpoint still gets to speak.
      await new Promise((r) => setTimeout(r, 250))
    } finally {
      console.warn = warn
      console.error = error
    }
    // "The process exited" is not clean shutdown. Nothing owned by the memory
    // service may still be writing once the store is closed.
    expect(noise).toEqual([])

    // Durability, checked the only honest way: a NEW server on the same state
    // dir, with NO daemon attached, still answers the search. Nothing here can
    // be served from the previous process's memory.
    const restarted = await startServer({ port: 0 })
    try {
      const client = createTRPCClient<AppRouter>({
        links: [httpBatchLink({ url: `http://127.0.0.1:${restarted.port}/trpc` })],
      })
      const hits = (await client.search.query.query({ text: ALPHA_NONCE, limit: 100 })).filter(
        (r) => r.kind === 'transcript',
      )
      expect(new Set(hits.map((r) => r.nativeId))).toEqual(new Set([ALPHA_ID]))
      // The byte cursors survived too, so the next boot resumes the index where
      // this one stopped instead of re-indexing (or losing) the lake.
      expect(
        restarted.registry.sessionStore.conversations.transcriptIndex.indexedCursor(
          machineId,
          ALPHA_ID,
        ),
      ).toBe(readFileSync(alphaPath).byteLength)
    } finally {
      await restarted.close()
    }
  })
})
