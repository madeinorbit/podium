/**
 * CHARACTERIZATION — agent-mail delivery, threading, urgency and consumption
 * (POD-727, step 1 of the POD-640 mini-epic).
 *
 * Every test here pins the CURRENT behaviour of the hand-written procs so that
 * POD-728 (mail contracts + handlers) and POD-729 (cutover + deletion) can be
 * proven behaviour-preserving rather than merely compiling. Where today's
 * behaviour is odd, or is an artefact of the single-operator model, the test
 * SAYS SO in a comment instead of dressing it up as desirable: this file is an
 * oracle for a migration, not a specification of the end state.
 *
 * The load-bearing distinctions pinned below — each one is a behaviour a rewrite
 * can silently invert, and several are past bugs in this repo:
 *   - `delivered` means the PUSH was confirmed (transcript echo / turn boundary /
 *     injection), `read` means the recipient PULLED its inbox. They are different
 *     states reached by different events.
 *   - a peek is NOT a consume.
 *   - a message owes a reply only when it was sent --expect-response or is a
 *     `question`; an ordinary message is receipt-only.
 *   - self-delivery is suppressed: a self-only message is ledger-only, never queued.
 *   - `interrupt` lands mid-turn; an ordinary message waits for the recipient's
 *     turn boundary / stop hook.
 *
 * No test in this file sleeps before an assertion (POD-757). The clock is
 * injected and advanced explicitly; bounded waits converge through the harness's
 * poll seam.
 */

import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { mailHarness, OPERATOR, phaseState } from './characterization-support'
import {
  ECHO_CONFIRM_WINDOW_MS,
  HOP_LIMIT,
  INLINE_BODY_MAX,
  MAX_ECHO_REQUEUES,
  WAKE_COOLDOWN_MS,
} from './service'

const kinds = (h: ReturnType<typeof mailHarness>): string[] => h.events().map((e) => e.kind)

// ---------------------------------------------------------------------------
// D1 — the success axis, and the exact ledger fields a send writes.
// ---------------------------------------------------------------------------

describe('characterization: delivery ledger fields on the success axis (D1)', () => {
  it('records threadId/inReplyTo/hop/expiresAt/deliveredTo and leaves an enveloped push awaiting its echo', async () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('sTarget'), issueId: iss.id, phase: 'idle' })
    const expires = '2026-07-21T12:00:00.000Z'

    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: `#${iss.seq}`,
      body: 'the body',
      expiresAt: expires,
    })) as { id: string; ok: boolean; disposition: string; urgency: string; lifecycle: string }

    // v1 defaults: mail stays fyi + wait.
    expect(r).toMatchObject({ ok: true, urgency: 'fyi', lifecycle: 'wait' })
    const row = h.svc.message(r.id)!
    expect(row).toMatchObject({
      // A fresh message roots its own thread.
      threadId: row.id,
      inReplyTo: null,
      toKind: 'issue',
      toId: iss.id,
      kind: 'message',
      hop: 0,
      clampedFrom: null,
      expiresAt: expires,
      // An issue-addressed fyi is a PULL-path (pointer-mode) row: the push is
      // recorded, but only an inbox read confirms it — so it stays `queued`
      // with deliveredTo stamped, and deliveredAt stays null.
      status: 'queued',
      deliveredAt: null,
      deliveredTo: 'sTarget',
      readAt: null,
      deadLetteredAt: null,
      // Receipt-only by default (POD-835): no reply is owed.
      expectsResponse: false,
    })
    expect(row.injectedAt).toBeTruthy()
    // ... and the sender is told `queued`, NOT `delivered`. An enqueue is not a
    // delivery (the POD-495 defect-B lie).
    expect(r.disposition).toBe('queued')
    expect(kinds(h)).toEqual(expect.arrayContaining(['message.queued', 'message.injected']))
  })

  it('reports `held` when the issue is live but has no session at all', async () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'nobody home' })
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: iss.id,
      body: 'hold me',
    })) as { disposition: string; id: string }
    // Held, not dropped and not a bare success: delivered at the issue's next
    // session's turn boundary.
    expect(r.disposition).toBe('held')
    expect(h.pushes).toEqual([])
    expect(h.svc.message(r.id)!.status).toBe('queued')
  })

  it('dead-letters a session-addressed row whose session is gone, and an archived issue', async () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'archived' })
    h.put({ sessionId: asSessionId('sGone'), issueId: iss.id, phase: 'idle' })
    // The target session vanishes between the send surface's resolution and
    // delivery — resolution is deliberately TOCTOU-safe, so it is decided here.
    const r = await h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: 'sVanished' }, body: 'x' },
    )
    expect(r).toMatchObject({ ok: false, disposition: 'dead_letter' })
    expect(r.reason).toBe('dead-lettered: session no longer exists')
    expect(h.svc.message(r.message.id)!.status).toBe('dead_letter')

    // A closed-and-archived issue is GONE — no future session primes on it, so
    // holding would be a black hole.
    h.archive(iss.id)
    const r2 = h.svc.send({ kind: 'operator' }, { to: { kind: 'issue', id: iss.id }, body: 'y' })
    expect(r2.disposition).toBe('dead_letter')
    expect(r2.reason).toBe(`dead-lettered: issue #${iss.seq} is archived`)
  })
})

// ---------------------------------------------------------------------------
// D2 — ENVELOPE BYTE-FIDELITY. The substrate is deliberately unwrapped and
// byte-faithful for the operator, and control-stripped + enveloped for everyone
// else. These assertions are on EXACT BYTES, never shapes.
// ---------------------------------------------------------------------------

