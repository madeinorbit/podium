/**
 * ORACLE — the last two hand-written sessions router mutations (POD-379 for
 * POD-382): `sessions.ask` and `sessions.uploadImage`.
 *
 * POD-382 deletes EVERY hand-written sessions mutation and audits that none
 * remain, so the oracle has to cover the whole router inventory, not only the
 * writes the frozen brief listed. These two are the remainder:
 *
 *  - `ask` — the seance [spec:SP-34d7 read-toolkit tier 4]. It is a MESSAGE, not
 *    a bespoke path: a `kind:'question'` row at next-turn + wake, then a BOUNDED
 *    wait for the ack. Its authz is the MessageGate's session-target gate, the
 *    same containment the relay send arm applies, which is why it is the one
 *    sessions mutation whose tRPC surface and relay surface share a code path.
 *  - `uploadImage` — a pure daemon round-trip: bytes in, an absolute path on the
 *    session's machine out. It carries no mutationId, is absent from the relay
 *    allowlist, and turns both daemon failure modes into TRPCErrors.
 */

import type { ControlMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  disposeOracles,
  MUST_NOT_CHANGE,
  makeOracle,
  messageOf,
  willChange,
} from './oracle-support'

afterEach(() => disposeOracles())

const GHOST = '00000000-0000-4000-8000-000000000000'
const AGENT_ONLY = willChange(
  'POD-1073',
  'agent-capability path only — there is no human-vs-human authz today',
)

/** Answer the daemon's image-upload round-trip with a scripted result. */
function answerUploads(
  o: ReturnType<typeof makeOracle>,
  reply: (msg: Extract<ControlMessage, { type: 'imageUploadRequest' }>) => {
    path: string
    error?: string
  },
): void {
  const existing = o.reg.modules.sessions
  o.reg.modules.sessions.attachDaemon('local', (msg) => {
    o.daemon.push(msg)
    if (msg.type === 'imageUploadRequest') {
      const r = reply(msg)
      existing.onDaemonMessageFrom('local', {
        type: 'imageUploadResult',
        requestId: msg.requestId,
        path: r.path,
        ...(r.error !== undefined ? { error: r.error } : {}),
      })
    }
  })
}

/** A live idle claude-code session the seance can address. */
function liveSession(o: ReturnType<typeof makeOracle>, sessionId: string): void {
  o.reg.modules.sessions.onDaemonMessageFrom('local', {
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/p',
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  o.reg.modules.sessions.onDaemonMessageFrom('local', {
    type: 'agentState',
    sessionId,
    state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
  })
}

describe('oracle: sessions.ask (the seance)', () => {
  it(`${MUST_NOT_CHANGE}: an unanswered ask returns the bounded-wait shape — answered:false, the question id, and a live status snapshot`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    liveSession(o, sessionId)

    const result = (await o.call.sessions.ask({
      sessionId,
      question: 'which way?',
      // Bounded to zero so the characterization is the SHAPE, not the timeout.
      timeoutSeconds: 0,
    })) as Record<string, unknown>

    expect(result).toMatchObject({
      answered: false,
      reason: 'no answer yet — the question is delivered/queued; check back or await the ack',
      snapshot: { sessionId, status: 'live', phase: 'idle' },
    })
    expect(typeof result.questionId).toBe('string')
  })

  it(`${MUST_NOT_CHANGE}: ask is a MESSAGE — it lands in the ledger as a question addressed to the target`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    liveSession(o, sessionId)

    const result = (await o.call.sessions.ask({
      sessionId,
      question: 'which way?',
      timeoutSeconds: 0,
    })) as { questionId: string }

    const row = o.store.messages.getMessage(result.questionId)
    expect(row).toMatchObject({
      kind: 'question',
      toKind: 'session',
      toId: sessionId,
      body: 'which way?',
      urgency: 'next-turn',
      lifecycle: 'wake',
    })
  })

  it(`${MUST_NOT_CHANGE}: ask against an unknown session THROWS 'session not found' — the gate resolves the target before sending`, async () => {
    const o = makeOracle()

    expect(
      await messageOf(() => o.call.sessions.ask({ sessionId: GHOST, question: 'anyone?' })),
    ).toBe('session not found')
  })

  it(`${MUST_NOT_CHANGE}: ask carries NO mutationId — a repeated ask asks again, and nothing is recorded to dedupe against`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    liveSession(o, sessionId)

    const first = (await o.call.sessions.ask({
      sessionId,
      question: 'twice?',
      timeoutSeconds: 0,
    })) as { questionId: string }
    const second = (await o.call.sessions.ask({
      sessionId,
      question: 'twice?',
      timeoutSeconds: 0,
    })) as { questionId: string }

    // Two distinct question rows: the seance is NOT replay-protected, and it is
    // not outbox-covered either (live conversation must fail fast, never queue).
    expect(second.questionId).not.toBe(first.questionId)
    expect(o.store.messages.getMessage(first.questionId)).toBeDefined()
    expect(o.store.messages.getMessage(second.questionId)).toBeDefined()
  })

  it(`${AGENT_ONLY}: ask is NOT relay-reachable — the allowlist refuses it BEFORE the dispatch arm that implements it`, async () => {
    const o = makeOracle()
    const a = o.reg.issues.create({ repoPath: '/r', title: 'issue A', startNow: false })
    o.reg.issues.update(a.id, { worktreePath: '/r/.worktrees/a' })
    const agent = o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
    })
    const peer = o.reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/r/.worktrees/a',
      issueId: a.id,
    })

    const reply = await o.relay({
      requestId: 'ask-via-relay',
      sessionId: agent.sessionId,
      router: 'sessions',
      proc: 'ask',
      input: { sessionId: peer.sessionId, question: 'status?', timeoutSeconds: 0 },
    })

    // NOTE FOR THE MIGRATION, and the reason this is pinned rather than assumed:
    // relay.ts's sessions arm has an explicit `if (proc === 'ask')` branch routing
    // to the MessageGate, but RELAY_ALLOWED.sessions does not list 'ask' (nor
    // 'recap'), and the allowlist runs first — so that branch is UNREACHABLE
    // today. A command-plane cutover that merges the two lists would silently
    // GRANT agents the seance. That is a policy change, not a refactor.
    expect(reply.ok).toBe(false)
    expect(reply.error).toBe('sessions.ask is not permitted via relay')
    // No question row was created for the refused call.
    expect(o.store.messages.listLedger({ sessionId: peer.sessionId })).toEqual([])
  })
})

