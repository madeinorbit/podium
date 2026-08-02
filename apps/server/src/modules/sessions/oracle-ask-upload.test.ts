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

import { asSessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  disposeOracles,
  MUST_NOT_CHANGE,
  makeOracle,
  messageOf,
  waitFor,
  willChange,
} from './oracle-support'

afterEach(() => disposeOracles())

const GHOST = '00000000-0000-4000-8000-000000000000'
const AGENT_ONLY = willChange(
  'POD-1073',
  'agent-capability path only — there is no human-vs-human authz today',
)

/** Answer the daemon's image-upload round-trip with a scripted result. Returns
 *  the requests THAT machine received, so routing can be asserted per machine. */
function answerUploads(
  o: ReturnType<typeof makeOracle>,
  reply: (msg: Extract<ControlMessage, { type: 'imageUploadRequest' }>) => {
    path: string
    error?: string
  },
  machineId = 'local',
): ControlMessage[] {
  const seen: ControlMessage[] = []
  const svc = o.reg.gateway
  svc.attachDaemon(machineId, (msg) => {
    seen.push(msg)
    if (machineId === 'local') o.daemon.push(msg)
    if (msg.type === 'imageUploadRequest') {
      const r = reply(msg)
      svc.routeDaemonFrame(machineId, {
        type: 'imageUploadResult',
        requestId: msg.requestId,
        path: r.path,
        ...(r.error !== undefined ? { error: r.error } : {}),
      })
    }
  })
  return seen
}