describe('characterization: envelope byte-fidelity (D2)', () => {
  it('renders the non-operator envelope byte-for-byte around a control-stripped body', () => {
    const h = mailHarness()
    const from = h.createIssue({ title: 'sender' })
    const to = h.createIssue({ title: 'receiver' })
    h.put({ sessionId: asSessionId('sTo'), issueId: to.id, phase: 'idle' })

    // The paste-END marker inside a body is the substrate-boundary attack: it
    // would terminate the bracketed paste early and everything after it would
    // run as raw keystrokes in another agent's session.
    const body = 'line1\n\u001b[201~rm -rf /\tTAB\u0000NUL'
    const r = h.svc.send(
      { kind: 'agent', issueId: from.id, sessionId: asSessionId('sFrom') },
      { to: { kind: 'session', id: 'sTo' }, body, urgency: 'next-turn' },
    )
    const id = r.message.id
    // Every C0/C1 control character except newline and tab is stripped; \n and
    // \t survive byte-exactly.
    expect(h.pushes).toHaveLength(1)
    expect(h.pushes[0]!.text).toBe(
      `[podium message ${id} · from issue:#${from.seq} · to your session · reply: podium mail reply ${id}]\n` +
        'line1\n[201~rm -rf /\tTABNUL\n' +
        `[end podium message ${id}]`,
    )
    // The stored row keeps the ORIGINAL bytes — sanitizing happens at delivery
    // only, so the ledger stays a faithful record of what was sent.
    expect(h.svc.message(id)!.body).toBe(body)
  })

  it('delivers an operator body unwrapped AND unsanitized — exact bytes, no frame', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    // SINGLE-OPERATOR ARTEFACT: "unwrapped = the human" is an invariant the
    // receiver's prime rules trust, and it rests on there being exactly ONE
    // operator principal (one shared password, one capability that is admin over
    // everything). POD-728 dissolves that class into named people and must
    // decide what unwrapped means then.
    const body = 'raw \u001b[201~ bytes \u0007 kept'
    h.svc.send({ kind: 'operator' }, { to: { kind: 'session', id: 's1' }, body })
    expect(h.pushes.map((p) => p.text)).toEqual([body])
  })

  it('renders the reply frame for an operator QUESTION around a still byte-faithful body', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    const body = 'why \u001b[201~ this?'
    const r = h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: 's1' }, body, kind: 'question' },
    )
    const id = r.message.id
    // The one exception to unwrapped-is-operator: without the frame the target
    // can never ack and awaitAck always times out. The BODY is still byte-faithful
    // (control characters intact) — only the frame is added.
    expect(h.pushes[0]!.text).toBe(
      `[podium message ${id} · from the operator · to your session · reply: podium mail reply ${id}]\n` +
        `${body}\n` +
        `[this is a question: answer it from your existing context with \`podium mail reply ${id}\`, ` +
        'then RETURN TO WHAT YOU WERE DOING — do not take up new work because of it]\n' +
        `[end podium message ${id}]`,
    )
  })

  it('adds the --expect-response directive, question-exempt, byte-for-byte', () => {
    const h = mailHarness()
    const from = h.createIssue({ title: 'sender' })
    const to = h.createIssue({ title: 'receiver' })
    h.put({ sessionId: asSessionId('sTo'), issueId: to.id, phase: 'idle' })
    const r = h.svc.send(
      { kind: 'agent', issueId: from.id, sessionId: asSessionId('sFrom') },
      {
        to: { kind: 'session', id: 'sTo' },
        body: 'please handle',
        urgency: 'next-turn',
        expectsResponse: true,
      },
    )
    const id = r.message.id
    expect(h.pushes[0]!.text).toBe(
      `[podium message ${id} · from issue:#${from.seq} · to your session · reply: podium mail reply ${id}]\n` +
        'please handle\n' +
        `[a response was requested: reply within this thread (\`podium mail reply ${id}\`) ` +
        'when you have handled it — any substantive reply satisfies it]\n' +
        `[end podium message ${id}]`,
    )
  })

  it('renders an oversized issue-addressed body as a pointer, never inline', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    const body = 'x'.repeat(INLINE_BODY_MAX + 1)
    h.svc.send({ kind: 'operator' }, { to: { kind: 'issue', id: iss.id }, body })
    expect(h.pushes[0]!.text).toBe(
      "[podium] 1 message(s) from operator — run 'podium issue mail inbox' to read them",
    )
  })
})

// ---------------------------------------------------------------------------
// D3 — urgency × lifecycle × target state. `interrupt` lands mid-turn; an
// ordinary message waits for the boundary.
// ---------------------------------------------------------------------------

