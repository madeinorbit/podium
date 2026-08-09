import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'

// Lake-fallback transcript reads (docs/spec/search-v1.md §2.2): with the daemon
// gone, readTranscript serves the window from the server's mirrored copy; with a
// daemon answering normally, the daemon result wins unless only the lake can
// provide a preserved predecessor chain.

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
    const registry = new SessionRegistry(store, undefined, {
      instanceId: 'default',
      mirrorLakeDir: lakeDir,
    })
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
    registry.gateway.attachDaemon('m1', () => {})
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    registry.gateway.routeDaemonFrame('m1', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: nativeId },
    })
    mkdirSync(join(lakeDir, 'm1'), { recursive: true })
    writeFileSync(join(lakeDir, 'm1', `${nativeId}.jsonl`), lakeContent)
    store.conversations.mirror.setMirrorCursor(
      'm1',
      nativeId,
      Buffer.byteLength(lakeContent),
      '2026-07-01T11:00:00Z',
    )
    return sessionId
  }

  it('serves the window from the lake when the machine is detached', async () => {
    const { lakeDir, store, registry } = setup()
    const sessionId = seedMirroredSession(registry, store, lakeDir, 'native-lake', LAKE_LINES)
    registry.gateway.detachDaemon('m1')

    const res = await registry.modules.rpc.readTranscript(
      { sessionId: asSessionId(sessionId), direction: 'before', limit: 10 },
      { kind: 'user', id: FIRST_ADMIN_USER_ID },
    )
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
    registry.gateway.attachDaemon('m1', (m) => {
      if (m.type === 'transcriptRead') {
        registry.gateway.routeDaemonFrame('m1', {
          type: 'transcriptReadResult',
          requestId: m.requestId,
          sessionId: m.sessionId,
          items: [],
          hasMore: false,
        })
      }
    })

    const res = await registry.modules.rpc.readTranscript(
      { sessionId: asSessionId(sessionId), direction: 'before', limit: 10 },
      { kind: 'user', id: FIRST_ADMIN_USER_ID },
    )
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
    registry.gateway.detachDaemon('m1')
    registry.gateway.attachDaemon('m1', (m) => {
      if (m.type === 'transcriptRead') {
        registry.gateway.routeDaemonFrame('m1', {
          type: 'transcriptReadResult',
          requestId: m.requestId,
          sessionId: m.sessionId,
          items: [{ id: 'live-1', role: 'user', text: 'fresh from the daemon' }],
          hasMore: false,
        })
      }
    })

    const res = await registry.modules.rpc.readTranscript(
      { sessionId: asSessionId(sessionId), direction: 'before', limit: 10 },
      { kind: 'user', id: FIRST_ADMIN_USER_ID },
    )
    expect(res.items.map((i) => i.text)).toEqual(['fresh from the daemon'])
  })

  it('reads retired and current file incarnations as one transcript chain', async () => {
    const { lakeDir, store, registry } = setup()
    const nativeId = 'native-reused'
    const predecessor = `${JSON.stringify({
      type: 'user',
      uuid: 'u-predecessor',
      timestamp: '2026-07-01T09:00:00.000Z',
      message: { role: 'user', content: 'history from the original inode' },
    })}\n`
    const current = `${JSON.stringify({
      type: 'assistant',
      uuid: 'a-current',
      timestamp: '2026-07-01T10:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'reply from replacement inode' }],
      },
    })}\n`
    const sessionId = seedMirroredSession(registry, store, lakeDir, nativeId, current)
    store.conversations.mirror.startIncarnation(
      'm1',
      nativeId,
      { device: '7', inode: '8961297' },
      '2026-07-01T09:00:00Z',
    )
    store.conversations.mirror.rotateIncarnation(
      'm1',
      nativeId,
      { device: '7', inode: '7115245' },
      Buffer.byteLength(predecessor),
      '2026-07-01T10:00:00Z',
    )
    writeFileSync(join(lakeDir, 'm1', `${nativeId}.incarnation-1.jsonl`), predecessor)
    store.conversations.mirror.setMirrorCursor(
      'm1',
      nativeId,
      Buffer.byteLength(current),
      '2026-07-01T10:00:01Z',
    )
    registry.gateway.detachDaemon('m1')
    // Even with an online daemon returning the replacement file, the lake owns
    // this read because it is the only source that can page across predecessors.
    registry.gateway.attachDaemon('m1', (message) => {
      if (message.type !== 'transcriptRead') return
      registry.gateway.routeDaemonFrame('m1', {
        type: 'transcriptReadResult',
        requestId: message.requestId,
        sessionId: message.sessionId,
        items: [
          { id: 'daemon-current', role: 'assistant', text: 'daemon only saw the replacement' },
        ],
        hasMore: false,
      })
    })

    const res = await registry.modules.rpc.readTranscript(
      { sessionId: asSessionId(sessionId), direction: 'before', limit: 10 },
      { kind: 'user', id: FIRST_ADMIN_USER_ID },
    )
    expect(res.items.map((item) => item.text)).toEqual([
      'history from the original inode',
      'reply from replacement inode',
    ])
  })

  it('carries daemon file identity through the server mirror boundary', async () => {
    const { lakeDir, store, registry } = setup()
    const nativeId = 'native-boundary'
    const sourcePath = '/home/u/.claude/projects/-proj/native-boundary.jsonl'
    let source = Buffer.from(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'predecessor transcript with enough history' },
      })}\n`,
    )
    let inode = '8961297'
    store.conversations.registry.ensure({
      machineId: 'm1',
      nativeId,
      providerId: 'claude-code-jsonl',
      path: sourcePath,
      sizeBytes: source.length,
    })
    registry.gateway.attachDaemon('m1', (message) => {
      if (message.type !== 'transcriptMirrorRead') return
      const bytes = source.subarray(message.offset, message.offset + message.maxBytes)
      registry.gateway.routeDaemonFrame('m1', {
        type: 'transcriptMirrorResult',
        requestId: message.requestId,
        data: bytes.toString('base64'),
        fileSize: source.length,
        eof: message.offset + bytes.length >= source.length,
        device: '7',
        inode,
      })
    })
    registry.modules.memory.triggerLakeSweep('m1')
    await vi.waitFor(() => {
      expect(store.conversations.mirror.mirrorCursor('m1', nativeId)).toBe(source.length)
      expect(store.conversations.mirror.activeIncarnation('m1', nativeId)?.inode).toBe('8961297')
    })

    const predecessor = source
    source = Buffer.from(
      `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'next' } })}\n`,
    )
    inode = '7115245'
    store.conversations.mirror.setReportedBytes('m1', nativeId, source.length)
    registry.modules.memory.triggerLakeSweep('m1')

    await vi.waitFor(() => {
      // The first sweep may still be dropping its single-flight queue marker
      // when the replacement is installed; retriggering is how the next daemon
      // scan reports the dirty smaller file in production.
      registry.modules.memory.triggerLakeSweep('m1')
      expect(store.conversations.mirror.mirrorCursor('m1', nativeId)).toBe(source.length)
      expect(store.conversations.mirror.incarnations('m1', nativeId)).toHaveLength(2)
    })
    expect(
      readFileSync(join(lakeDir, 'm1', `${nativeId}.incarnation-1.jsonl`)).equals(predecessor),
    ).toBe(true)
    expect(readFileSync(join(lakeDir, 'm1', `${nativeId}.jsonl`)).equals(source)).toBe(true)
  })

  it('daemon attach backfills the FTS index for segments mirrored before this deploy', async () => {
    const { lakeDir, store, registry } = setup()
    // Pre-P5 state: lake file + mirrored_bytes > 0, indexed_bytes 0, and NO
    // onBytes hook will ever fire for it (the mirror is already caught up).
    seedMirroredSession(registry, store, lakeDir, 'native-old', LAKE_LINES)
    expect(store.conversations.transcriptIndex.rows('m1', 'native-old')).toEqual([])

    // The attach trigger runs the backfill sweep (same seam as enqueueMachine).
    registry.gateway.detachDaemon('m1')
    registry.gateway.attachDaemon('m1', () => {})
    await vi.waitFor(() => {
      expect(
        store.conversations.transcriptIndex.rows('m1', 'native-old').map((r) => r.content),
      ).toEqual(['where does the flux capacitor live?', 'The flux capacitor lives in engine.ts'])
    })
    expect(store.conversations.transcriptIndex.segmentsToIndex('m1')).toEqual([])
  })

  it('resolves empty when detached and nothing was mirrored (cursor at 0)', async () => {
    const { registry } = setup()
    registry.gateway.attachDaemon('m1', () => {})
    const { sessionId } = registry.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/w',
    })
    registry.gateway.routeDaemonFrame('m1', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'claude-session', value: 'native-unmirrored' },
    })
    registry.gateway.detachDaemon('m1')

    const res = await registry.modules.rpc.readTranscript(
      { sessionId, direction: 'before', limit: 10 },
      { kind: 'user', id: FIRST_ADMIN_USER_ID },
    )
    expect(res).toEqual({ items: [], hasMore: false })
  })

  it('fails closed before daemon or lake access for another user', async () => {
    const { registry } = setup()
    const sent: unknown[] = []
    registry.gateway.attachDaemon('m1', (message) => sent.push(message))
    const { sessionId } = registry.modules.sessions.createSession({
      ownerUserId: asUserId('usr_transcript_owner'),
      agentKind: 'claude-code',
      cwd: '/private',
    })
    const result = await registry.modules.rpc.readTranscript(
      { sessionId, direction: 'before', limit: 10 },
      { kind: 'user', id: FIRST_ADMIN_USER_ID },
    )
    expect(result).toEqual({ items: [], hasMore: false })
    expect(sent.some((message) => (message as { type?: string }).type === 'transcriptRead')).toBe(
      false,
    )
  })
})