/** A live idle claude-code session the seance can address. */
function liveSession(o: ReturnType<typeof makeOracle>, sessionId: string, cwd = '/p'): void {
  o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'bind',
    sessionId: asSessionId(sessionId),
    cmd: 'claude',
    cwd,
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
    type: 'agentState',
    sessionId: asSessionId(sessionId),
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

  it(`${MUST_NOT_CHANGE}: an ANSWERED ask returns answered:true with the answer, the ack id and a live snapshot`, async () => {
    const o = makeOracle()
    const issue = o.reg.issues.create({ repoPath: '/r', title: 'issue A', startNow: false })
    o.reg.issues.update(issue.id, { worktreePath: '/r/.worktrees/a' })
    const target = o.reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r/.worktrees/a',
      issueId: issue.id,
    })
    liveSession(o, target.sessionId, '/r/.worktrees/a')

    // Start the seance WITHOUT awaiting: the answer has to arrive DURING the
    // bounded wait, which is the half a timeoutSeconds:0 test can never reach.
    const pending = o.call.sessions.ask({
      sessionId: target.sessionId,
      question: 'which way?',
      timeoutSeconds: 5,
    })

    // Wait on the question ROW appearing (predicate, never a sleep), then answer
    // it as the target agent would: a relayed messages.reply, which stamps the ack.
    let questionId = ''
    await waitFor(() => {
      const rows = o.store.messages.listLedger({ sessionId: target.sessionId })
      const q = rows.find((m) => m.kind === 'question')
      if (q) questionId = q.id
      return Boolean(q)
    }, 'the question row to be written')

    const replied = await o.relay({
      requestId: 'ack-the-question',
      sessionId: target.sessionId,
      router: 'messages',
      proc: 'reply',
      input: { id: questionId, body: 'left, then straight on' },
    })
    expect(replied.ok).toBe(true)

    const result = (await pending) as Record<string, unknown>

    expect(result).toMatchObject({
      answered: true,
      questionId,
      answer: 'left, then straight on',
      snapshot: { sessionId: target.sessionId, status: 'live', phase: 'idle' },
    })
    // The ack id is the REPLY's message id — the round trip is traceable in the
    // ledger, not just reported back as a string.
    expect(o.store.messages.getMessage(result.ackId as string)).toMatchObject({
      inReplyTo: questionId,
      body: 'left, then straight on',
    })
    expect(o.store.messages.getMessage(questionId)?.ackedBy).toBe(result.ackId)
  })

  it(`${MUST_NOT_CHANGE}: ask against an unknown session THROWS 'session not found' — the gate resolves the target before sending`, async () => {
    const o = makeOracle()

    expect(
      await messageOf(() =>
        // timeoutSeconds:0 so a REMOVED target gate fails here as a wrong RESULT
        // shape, not as a 20s vitest timeout that hides what changed.
        o.call.sessions.ask({ sessionId: GHOST, question: 'anyone?', timeoutSeconds: 0 }),
      ),
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
  // NAME AUDIT: this used to be called "carries the bytes to the SESSION's
  // machine" while running on a one-machine fixture, so it passed with the
  // routing argument dropped. The routing claim now lives — and is only made —
  // in the two-machine test below. This one checks the payload round trip.
  it(`${MUST_NOT_CHANGE}: a successful upload returns the daemon's absolute path and forwards filename, mimeType and bytes verbatim`, async () => {
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

  it(`${MUST_NOT_CHANGE}: an upload is routed to the SESSION's machine, not the default one`, async () => {
    // The second machine gets its own responder; the DEFAULT machine keeps the
    // recorder makeOracle installed and is never re-attached. Swapping the local
    // handler mid-test was a needless moving part — attachDaemon has retarget
    // side effects, and a handler swap is exactly the kind of ordering
    // dependence that makes a test flake instead of characterize.
    const o = makeOracle({ offlineMachines: [{ id: 'other', name: 'other' }] })
    const otherSeen = answerUploads(o, () => ({ path: '/on/other/x.png' }), 'other')
    const { sessionId } = await o.call.sessions.create({
      agentKind: 'claude-code',
      cwd: '/p',
      machineId: 'other',
    })
    // Placement first, routing second: if this ever fails, the fixture is wrong,
    // not the behaviour under test.
    expect(o.meta(sessionId).machineId).toBe('other')
    otherSeen.length = 0
    o.daemon.length = 0

    const result = await o.call.sessions.uploadImage({
      sessionId,
      filename: 'shot.png',
      mimeType: 'image/png',
      dataBase64: Buffer.from('bytes').toString('base64'),
    })

    // ROUTING IS AN INVARIANT, not an ownership question: the returned path has
    // to be valid in THIS session's prompt, so the bytes must land on the machine
    // that runs it. Tagged must-not-change deliberately — if POD-1079's ownership
    // work regresses routing, the red test must not be dismissible as "expected".
    // The ambient-authorization half is the separate characterization below.
    expect(result).toEqual({ path: '/on/other/x.png' })
    expect(otherSeen.filter((m) => m.type === 'imageUploadRequest')).toEqual([
      expect.objectContaining({
        type: 'imageUploadRequest',
        sessionId,
        filename: 'shot.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('bytes').toString('base64'),
      }),
    ])
    expect(o.daemon.filter((m) => m.type === 'imageUploadRequest')).toEqual([])
  })

  it(`${willChange('POD-1079', "machines become owned compute; 'use' defaults to the owner only")}: nothing checks whether the caller may USE the machine an upload lands on`, async () => {
    // The routing test above pins WHERE the bytes go. This pins that no check
    // stands between the caller and that machine: the upload writes to a machine
    // this operator has no declared relationship with, because there is no owner
    // column and no per-machine grant to consult (§3.1.4 M1/M2). Under POD-1079
    // an upload onto a machine the principal lacks `use` on must be refused.
    const o = makeOracle({ offlineMachines: [{ id: 'someones-laptop', name: 'Personal Mac' }] })
    const seen = answerUploads(
      o,
      () => ({ path: '/Users/someone/.podium/uploads/x.png' }),
      'someones-laptop',
    )
    const { sessionId } = await o.call.sessions.create({
      agentKind: 'claude-code',
      cwd: '/p',
      machineId: 'someones-laptop',
    })
    seen.length = 0

    const result = await o.call.sessions.uploadImage({
      sessionId,
      filename: 'shot.png',
      mimeType: 'image/png',
      dataBase64: 'AA==',
    })

    // Accepted, with no capability, grant or ownership consulted anywhere.
    expect(result).toEqual({ path: '/Users/someone/.podium/uploads/x.png' })
    expect(seen.filter((m) => m.type === 'imageUploadRequest')).toHaveLength(1)
  })

  it(`${willChange('POD-1073', 'invisible must later fail identically to nonexistent — §3.1.5')}: an upload for an UNKNOWN session is dispatched anyway, to the default machine`, async () => {
    const o = makeOracle()
    answerUploads(o, () => ({ path: '/home/agent/.podium/uploads/ghost/x.png' }))

    // No existence gate at all: the write is routed to the default machine and
    // lands. This is the session-existence behaviour §3.1.5 has to close, NOT the
    // machine-ownership question above — an owner would still be able to dispatch
    // a ghost upload to their own machine once POD-1079 lands.
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

  it(`${MUST_NOT_CHANGE}: an upload to a DETACHED (offline) machine times out after the RPC budget and surfaces as TIMEOUT`, async () => {
    vi.useFakeTimers()
    try {
      const o = makeOracle()
      const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
      o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
        type: 'bind',
        sessionId,
        cmd: 'claude',
        cwd: '/p',
        agentKind: 'claude-code',
        geometry: { cols: 80, rows: 24 },
      })

      // The REAL offline state: the daemon socket is gone, so the registry knows
      // the machine is not there. A deaf-but-attached daemon is a different state
      // (below) and would let a future "refuse immediately when offline" change
      // land while this test stayed green.
      o.reg.gateway.detachDaemon(o.reg.sessionStore.hostMachineId)
      expect(o.meta(sessionId).status).toBe('reconnecting')
      expect(o.reg.modules.machines.onlineMachineIds()).toEqual([])
      o.daemon.length = 0

      const settled = o.call.sessions
        .uploadImage({
          sessionId,
          filename: 'shot.png',
          mimeType: 'image/png',
          dataBase64: 'AA==',
        })
        .then(
          () => 'resolved',
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        )

      // Today there is NO early offline check: the request is dispatched into the
      // void and the caller waits out the whole 30s RPC budget.
      await vi.advanceTimersByTimeAsync(30_000)

      expect(await settled).toBe('no daemon answered the image upload request')
      // Nothing reached any daemon — the detached machine received no frame.
      expect(o.daemon.filter((m) => m.type === 'imageUploadRequest')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it(`${MUST_NOT_CHANGE}: an ONLINE but unresponsive machine is indistinguishable from an offline one — same TIMEOUT, after the same budget`, async () => {
    vi.useFakeTimers()
    try {
      const o = makeOracle()
      const { sessionId } = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })
      // Attached and considered ONLINE, but never answers. Kept as its own
      // characterization because the two states are genuinely different inputs
      // that today produce the same output — which is the fact worth pinning.
      o.reg.gateway.attachDaemon(o.reg.sessionStore.hostMachineId, (msg) => o.daemon.push(msg))
      expect(o.reg.modules.machines.onlineMachineIds()).toEqual(['local'])

      const settled = o.call.sessions
        .uploadImage({
          sessionId,
          filename: 'shot.png',
          mimeType: 'image/png',
          dataBase64: 'AA==',
        })
        .then(
          () => 'resolved',
          (e: unknown) => (e instanceof Error ? e.message : String(e)),
        )
      await vi.advanceTimersByTimeAsync(30_000)

      expect(await settled).toBe('no daemon answered the image upload request')
      // Unlike the detached case, the frame WAS sent — it just went unanswered.
      expect(o.daemon).toContainEqual(
        expect.objectContaining({ type: 'imageUploadRequest', sessionId }),
      )
    } finally {
      vi.useRealTimers()
    }
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