describe('characterization: urgency x target state (D3)', () => {
  it('interrupt lands MID-TURN on a busy session while next-turn and fyi are held', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'busy' })
    h.put({ sessionId: asSessionId('sBusy'), issueId: iss.id, phase: 'working' })

    const fyi = h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: 'sBusy' }, body: 'a', urgency: 'fyi' },
    )
    const next = h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: 'sBusy' }, body: 'b', urgency: 'next-turn' },
    )
    const int = h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: 'sBusy' }, body: 'c', urgency: 'interrupt' },
    )

    // fyi surfaces at the next pause (stop-hook / prime pending); next-turn is
    // HELD for the turn boundary — queueText's immediate drain would type
    // mid-turn (#471) and its submitting CR would auto-answer an on-screen
    // AskUserQuestion menu (#473 P0).
    expect(fyi.disposition).toBe('queued')
    expect(next.disposition).toBe('queued')
    // ONLY the interrupt is pushed, and via interruptText (ESC first, so an open
    // question menu is visibly cancelled before the text lands).
    expect(h.pushes).toEqual([
      { fn: 'interruptText', sessionId: 'sBusy', text: 'c', inputOrigin: 'mail' },
    ])
    expect(int.disposition).toBe('delivered')
  })

  it('an idle session takes every urgency immediately via sendText', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'idle' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    for (const urgency of ['fyi', 'next-turn', 'interrupt'] as const) {
      h.svc.send(
        { kind: 'operator' },
        { to: { kind: 'session', id: 's1' }, body: urgency, urgency },
      )
    }
    expect(h.pushes.map((p) => p.fn)).toEqual(['sendText', 'sendText', 'sendText'])
  })

  it('a composer draft holds EVERY urgency including interrupt (POD-865)', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'drafting' })
    h.put({
      sessionId: asSessionId('s1'),
      issueId: iss.id,
      phase: 'idle',
      draftUpdatedAt: '2026-07-20T11:59:00.000Z',
    })
    const r = h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: 's1' }, body: 'x', urgency: 'interrupt' },
    )
    // Corrupting a human's half-typed line is never acceptable — the row stays
    // queued and the boundary/sweep delivers once the draft clears.
    expect(r.disposition).toBe('queued')
    expect(h.pushes).toEqual([])
  })

  it('a parked session holds a `wait` and resurrects on a `wake`', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'parked' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, status: 'hibernated' })

    const wait = h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: 's1' }, body: 'later', lifecycle: 'wait' },
    )
    expect(wait.disposition).toBe('queued')
    expect(h.pushes).toEqual([])

    const wake = h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: 's1' }, body: 'now', lifecycle: 'wake' },
    )
    // queueText resurrects a parked session; the row rides the durable queue.
    expect(wake.disposition).toBe('queued')
    expect(h.pushes).toEqual([
      { fn: 'queueText', sessionId: 's1', text: 'now', inputOrigin: 'mail' },
    ])
  })

  it('an unresumable wake falls through to the spawn seam and reports `spawning`', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'unresumable' })
    h.setWorktree(iss.id, '/wt/unresumable')
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, status: 'exited' })
    h.transport.ok = false
    h.transport.reason = 'no resume ref'
    h.transport.failSessions = ['s1']

    const r = h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: 's1' }, body: 'wake up', lifecycle: 'wake' },
    )
    // The spawn seam is reached only for a wake with nothing resumable, and the
    // message becomes the fresh child's first prompt.
    expect(h.wakeSpawns).toHaveLength(1)
    expect(h.wakeSpawns[0]).toMatchObject({
      cwd: '/wt/unresumable',
      issueId: iss.id,
      spawnedBy: 'user', // operator-triggered wake
    })
    expect(r.disposition).toBe('spawning')
    expect(kinds(h)).toContain('message.spawned')
  })
})

// ---------------------------------------------------------------------------
// D4 — the clamp matrix: DOWNGRADE, never reject, and record clampedFrom.
// ---------------------------------------------------------------------------

describe('characterization: clamp matrix records clampedFrom instead of failing (D4)', () => {
  it('clamps a peer agent from interrupt to next-turn and records the REQUESTED axes', () => {
    const h = mailHarness()
    const from = h.createIssue({ title: 'peer sender' })
    const to = h.createIssue({ title: 'peer target' })
    h.put({ sessionId: asSessionId('sTo'), issueId: to.id, phase: 'idle' })

    const r = h.svc.send(
      { kind: 'agent', issueId: from.id, sessionId: asSessionId('sFrom') },
      { to: { kind: 'session', id: 'sTo' }, body: 'x', urgency: 'interrupt', lifecycle: 'wake' },
    )
    // Not an error: the send succeeds at the capped axes.
    expect(r.ok).toBe(true)
    expect(r.message.urgency).toBe('next-turn')
    // A peer keeps `wake` (only urgency is capped for a peer).
    expect(r.message.lifecycle).toBe('wake')
    expect(JSON.parse(r.message.clampedFrom!)).toEqual({
      urgency: 'interrupt',
      lifecycle: 'wake',
      reasons: ['sender cap (peer)'],
    })
    expect(kinds(h)).toContain('message.clamped')
  })

  it('lets a PARENT interrupt + wake, unclamped', () => {
    const h = mailHarness()
    const parentIssue = h.createIssue({ title: 'parent' })
    const childIssue = h.createIssue({ title: 'child' })
    h.put({
      sessionId: asSessionId('sChild'),
      issueId: childIssue.id,
      phase: 'working',
      spawnedBy: 'session:sParent',
    })
    const r = h.svc.send(
      { kind: 'agent', issueId: parentIssue.id, sessionId: asSessionId('sParent') },
      { to: { kind: 'session', id: 'sChild' }, body: 'stop', urgency: 'interrupt' },
    )
    expect(r.message.clampedFrom).toBeNull()
    expect(h.pushes[0]!.fn).toBe('interruptText')
  })

  it('caps a system sender at next-turn/wait', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, status: 'hibernated' })
    const r = h.svc.send(
      { kind: 'system', name: 'steward' },
      { to: { kind: 'session', id: 's1' }, body: 'x', urgency: 'interrupt', lifecycle: 'wake' },
    )
    expect(r.message).toMatchObject({ urgency: 'next-turn', lifecycle: 'wait' })
    expect(JSON.parse(r.message.clampedFrom!).reasons).toEqual([
      'sender cap (system)',
      'sender cap (system)',
    ])
  })
})