describe('oracle: sessions.uploadImage', () => {
  it(`${MUST_NOT_CHANGE}: a successful upload returns the daemon's absolute path, and the request carries the bytes to the SESSION's machine`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    answerUploads(o, (msg) => ({ path: `/home/agent/.podium/uploads/${msg.sessionId}/x.png` }))

    const result = await o.call.sessions.uploadImage({
      sessionId,
      filename: 'shot.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('bytes').toString('base64'),
    })

    expect(result).toEqual({ path: `/home/agent/.podium/uploads/${sessionId}/x.png` })
    expect(o.daemon).toContainEqual(
      expect.objectContaining({
        type: 'imageUploadRequest',
        sessionId,
        filename: 'shot.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('bytes').toString('base64'),
      }),
    )
  })

  it(`${MUST_NOT_CHANGE}: a daemon-reported failure surfaces as INTERNAL_SERVER_ERROR carrying the daemon's own message`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    answerUploads(o, () => ({ path: '', error: 'disk full' }))

    expect(
      await messageOf(() =>
        o.call.sessions.uploadImage({
          sessionId,
          filename: 'shot.png',
          mimeType: 'image/png',
          dataBase64: 'AA==',
        }),
      ),
    ).toBe('disk full')
  })

  it(`${MUST_NOT_CHANGE}: an answer with no path is treated as NOBODY ANSWERING — a TIMEOUT, not a silent success`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    // The same empty-path value the RPC layer synthesizes when the 30s round-trip
    // expires, driven here directly so the shape is pinned without the wait.
    answerUploads(o, () => ({ path: '' }))

    expect(
      await messageOf(() =>
        o.call.sessions.uploadImage({
          sessionId,
          filename: 'shot.png',
          mimeType: 'image/png',
          dataBase64: 'AA==',
        }),
      ),
    ).toBe('no daemon answered the image upload request')
  })

  it(`${willChange('POD-1079', "machines become owned compute; an upload writes to someone else's disk")}: an upload for an unknown session is still dispatched — placement is resolved with no ownership check`, async () => {
    const o = makeOracle()
    answerUploads(o, () => ({ path: '/home/agent/.podium/uploads/ghost/x.png' }))

    // No existence gate: the write is routed to the default machine and lands.
    expect(
      await o.call.sessions.uploadImage({
        sessionId: GHOST,
        filename: 'shot.png',
        mimeType: 'image/png',
        dataBase64: 'AA==',
      }),
    ).toEqual({ path: '/home/agent/.podium/uploads/ghost/x.png' })
    expect(o.daemon).toContainEqual(
      expect.objectContaining({ type: 'imageUploadRequest', sessionId: GHOST }),
    )
  })

  it(`${AGENT_ONLY}: uploadImage is NOT relay-reachable — an agent writes files with its own tools, never through the server`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    const reply = await o.relay({
      requestId: 'upload-denied',
      sessionId,
      router: 'sessions',
      proc: 'uploadImage',
      input: { sessionId, filename: 'x.png', mimeType: 'image/png', dataBase64: 'AA==' },
    })

    expect(reply.ok).toBe(false)
    expect(reply.error).toBe('sessions.uploadImage is not permitted via relay')
  })

  it(`${MUST_NOT_CHANGE}: uploadImage carries no mutationId — two uploads are two daemon round-trips, never deduped`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
    let served = 0
    answerUploads(o, () => {
      served += 1
      return { path: `/uploads/${served}.png` }
    })

    const first = await o.call.sessions.uploadImage({
      sessionId,
      filename: 'shot.png',
      mimeType: 'image/png',
      dataBase64: 'AA==',
    })
    const second = await o.call.sessions.uploadImage({
      sessionId,
      filename: 'shot.png',
      mimeType: 'image/png',
      dataBase64: 'AA==',
    })

    expect([first.path, second.path]).toEqual(['/uploads/1.png', '/uploads/2.png'])
    expect(o.daemon.filter((m) => m.type === 'imageUploadRequest')).toHaveLength(2)
  })
})
