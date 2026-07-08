import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

// Lake-fallback transcript reads (docs/spec/search-v1.md §2.2): with the daemon
// gone, readTranscript serves the window from the server's mirrored copy; with a
// daemon answering normally, the daemon result wins and the lake is never parsed.

/** Real Claude Code JSONL — the lake holds native bytes verbatim, so the fixture
 *  must be the genuine record shape (message envelope, uuid, timestamp). */
const LAKE_LINES = [
  JSON.stringify({
    type: 'user',
    uuid: 'u-1',
    timestamp: '2026-07-01T10:00:00.000Z',
    message: { role: 'user', content: 'where does the flux capacitor live?' },
  }),
  JSON.stringify({
    type: 'assistant',
    uuid: 'a-1',
    timestamp: '2026-07-01T10:00:05.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'The flux capacitor lives in engine.ts' }],
      stop_reason: 'end_turn',
    },
  }),
  '', // Claude terminates every record with a newline — the lake copy has it too
].join('\n')

describe('SessionRegistry lake-fallback transcript reads', () => {
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn()
  })

  function setup() {
    const lakeDir = mkdtempSync(join(tmpdir(), 'podium-lake-read-'))
    const store = new SessionStore(':memory:')
    const registry = new SessionRegistry(store, undefined, { mirrorLakeDir: lakeDir })
    cleanups.push(() => {
      registry.dispose()
      rmSync(lakeDir, { recursive: true, force: true })
    })
    return { lakeDir, store, registry }
  }

  /** A claude session on machine `m1` with resume value `nativeId`, plus a lake
   *  file + segment row with mirrored_bytes > 0 — the mirrored-session fixture. */
  function seedMirroredSession(
    registry: SessionRegistry,
    store: SessionStore,
    lakeDir: string,
    nativeId: string,
    lakeContent: string,
  ): string {
    registry.modules.sessions.attachDaemon('m1', () => {})
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    registry.modules.sessions.onDaemonMessageFrom('m1', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: nativeId },
    })
    mkdirSync(join(lakeDir, 'm1'), { recursive: true })
    writeFileSync(join(lakeDir, 'm1', `${nativeId}.jsonl`), lakeContent)
    store.conversations.setMirrorCursor('m1', nativeId, Buffer.byteLength(lakeContent), '2026-07-01T11:00:00Z')
    return sessionId
  }

  it('serves the window from the lake when the machine is detached', async () => {
    const { lakeDir, store, registry } = setup()
    const sessionId = seedMirroredSession(registry, store, lakeDir, 'native-lake', LAKE_LINES)
    registry.modules.sessions.detachDaemon('m1')

    const res = await registry.modules.rpc.readTranscript({ sessionId, direction: 'before', limit: 10 })
    expect(res.items.map((i) => i.text)).toEqual([
      'where does the flux capacitor live?',
      'The flux capacitor lives in engine.ts',
    ])
    expect(res.items.map((i) => i.role)).toEqual(['user', 'assistant'])
  })

  it('serves the lake when the daemon answers empty (native file pruned)', async () => {
    const { lakeDir, store, registry } = setup()
    const sessionId = seedMirroredSession(registry, store, lakeDir, 'native-pruned', LAKE_LINES)
    // Re-attach a daemon that answers every transcriptRead with zero items — the
    // native file is gone from its disk.
    registry.modules.sessions.attachDaemon('m1', (m) => {
      if (m.type === 'transcriptRead') {
        registry.modules.sessions.onDaemonMessageFrom('m1', {
          type: 'transcriptReadResult',
          requestId: m.requestId,
          sessionId: m.sessionId,
          items: [],
          hasMore: false,
        })
      }
    })

    const res = await registry.modules.rpc.readTranscript({ sessionId, direction: 'before', limit: 10 })
    expect(res.items.map((i) => i.text)).toEqual([
      'where does the flux capacitor live?',
      'The flux capacitor lives in engine.ts',
    ])
  })

  it('prefers a normally-answering daemon: the lake is not consulted', async () => {
    const { lakeDir, store, registry } = setup()
    // Lake content DIFFERS from the daemon answer, so serving it would be visible.
    const lakeOnly = JSON.stringify({
      type: 'user',
      uuid: 'u-stale',
      timestamp: '2026-06-01T10:00:00.000Z',
      message: { role: 'user', content: 'STALE LAKE COPY — must not be served' },
    })
    const sessionId = seedMirroredSession(registry, store, lakeDir, 'native-live', lakeOnly)
    registry.modules.sessions.detachDaemon('m1')
    registry.modules.sessions.attachDaemon('m1', (m) => {
      if (m.type === 'transcriptRead') {
        registry.modules.sessions.onDaemonMessageFrom('m1', {
          type: 'transcriptReadResult',
          requestId: m.requestId,
          sessionId: m.sessionId,
          items: [{ id: 'live-1', role: 'user', text: 'fresh from the daemon' }],
          hasMore: false,
        })
      }
    })

    const res = await registry.modules.rpc.readTranscript({ sessionId, direction: 'before', limit: 10 })
    expect(res.items.map((i) => i.text)).toEqual(['fresh from the daemon'])
  })

  it('daemon attach backfills the FTS index for segments mirrored before this deploy', async () => {
    const { lakeDir, store, registry } = setup()
    // Pre-P5 state: lake file + mirrored_bytes > 0, indexed_bytes 0, and NO
    // onBytes hook will ever fire for it (the mirror is already caught up).
    seedMirroredSession(registry, store, lakeDir, 'native-old', LAKE_LINES)
    expect(store.conversations.transcriptIndexRows('m1', 'native-old')).toEqual([])

    // The attach trigger runs the backfill sweep (same seam as enqueueMachine).
    registry.modules.sessions.detachDaemon('m1')
    registry.modules.sessions.attachDaemon('m1', () => {})
    await vi.waitFor(() => {
      expect(store.conversations.transcriptIndexRows('m1', 'native-old').map((r) => r.content)).toEqual([
        'where does the flux capacitor live?',
        'The flux capacitor lives in engine.ts',
      ])
    })
    expect(store.conversations.segmentsToIndex('m1')).toEqual([])
  })

  it('resolves empty when detached and nothing was mirrored (cursor at 0)', async () => {
    const { registry } = setup()
    registry.modules.sessions.attachDaemon('m1', () => {})
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'claude-code', cwd: '/w' })
    registry.modules.sessions.onDaemonMessageFrom('m1', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'native-unmirrored' },
    })
    registry.modules.sessions.detachDaemon('m1')

    const res = await registry.modules.rpc.readTranscript({ sessionId, direction: 'before', limit: 10 })
    expect(res).toEqual({ items: [], hasMore: false })
  })
})