// ---------------------------------------------------------------------------
// D5 — containment brakes: wake cooldown and the hop brake.
// ---------------------------------------------------------------------------

describe('characterization: wake cooldown and hop brake (D5)', () => {
  it('clamps a second wake within the window to wait, and allows it again after', () => {
    const h = mailHarness()
    const from = h.createIssue({ title: 'waker' })
    const to = h.createIssue({ title: 'sleeper' })
    h.put({ sessionId: asSessionId('sTo'), issueId: to.id, status: 'hibernated' })
    const sender = { kind: 'agent' as const, issueId: from.id, sessionId: 'sFrom' }

    const first = h.svc.send(sender, {
      to: { kind: 'session', id: 'sTo' },
      body: '1',
      lifecycle: 'wake',
    })
    expect(first.message.lifecycle).toBe('wake')

    const second = h.svc.send(sender, {
      to: { kind: 'session', id: 'sTo' },
      body: '2',
      lifecycle: 'wake',
    })
    expect(second.message.lifecycle).toBe('wait')
    expect(JSON.parse(second.message.clampedFrom!).reasons).toEqual([
      'wake cooldown (1 per 10min per sender+issue)',
    ])

    h.advance(WAKE_COOLDOWN_MS + 1)
    const third = h.svc.send(sender, {
      to: { kind: 'session', id: 'sTo' },
      body: '3',
      lifecycle: 'wake',
    })
    expect(third.message.lifecycle).toBe('wake')
  })

  it('inherits hop+1 within a message-triggered turn and clamps a wake past the depth limit', () => {
    const h = mailHarness()
    const a = h.createIssue({ title: 'a' })
    const b = h.createIssue({ title: 'b' })
    h.put({ sessionId: asSessionId('sA'), issueId: a.id, phase: 'idle' })
    h.put({ sessionId: asSessionId('sB'), issueId: b.id, phase: 'idle' })
    const agentA = { kind: 'agent' as const, issueId: a.id, sessionId: 'sA' }
    const agentB = { kind: 'agent' as const, issueId: b.id, sessionId: 'sB' }

    // The operator's kick carries hop 0; delivering it stamps sA's turn hop, so
    // what sA sends inside that turn chains at hop 1 — and so on down the
    // ping-pong. This is exactly the loop brake 3 exists to kill.
    h.svc.send({ kind: 'operator' }, { to: { kind: 'session', id: 'sA' }, body: 'kick' })
    const hops: number[] = []
    let last = ''
    for (let i = 1; i <= HOP_LIMIT + 1; i++) {
      const outbound = i % 2 === 1 ? agentA : agentB
      const target = i % 2 === 1 ? 'sB' : 'sA'
      // The cooldown is a SEPARATE brake keyed on sender+issue; step the clock
      // past its window so this test observes the hop brake alone.
      h.advance(WAKE_COOLDOWN_MS + 1)
      const out = h.svc.send(outbound, {
        to: { kind: 'session', id: target },
        body: `hop${i}`,
        urgency: 'next-turn',
        lifecycle: 'wake',
      })
      hops.push(out.message.hop)
      last = out.message.clampedFrom ?? ''
      if (out.message.hop > HOP_LIMIT) {
        // Past the limit the lifecycle degrades to wait and the thread surfaces
        // to the human — the chain dies out, nothing is dropped.
        expect(out.message.lifecycle).toBe('wait')
        expect(JSON.parse(last).reasons).toContain(
          `hop limit (depth ${out.message.hop} > ${HOP_LIMIT})`,
        )
        expect(kinds(h)).toContain('message.needs_attention')
      } else {
        expect(out.message.lifecycle).toBe('wake')
      }
    }
    expect(hops).toEqual([1, 2, 3, 4, 5, 6])
  })
})

// ---------------------------------------------------------------------------
// D6 — DELIVERED means the push was confirmed; READ means the inbox was pulled.
// ---------------------------------------------------------------------------

