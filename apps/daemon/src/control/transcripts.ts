import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { discoveryRoots, resolveWithinRoots, transcriptSourceFor } from '@podium/agent-bridge'
import type { AgentKind, ControlMessage } from '@podium/protocol'
import type { SliceResult, TranscriptSource } from '@podium/transcript'
import type { ControlHandlers, DaemonContext } from './context'

/**
 * Resolve a session's TRUE harness for the transcript-source layer, which routes
 * on `agentKind` alone. A session's real harness can hide behind its `resume.kind`
 * — e.g. a shell that the server later reclassifies, or a kind the server didn't
 * stamp precisely — so prefer the resume kind when it names a known harness; this
 * closes the mis-route gap where an opencode/grok/codex/cursor session arrived
 * with a generic `agentKind` and got read as the wrong source (empty chat). Falls
 * back to `agentKind` when the resume kind is absent or unrecognized.
 */
export function normalizeAgentKind(agentKind: AgentKind, resumeKind?: string): AgentKind {
  switch (resumeKind) {
    case 'opencode-session':
      return 'opencode'
    case 'grok-session':
      return 'grok'
    case 'codex-thread':
      return 'codex'
    case 'cursor-chat':
      return 'cursor'
    default:
      return agentKind
  }
}

// Build a TranscriptSource for the session named by a transcript-read request.
// The factory routes on the TRUE harness (normalizeAgentKind, since a session's
// real harness can hide behind resume.kind) and resolves the file chain / DB
// session from cwd + resume value. Centralizes the per-read source resolution so
// both the on-demand read and the reattach re-seed share one path.
export function sourceForRead(
  ctx: Pick<DaemonContext, 'homeDir'>,
  msg: {
    agentKind: AgentKind
    cwd: string
    resume?: { kind: string; value: string }
    pathHint?: string
  },
): Promise<TranscriptSource> {
  const agentKind = normalizeAgentKind(msg.agentKind, msg.resume?.kind)
  return transcriptSourceFor({
    agentKind,
    cwd: msg.cwd,
    ...(msg.resume?.value ? { resumeValue: msg.resume.value } : {}),
    ...(msg.pathHint ? { pathHint: msg.pathHint } : {}),
    ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}),
  })
}

// Unified cursor-anchored read (replaces the old parked-tail + scroll-back-page
// handlers): resolve the right TranscriptSource and serve a SliceResult for ANY
// harness, opencode included (the source layer hides the storage difference).
// No anchor + 'before' = newest window; an anchor + 'before' pages older; 'after'
// pages newer. Items carry cursors that interoperate with the live deltas.
async function readTranscript(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'transcriptRead' }>,
): Promise<void> {
  let res: SliceResult = { items: [], hasMore: false }
  try {
    const source = await sourceForRead(ctx, msg)
    res = await source.readSlice({
      ...(msg.anchor ? { anchor: msg.anchor } : {}),
      direction: msg.direction,
      limit: msg.limit,
    })
  } catch (err) {
    // A read failure (missing file/DB, decode error) must still answer the
    // server's pending request — reply with an empty page rather than hang it.
    console.warn(`[podium] transcript read failed for ${msg.sessionId}:`, err)
  }
  ctx.send({
    type: 'transcriptReadResult',
    requestId: msg.requestId,
    sessionId: msg.sessionId,
    items: res.items,
    ...(res.head ? { head: res.head } : {}),
    ...(res.tail ? { tail: res.tail } : {}),
    hasMore: res.hasMore,
  })
}

// Transcript-mirror ranged read (docs/spec/transcript-mirror.md §2.3): serve a byte
// range of a native transcript so the server can keep a verbatim lake copy. Guarded
// to discovery-provider roots via realpath prefix check — the mirror can never be
// used as an arbitrary file reader (spec invariant 3). Must-answer posture (like
// readTranscript): every requestId gets a reply, an error one rather than a hang.
async function readTranscriptMirror(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'transcriptMirrorRead' }>,
): Promise<void> {
  const reply = (r: { data: string; fileSize: number; eof: boolean; error?: string }): void =>
    ctx.send({ type: 'transcriptMirrorResult', requestId: msg.requestId, ...r })
  const refuse = (error: string): void => reply({ data: '', fileSize: 0, eof: false, error })
  try {
    const real = await resolveWithinRoots(msg.path, discoveryRoots(ctx.homeDir ?? homedir()))
    if (!real) {
      refuse('denied') // outside every discovery root, or vanished — never read
      return
    }
    const handle = await open(real, 'r')
    try {
      const fileSize = (await handle.stat()).size
      if (msg.offset >= fileSize) {
        reply({ data: '', fileSize, eof: true })
        return
      }
      const buf = Buffer.alloc(Math.min(msg.maxBytes, fileSize - msg.offset))
      const { bytesRead } = await handle.read(buf, 0, buf.length, msg.offset)
      reply({
        data: buf.subarray(0, bytesRead).toString('base64'),
        fileSize,
        eof: msg.offset + bytesRead >= fileSize,
      })
    } finally {
      await handle.close()
    }
  } catch (err) {
    refuse(String(err))
  }
}

export const transcriptHandlers: Pick<ControlHandlers, 'transcriptRead' | 'transcriptMirrorRead'> =
  {
    transcriptRead: (ctx, msg) => {
      void readTranscript(ctx, msg)
    },
    transcriptMirrorRead: (ctx, msg) => {
      void readTranscriptMirror(ctx, msg)
    },
  }
