import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scan } from './discovery'
import { readTranscript, readTranscriptMirror, type TranscriptArchiveContext } from './transcripts'

describe('retained native archive boundary', () => {
  let homeDir: string
  let path: string
  let bytes: string
  let replies: DaemonMessage[]
  let ctx: TranscriptArchiveContext

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'archive-owner-'))
    path = join(homeDir, '.claude', 'projects', '-old-workspace', 'external.jsonl')
    await mkdir(join(path, '..'), { recursive: true })
    bytes = `${JSON.stringify({ type: 'user', uuid: 'external-message', sessionId: 'external',
      message: { role: 'user', content: 'history without a process' } })}\n`
    await writeFile(path, bytes)
    replies = []
    // No runtime, bridge map, process, or daemon connection in this service context.
    ctx = { homeDir, send: (message) => { replies.push(message) } }
  })
  afterEach(async () => { await rm(homeDir, { recursive: true, force: true }) })

  it.each(['recorded', 'stale', 'absent'])('reads a moved workspace with %s path evidence', async (hint) => {
    await readTranscript(ctx, {
      type: 'transcriptRead', requestId: 'read', sessionId: asSessionId('parked'),
      agentKind: 'claude-code', cwd: '/moved/workspace',
      resume: { kind: 'claude-session', value: 'external' },
      ...(hint === 'absent' ? {} : { pathHint: hint === 'recorded' ? path : join(homeDir, 'gone.jsonl') }),
      direction: 'before', limit: 10,
    })
    expect(replies).toEqual([expect.objectContaining({ type: 'transcriptReadResult',
      items: [expect.objectContaining({ text: 'history without a process' })], hasMore: false })])
  })

  it('mirrors byte ranges with the native inode, including EOF identity', async () => {
    const identity = await stat(path, { bigint: true })
    for (const offset of [0, 7, Buffer.byteLength(bytes)]) {
      await readTranscriptMirror(ctx, { type: 'transcriptMirrorRead', requestId: 'mirror',
        path, offset, maxBytes: 7 })
      expect(replies.at(-1)).toEqual({ type: 'transcriptMirrorResult', requestId: 'mirror',
        data: Buffer.from(bytes).subarray(offset, offset + 7).toString('base64'),
        fileSize: Buffer.byteLength(bytes), eof: offset + 7 >= Buffer.byteLength(bytes),
        device: identity.dev.toString(), inode: identity.ino.toString() })
    }
  })

  it('refuses files outside discovery roots, including symlink escapes', async () => {
    const privatePath = join(homeDir, 'private.txt')
    await writeFile(privatePath, 'private bytes')
    const link = join(path, '..', 'escape.jsonl')
    await symlink(privatePath, link)
    for (const denied of [privatePath, link]) {
      await readTranscriptMirror(ctx, { type: 'transcriptMirrorRead', requestId: 'denied',
        path: denied, offset: 0, maxBytes: 100 })
      expect(replies.at(-1)).toEqual({ type: 'transcriptMirrorResult', requestId: 'denied',
        data: '', fileSize: 0, eof: false, error: 'denied' })
    }
  })

  it('requests a full discovery snapshot without any live-agent service', async () => {
    const delta = { changed: [], removed: [], diagnostics: [] }
    const refreshAndPublishConversations = vi.fn(async () => delta)
    await scan({ send: ctx.send, refreshAndPublishConversations }, 'scan')
    expect(refreshAndPublishConversations).toHaveBeenCalledWith(true)
    expect(replies).toEqual([{ type: 'scanResult', requestId: 'scan',
      conversations: [], removed: [], diagnostics: [] }])
  })
})