describe('characterization: delivered (echo) vs read (inbox) (D6)', () => {
  it('flips queued → delivered only on a USER-role transcript echo from the session we pushed to', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    h.put({ sessionId: asSessionId('sOther'), issueId: iss.id, phase: 'idle' })
    const r = h.svc.send(
      { kind: 'agent', issueId: iss.id, sessionId: asSessionId('sFrom') },
      { to: { kind: 'session', id: 's1' }, body: 'x', urgency: 'next-turn' },
    )
    const id = r.message.id
    expect(h.svc.message(id)!.status).toBe('queued')

    // An assistant turn quoting the id must never self-confirm.
    h.svc.onTranscriptDelta(asSessionId('s1'), [{ role: 'assistant', text: `podium message ${id}` }])
    expect(h.svc.message(id)!.status).toBe('queued')
    // Nor may a DIFFERENT session's transcript quoting the id confirm it (the
    // operator pasting it elsewhere) — that would strand the real target.
    h.svc.onTranscriptDelta(asSessionId('sOther'), [{ role: 'user', text: `podium message ${id}` }])
    expect(h.svc.message(id)!.status).toBe('queued')

    h.svc.onTranscriptDelta(asSessionId('s1'), [{ role: 'user', text: `[podium message ${id} · from x]` }])
    const delivered = h.svc.message(id)!
    expect(delivered.status).toBe('delivered')
    expect(delivered.deliveredAt).toBe(h.now())
    expect(delivered.readAt).toBeNull()
    expect(
      h
        .events(['message.delivered'])
        .map((e) => (e.payload as { confirmedVia: string }).confirmedVia),
    ).toEqual(['echo'])
  })

  it('an inbox READ is a different state from a pushed delivery, and marks readAt', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    const r = h.svc.send({ kind: 'operator' }, { to: { kind: 'issue', id: iss.id }, body: 'x' })
    const id = r.message.id
    expect(h.svc.message(id)!.status).toBe('queued')

    const rows = h.svc.readInbox([{ kind: 'issue', id: iss.id }], { consume: asSessionId('sReader') })
    expect(rows.map((m) => m.status)).toEqual(['read'])
    const read = h.svc.message(id)!
    expect(read).toMatchObject({ status: 'read', readAt: h.now(), deliveredTo: 'sReader' })
    // The legacy issue_messages mirror is consumed in step, or the stop-hook's
    // legacy fallback keeps nagging "You have mail".
    expect(h.store.issues.countUnreadIssueMessages(iss.id)).toBe(0)
    expect(kinds(h)).toContain('message.read')
  })

  it('a turn boundary confirms an already-pushed row, but an ERRORED turn does not', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    const [s1] = h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'working' })
    // next-turn to a busy session: held, nothing pushed yet.
    const r = h.svc.send(
      { kind: 'agent', issueId: iss.id, sessionId: asSessionId('sFrom') },
      { to: { kind: 'session', id: 's1' }, body: 'x', urgency: 'next-turn' },
    )
    const id = r.message.id

    // Turn ends → the drain pushes it.
    s1!.agentState = phaseState('idle')
    h.svc.onSessionIdle(s1!)
    expect(h.pushes).toHaveLength(1)
    expect(h.svc.message(id)!.status).toBe('queued')

    // An ERRORED turn did not complete, so it must not confirm the injected row.
    h.svc.onSessionIdle(s1!, { priorPhase: 'errored' })
    expect(h.svc.message(id)!.status).toBe('queued')

    // A clean turn boundary IS the reliable backstop for a mid-turn injection
    // whose envelope never echoes as a clean user turn.
    h.svc.onSessionIdle(s1!, { priorPhase: 'idle' })
    expect(h.svc.message(id)!.status).toBe('delivered')
    expect(
      h
        .events(['message.delivered'])
        .map((e) => (e.payload as { confirmedVia: string }).confirmedVia),
    ).toEqual(['boundary'])
  })
})

// ---------------------------------------------------------------------------
// D7 — duplicate delivery: an injected row is not re-pushed inside the echo
// window, is requeued once past it, and is capped after MAX_ECHO_REQUEUES.
// ---------------------------------------------------------------------------

describe('characterization: duplicate delivery is braked, then capped (D7)', () => {
  it('does not re-push inside the echo window, requeues past it, and caps the loop', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    const r = h.svc.send(
      { kind: 'agent', issueId: iss.id, sessionId: asSessionId('sFrom') },
      { to: { kind: 'session', id: 's1' }, body: 'x', urgency: 'next-turn' },
    )
    const id = r.message.id
    expect(h.pushes).toHaveLength(1)

    // A sweep inside the echo window must not duplicate the message.
    h.svc.sweep()
    expect(h.pushes).toHaveLength(1)

    // Past the window the push is treated as lost and re-injected — bounded by
    // MAX_ECHO_REQUEUES, because a mid-turn injection never echoes as a user
    // turn and an uncapped loop re-delivers forever (observed live 2026-07-17).
    for (let i = 0; i < MAX_ECHO_REQUEUES + 2; i++) {
      h.advance(ECHO_CONFIRM_WINDOW_MS + 1)
      h.svc.sweep()
    }
    expect(h.pushes).toHaveLength(1 + MAX_ECHO_REQUEUES)
    expect(kinds(h)).toContain('message.echo_capped')
    // Degraded to delivered-at-last-push rather than looping.
    expect(h.svc.message(id)!.status).toBe('delivered')
  })

  it('never re-nudges a coalesced pointer row (no re-nudge storm)', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    const [s1] = h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'working' })
    for (const body of ['one', 'two']) {
      h.svc.send({ kind: 'operator' }, { to: { kind: 'issue', id: iss.id }, body, urgency: 'fyi' })
    }
    s1!.agentState = phaseState('idle')
    h.svc.onSessionIdle(s1!)
    // Two fyi issue rows coalesce into ONE pointer.
    expect(h.pushes).toHaveLength(1)
    expect(h.pushes[0]!.text).toBe(
      "[podium] 2 message(s) from operator — run 'podium issue mail inbox' to read them",
    )
    // A pointer is confirmed by an inbox READ, never by echo, and is never
    // re-pushed however long the sweep runs.
    h.advance(ECHO_CONFIRM_WINDOW_MS * 5)
    h.svc.sweep()
    expect(h.pushes).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// D8 — reply threading, and what actually ENDS a thread.
// ---------------------------------------------------------------------------

describe('characterization: reply threading and thread termination (D8)', () => {
  it('inherits the thread, stamps acked_by, and confirms the original as delivered-by-ack', async () => {
    const h = mailHarness()
    const from = h.createIssue({ title: 'asker' })
    const to = h.createIssue({ title: 'answerer' })
    h.put({ sessionId: asSessionId('sFrom'), issueId: from.id, phase: 'idle' })
    h.put({ sessionId: asSessionId('sTo'), issueId: to.id, phase: 'idle' })
    const original = h.svc.send(
      { kind: 'agent', issueId: from.id, sessionId: asSessionId('sFrom') },
      {
        to: { kind: 'session', id: 'sTo' },
        body: 'question?',
        urgency: 'next-turn',
        expectsResponse: true,
      },
    )
    const oid = original.message.id

    const r = (await h.gate.dispatch(h.agentCap(to.id, 'sTo'), undefined, 'reply', {
      id: oid,
      body: 'answer!',
    })) as { id: string; acked: boolean; disposition: string }
    expect(r.acked).toBe(true)

    const reply = h.svc.message(r.id)!
    expect(reply).toMatchObject({
      threadId: original.message.threadId,
      inReplyTo: oid,
      kind: 'ack',
      // A response is PULL-delivered: an ack never burns a recipient turn.
      urgency: 'fyi',
      lifecycle: 'wait',
    })
    // The ack routes back to the ORIGINAL's sender — never caller-supplied.
    expect(reply).toMatchObject({ toKind: 'session', toId: 'sFrom' })

    const acked = h.svc.message(oid)!
    expect(acked.ackedBy).toBe(r.id)
    // A reply PROVES receipt — a stronger signal than a transcript echo.
    expect(acked.status).toBe('delivered')
    expect(
      h
        .events(['message.delivered'])
        .map((e) => (e.payload as { confirmedVia: string }).confirmedVia),
    ).toContain('ack')
    expect(kinds(h)).toContain('message.acked')
  })

  it('a SUBSTANTIVE reply from the party that was asked satisfies the request; a steward notification never does', () => {
    const h = mailHarness()
    const from = h.createIssue({ title: 'asker' })
    const to = h.createIssue({ title: 'answerer' })
    h.put({ sessionId: asSessionId('sFrom'), issueId: from.id, phase: 'idle' })
    h.put({ sessionId: asSessionId('sTo'), issueId: to.id, phase: 'idle' })
    const original = h.svc.send(
      { kind: 'agent', issueId: from.id, sessionId: asSessionId('sFrom') },
      {
        to: { kind: 'session', id: 'sTo' },
        body: 'please handle',
        urgency: 'next-turn',
        expectsResponse: true,
      },
    )
    const oid = original.message.id

    // The steward's own settle-nag fires precisely BECAUSE nobody responded — it
    // must never stamp acked_by (that would report the request answered and
    // release awaitAck by the nag itself).
    h.svc.send(
      { kind: 'system', name: 'steward' },
      { to: { kind: 'session', id: 'sFrom' }, kind: 'notification', inReplyTo: oid, body: 'nag' },
    )
    expect(h.svc.message(oid)!.ackedBy).toBeNull()

    // Nor does a `notification` from the ASKED PARTY ITSELF: a notification is
    // STRUCTURALLY never a response (this is the guard that keeps the settle-nag
    // from releasing awaitAck by itself, tested here on the one sender for whom
    // the other guards do not already decide it).
    h.svc.send(
      { kind: 'agent', issueId: to.id, sessionId: asSessionId('sTo') },
      {
        to: { kind: 'session', id: 'sFrom' },
        kind: 'notification',
        inReplyTo: oid,
        body: 'FYI, not an answer',
      },
    )
    expect(h.svc.message(oid)!.ackedBy).toBeNull()

    // Nor does a reply from a THIRD party.
    const third = h.createIssue({ title: 'bystander' })
    h.svc.send(
      { kind: 'agent', issueId: third.id, sessionId: asSessionId('sThird') },
      { to: { kind: 'session', id: 'sFrom' }, kind: 'message', inReplyTo: oid, body: 'me too' },
    )
    expect(h.svc.message(oid)!.ackedBy).toBeNull()

    // A plain `message` reply from the ASKED party does: a thorough substantive
    // reply ends the thread, not only a kind:'ack' (POD-835 — treating such a
    // reply as "no ack" produced 36 false "finished without acking" notices).
    const substantive = h.svc.send(
      { kind: 'agent', issueId: to.id, sessionId: asSessionId('sTo') },
      { to: { kind: 'session', id: 'sFrom' }, kind: 'message', inReplyTo: oid, body: 'handled it' },
    )
    expect(h.svc.message(oid)!.ackedBy).toBe(substantive.message.id)
  })
})

// ---------------------------------------------------------------------------
// D9 — a reply is owed ONLY for --expect-response or a question, and unreplied
// mail redelivers exactly once through the stop hook.
// ---------------------------------------------------------------------------

describe('characterization: who owes a reply, and the single redelivery (D9)', () => {
  it('sets expectsResponse for --expect-response and for a question, never for ack/notification', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    const to = { kind: 'session' as const, id: 's1' }

    expect(h.svc.send({ kind: 'operator' }, { to, body: 'plain' }).message.expectsResponse).toBe(
      false,
    )
    expect(
      h.svc.send({ kind: 'operator' }, { to, body: 'asked', expectsResponse: true }).message
        .expectsResponse,
    ).toBe(true)
    expect(
      h.svc.send({ kind: 'operator' }, { to, body: 'q', kind: 'question' }).message.expectsResponse,
    ).toBe(true)
    // An ack is never itself ackable (this is what killed the #243 ack-of-acks).
    const original = h.svc.send({ kind: 'operator' }, { to, body: 'o' })
    expect(
      h.svc.send(
        { kind: 'operator' },
        { to, body: 'a', kind: 'ack', inReplyTo: original.message.id, expectsResponse: true },
      ).message.expectsResponse,
    ).toBe(false)
    expect(
      h.svc.send(
        { kind: 'operator' },
        { to, body: 'n', kind: 'notification', expectsResponse: true },
      ).message.expectsResponse,
    ).toBe(false)
  })

  it('reminds about an unreplied --expect-response message exactly ONCE, and never about a plain one', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    const to = { kind: 'session' as const, id: 's1' }
    // Both are pushed to an idle session; the operator's body is unwrapped, so
    // it is confirmed on injection (delivered) — the state pendingReminders reads.
    h.svc.send({ kind: 'operator' }, { to, body: 'plain, no reply owed' })
    const asked = h.svc.send(
      { kind: 'operator' },
      { to, body: 'reply please', expectsResponse: true },
    )

    const first = h.svc.pendingReminders(asSessionId('s1'))
    expect(first).toEqual([{ id: asked.message.id, from: 'operator', body: 'reply please' }])
    // Each message earns exactly ONE reminder, persisted — then the steward
    // fallback owns it. Unreplied mail does not nag forever.
    expect(h.svc.pendingReminders(asSessionId('s1'))).toEqual([])
    // Still outstanding for the settle path until a reply lands.
    expect(h.svc.settleNotifiable(asSessionId('s1')).map((m) => m.id)).toEqual([asked.message.id])
    h.svc.sendReply(
      { kind: 'agent', issueId: iss.id, sessionId: asSessionId('s1') },
      {
        inReplyTo: asked.message.id,
        body: 'done',
      },
    )
    expect(h.svc.settleNotifiable(asSessionId('s1'))).toEqual([])
  })

  it('emits one steward settle notice per unanswered message, routed like a reply', () => {
    const h = mailHarness()
    const from = h.createIssue({ title: 'asker' })
    const to = h.createIssue({ title: 'answerer' })
    h.put({ sessionId: asSessionId('sFrom'), issueId: from.id, phase: 'idle' })
    h.put({ sessionId: asSessionId('sTo'), issueId: to.id, phase: 'idle' })
    for (const body of ['q1', 'q2']) {
      const sent = h.svc.send(
        { kind: 'agent', issueId: from.id, sessionId: asSessionId('sFrom') },
        {
          to: { kind: 'session', id: 'sTo' },
          body,
          urgency: 'next-turn',
          expectsResponse: true,
        },
      )
      // The settle notice only fires for messages the recipient DEMONSTRABLY
      // has: the query is gated on status delivered/read, so an enveloped push
      // still awaiting its echo is deliberately not notifiable yet.
      h.svc.onTranscriptDelta(asSessionId('sTo'), [{ role: 'user', text: `podium message ${sent.message.id}` }])
    }
    h.pushes.length = 0
    h.svc.systemAckFallback(asSessionId('sTo'), { outcome: 'finished', issueSeq: to.seq, issueStage: 'review' })
    // ONE notice PER MESSAGE — a group notice referencing only the latest would
    // leave the others unmarked and re-fire them next settle (the loop that sent
    // one message 7 notices in 33 minutes).
    const notices = h.svc
      .inbox([{ kind: 'session', id: 'sFrom' }])
      .filter((m) => m.kind === 'notification')
    expect(notices).toHaveLength(2)
    expect(notices[0]!.body).toContain('finished without responding to your message')
    expect(notices[0]!.body).toContain(`issue #${to.seq} stage=review`)
    // Idempotent: a second settle produces nothing new.
    h.svc.systemAckFallback(asSessionId('sTo'), { outcome: 'finished' })
    expect(
      h.svc.inbox([{ kind: 'session', id: 'sFrom' }]).filter((m) => m.kind === 'notification'),
    ).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// D10 — self-delivery suppression: ledger-only, never queued.
// ---------------------------------------------------------------------------

describe('characterization: self-delivery suppression (D10)', () => {
  it('consumes a session self-send straight to the ledger — delivered to nobody, never pushed', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'solo' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    const r = h.svc.send(
      { kind: 'agent', issueId: iss.id, sessionId: asSessionId('s1') },
      { to: { kind: 'session', id: 's1' }, body: 'note to self' },
    )
    // "The sender already knows it sent it." Recorded, not dropped — and it
    // reports delivered because there is no one else to reach (this is the
    // POD-279 15x self-echo loop).
    expect(r).toMatchObject({ ok: true, queued: false, disposition: 'delivered' })
    expect(h.pushes).toEqual([])
    const row = h.svc.message(r.message.id)!
    expect(row).toMatchObject({ status: 'delivered', deliveredTo: null })
    expect(kinds(h)).toContain('message.self_suppressed')
  })

  it('suppresses an issue-addressed note when the sender is the issue’s only member', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'solo issue' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    const r = h.svc.send(
      { kind: 'agent', issueId: iss.id, sessionId: asSessionId('s1') },
      { to: { kind: 'issue', id: iss.id }, body: 'my own note' },
    )
    expect(r.disposition).toBe('delivered')
    expect(h.pushes).toEqual([])
    // It must never spawn a fresh agent to receive the sender's own mail, even
    // on a wake.
    expect(h.wakeSpawns).toEqual([])
  })

  it('excludes the sender from issue-recipient resolution but still reaches a sibling', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'two members' })
    h.put({ sessionId: asSessionId('sSender'), issueId: iss.id, phase: 'idle' })
    h.put({ sessionId: asSessionId('sPeer'), issueId: iss.id, phase: 'idle' })
    h.svc.send(
      { kind: 'agent', issueId: iss.id, sessionId: asSessionId('sSender') },
      { to: { kind: 'issue', id: iss.id }, body: 'for whoever is up' },
    )
    expect(h.pushes.map((p) => p.sessionId)).toEqual(['sPeer'])
  })

  it('never delivers a sender’s own issue row back to it during the idle drain', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'drain' })
    const [sender, peer] = h.put(
      { sessionId: asSessionId('sSender'), issueId: iss.id, phase: 'working' },
      { sessionId: 'sPeer', issueId: iss.id, phase: 'working' },
    )
    h.svc.send(
      { kind: 'agent', issueId: iss.id, sessionId: asSessionId('sSender') },
      { to: { kind: 'issue', id: iss.id }, body: 'queued while both busy' },
    )
    expect(h.pushes).toEqual([])
    // The SENDER going idle must not pull its own note back...
    sender!.agentState = phaseState('idle')
    h.svc.onSessionIdle(sender!)
    expect(h.pushes).toEqual([])
    // ...but the real recipient's drain gets it.
    peer!.agentState = phaseState('idle')
    h.svc.onSessionIdle(peer!)
    expect(h.pushes.map((p) => p.sessionId)).toEqual(['sPeer'])
  })
})

// ---------------------------------------------------------------------------
// D11 — blocking send: the sender is never handed a bare `queued` for an
// urgency that promised more.
// ---------------------------------------------------------------------------

describe('characterization: urgency-gated blocking send (D11)', () => {
  it('upgrades to delivered when the echo lands during the block, and drops the legacy queued flag', async () => {
    // The push happens synchronously inside send(), so the echo can only arrive
    // afterwards: drive it from the FIRST poll of the block. No wall-clock wait,
    // and the confirmation travels the real transcript-echo path.
    let echoOnce: (() => void) | null = null
    const h = mailHarness({
      awaitPollMs: 500,
      onPoll: () => {
        const fire = echoOnce
        echoOnce = null
        fire?.()
      },
    })
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    echoOnce = () => {
      const row = h.svc.inbox([{ kind: 'session', id: 's1' }]).at(-1)!
      h.svc.onTranscriptDelta(asSessionId('s1'), [{ role: 'user', text: `podium message ${row.id}` }])
    }
    const r = (await h.gate.dispatch(h.agentCap(iss.id, 'sFrom'), undefined, 'send', {
      to: 's1',
      body: 'confirm me',
      urgency: 'next-turn',
    })) as { disposition: string; queued?: boolean }
    expect(r.disposition).toBe('delivered')
    // The legacy `queued` boolean must stay consistent with the FINAL
    // disposition — never `queued: true` alongside `delivered`.
    expect(r.queued).not.toBe(true)
  })

  it('returns the honest `accepted` when the budget expires with the row still queued', async () => {
    const h = mailHarness({ awaitPollMs: 500 })
    const iss = h.createIssue({ title: 'busy' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'working' })
    const r = (await h.gate.dispatch(h.agentCap(iss.id, 'sFrom'), undefined, 'send', {
      to: 's1',
      body: 'held by a busy turn',
      urgency: 'next-turn',
    })) as { disposition: string }
    // Durably captured, not yet confirmed — the sender queries `podium mail
    // status`. Never a bare `queued`, never an infinite block.
    expect(r.disposition).toBe('accepted')
  })

  it('never blocks an fyi', async () => {
    const h = mailHarness({ awaitPollMs: 500 })
    const iss = h.createIssue({ title: 'busy' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'working' })
    const before = h.now()
    const r = (await h.gate.dispatch(h.agentCap(iss.id, 'sFrom'), undefined, 'send', {
      to: 's1',
      body: 'fyi',
      urgency: 'fyi',
    })) as { disposition: string }
    expect(r.disposition).toBe('queued')
    // The injected clock only advances inside a poll, so an unblocked send
    // leaves it untouched — proof that fyi confirms at queued.
    expect(h.now()).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// D12 — `mail status` is the sender-queryable lifecycle.
// ---------------------------------------------------------------------------

describe('characterization: sender-queryable status (D12)', () => {
  it('lets the SENDER pull the full ledger row of the message it sent', async () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    const from = h.createIssue({ title: 'sender' })
    h.put({ sessionId: asSessionId('sTo'), issueId: iss.id, phase: 'idle' })
    const r = h.svc.send(
      { kind: 'agent', issueId: from.id, sessionId: asSessionId('sFrom') },
      { to: { kind: 'session', id: 'sTo' }, body: 'x', urgency: 'next-turn' },
    )
    const wire = (await h.gate.dispatch(h.agentCap(from.id, 'sFrom'), undefined, 'status', {
      id: r.message.id,
    })) as Record<string, unknown>
    expect(wire).toMatchObject({
      id: r.message.id,
      from: `issue:#${from.seq}`,
      to: 'session:sTo',
      status: 'queued',
      deliveredTo: 'sTo',
      hop: 0,
      expectsResponse: false,
    })
    // A stranger may not query it.
    const stranger = h.createIssue({ title: 'stranger' })
    await expect(
      h.gate.dispatch(h.agentCap(stranger.id, 'sStranger'), undefined, 'status', {
        id: r.message.id,
      }),
    ).rejects.toThrow('not allowed to view a message you neither sent nor received')
  })
})
