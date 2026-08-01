/**
 * CHARACTERIZATION — agent-mail AUTHZ and IDENTITY as they behave TODAY
 * (POD-727, for POD-728 / POD-729).
 *
 * Podium is becoming multi-user within one tenant (docs/multi-user-readiness.md;
 * §3.1.5 is about this exact code). POD-728 will CHANGE the authz semantics of
 * this surface. The point of characterization is that those become VERIFIED
 * changes rather than assumptions, so this file pins today's surface exactly —
 * including the parts that are wrong on purpose to record, such as the
 * unknown-id vs out-of-scope-id error divergence that makes the send path an
 * existence oracle.
 *
 * Where a behaviour is an artefact of the SINGLE-OPERATOR model (one shared
 * password, one OPERATOR capability that is admin over everything), the test
 * says so. Those comments are the decision list POD-728 has to work through:
 * §3.2 attribution must name a person, and §3.1.6 S1/S2/S3 make the superagent
 * and attention routing per-user. None of it is asserted as desirable.
 */

import { asIssueId, asSessionId, FIRST_ADMIN_USER_ID, type IssueScope } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import type { Capability } from '../../issue-authz'
import type { MessageRow } from '../../store'
import { mailHarness, OPERATOR } from './characterization-support'
import { senderFromCapability, WAKE_COOLDOWN_MS } from './service'

/** Assert a thrown TRPCError's code AND message verbatim. */
async function rejectsWith(p: Promise<unknown>, code: string, message: string): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => {
    if (!(e instanceof TRPCError)) throw new Error(`expected a TRPCError, got ${String(e)}`)
    expect({ code: e.code, message: e.message }).toEqual({ code, message })
    return true
  })
}

// ---------------------------------------------------------------------------
// A1 — SENDER STAMPING. ADR 3 D7, already implemented: the sender comes from
// ctx.capability and client input never contributes sender fields (the
// mailIdentity pattern). This is an INVARIANT test: it must survive POD-728
// unchanged.
// ---------------------------------------------------------------------------

describe('characterization: the sender is stamped from the capability, never from the payload (A1)', () => {
  it('ignores every sender-shaped field a client smuggles into the send payload', async () => {
    const h = mailHarness()
    const mine = h.createIssue({ title: 'mine' })
    const target = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('sTarget'), issueId: target.id, phase: 'idle' })

    const r = (await h.gate.dispatch(h.agentCap(mine.id, asSessionId('sMine')), true, 'send', {
      to: 'sTarget',
      body: 'x',
      // All of this is a lie the client is telling. None of it may be read.
      from: 'operator',
      fromKind: 'operator',
      fromSession: asSessionId('sVictim'),
      fromIssue: target.id,
      sender: { kind: 'operator' },
    })) as { id: string }

    const row = h.svc.message(r.id)!
    expect({
      fromKind: row.fromKind,
      fromIssue: row.fromIssue,
      fromSession: row.fromSession,
    }).toEqual({
      fromKind: 'agent',
      fromIssue: mine.id,
      fromSession: asSessionId('sMine'),
    })
    // fromName belongs to system senders only; an agent leaves it unset.
    expect(row.fromName ?? null).toBeNull()
    // And the body is delivered ENVELOPED (an agent), not unwrapped: the client
    // could not promote itself to the operator's byte-faithful path either.
    expect(h.pushes[0]!.text).toContain(`[podium message ${row.id} ·`)
  })

  it('derives the sender principal from the capability scope, and never mistakes an issueless agent for the operator', () => {
    // SINGLE-OPERATOR ARTEFACT: scope 'all' IS the operator here, because there
    // is exactly one such capability. POD-728 dissolves this into named people.
    expect(senderFromCapability({ scope: { kind: 'all' } })).toEqual({ kind: 'operator' })
    expect(senderFromCapability({ scope: { kind: 'all' }, actorSessionId: asSessionId('s1') })).toEqual({
      kind: 'operator',
    })
    // "unwrapped = the human" is an invariant the receiver's prime rules trust,
    // so an ISSUELESS agent session (scope 'none' + actorSessionId) must stamp as
    // an AGENT — enveloped, peer-clamped, cooldown-subject — never the operator.
    expect(senderFromCapability({ scope: { kind: 'none' }, actorSessionId: asSessionId('s1') })).toEqual({
      kind: 'agent',
      sessionId: asSessionId('s1'),
    })
    expect(senderFromCapability({ scope: { kind: 'none' } })).toEqual({ kind: 'agent' })
    expect(
      senderFromCapability({ scope: { kind: 'subtree', rootId: asIssueId('iss_a') }, actorSessionId: asSessionId('s1') }),
    ).toEqual({ kind: 'agent', issueId: 'iss_a', sessionId: asSessionId('s1') })
    // A subtree scope with no rootId cannot claim an issue.
    // The scope literal is DELIBERATELY malformed — a subtree arm with no rootId,
    // which `IssueScope` makes unrepresentable. The cast is the point of the test:
    // it pins the RUNTIME behaviour for a value the types now forbid, so the guard
    // survives if something ever produces one (POD-362 composed this parameter;
    // before that the service restated the scope shape and accepted this freely).
    const malformedSubtree = { kind: 'subtree' } as unknown as IssueScope
    expect(senderFromCapability({ scope: malformedSubtree, actorSessionId: asSessionId('s1') })).toEqual({
      kind: 'agent',
      sessionId: asSessionId('s1'),
    })
  })
})

// ---------------------------------------------------------------------------
// A2 — TARGET GATING on send: session-addressed goes through the session-target
// gate; issue-addressed goes through checkIssueAccess(write) against the
// RESOLVED target issue.
// ---------------------------------------------------------------------------

describe('characterization: target gating on send (A2)', () => {
  it('gates an issue-addressed send on write access to the RESOLVED issue, and takes --outside-scope as the confirmation', async () => {
    const h = mailHarness()
    const mine = h.createIssue({ title: 'mine' })
    const theirs = h.createIssue({ title: 'theirs' })
    h.put({ sessionId: asSessionId('sTheirs'), issueId: theirs.id, phase: 'idle' })
    const cap = h.agentCap(mine.id, asSessionId('sMine'))

    await rejectsWith(
      h.gate.dispatch(cap, undefined, 'send', { to: `#${theirs.seq}`, body: 'x' })!,
      'PRECONDITION_FAILED',
      `issue ${theirs.id} is outside your subtree; re-run with --outside-scope to confirm`,
    )
    // Nothing was sent: the gate runs before the substrate.
    expect(h.svc.ledger({ issueId: theirs.id })).toEqual([])

    const ok = (await h.gate.dispatch(cap, true, 'send', {
      to: `#${theirs.seq}`,
      body: 'x',
    })) as { ok: boolean }
    expect(ok.ok).toBe(true)
  })

  it('--outside-scope crosses SCOPE ONLY — it never elevates the clamp matrix', async () => {
    const h = mailHarness()
    const mine = h.createIssue({ title: 'mine' })
    const theirs = h.createIssue({ title: 'theirs' })
    h.put({ sessionId: asSessionId('sTheirs'), issueId: theirs.id, phase: 'working' })

    const r = (await h.gate.dispatch(h.agentCap(mine.id, asSessionId('sMine')), true, 'send', {
      to: 'sTheirs',
      body: 'x',
      urgency: 'interrupt',
      lifecycle: 'wake',
    })) as { urgency: string; clamped?: boolean }
    // Confirmed scope-crossing, still a PEER: capped at next-turn.
    expect(r).toMatchObject({ urgency: 'next-turn', clamped: true })
  })

  it('routes a session-addressed send through the session-target gate, parent/operator-only when the target has no issue', async () => {
    const h = mailHarness()
    const mine = h.createIssue({ title: 'mine' })
    // An issueless session, and a cwd no issue owns.
    h.put({ sessionId: asSessionId('sFree'), cwd: '/elsewhere', phase: 'idle' })
    await expect(
      h.gate.dispatch(h.agentCap(mine.id, asSessionId('sMine')), true, 'send', { to: 'sFree', body: 'x' }),
    ).rejects.toThrow('target session has no issue; only its parent or the operator may message it')

    // The operator may (single-operator artefact: one capability is admin over
    // everything, so "the operator" is the universal fallback authority).
    expect(
      (
        (await h.gate.dispatch(OPERATOR, undefined, 'send', { to: 'sFree', body: 'x' })) as {
          ok: boolean
        }
      ).ok,
    ).toBe(true)

    // ... and so may its PARENT, by spawnedBy provenance alone.
    h.put({ sessionId: asSessionId('sKid'), cwd: '/elsewhere', phase: 'idle', spawnedBy: 'session:sMine' })
    expect(
      (
        (await h.gate.dispatch(h.agentCap(mine.id, asSessionId('sMine')), undefined, 'send', {
          to: 'sKid',
          body: 'x',
        })) as { ok: boolean }
      ).ok,
    ).toBe(true)
  })

  it('puts the spawn-on-wake seam DOWNSTREAM of the same check — a denied cross-subtree wake spawns nothing', async () => {
    const h = mailHarness()
    const mine = h.createIssue({ title: 'mine' })
    const theirs = h.createIssue({ title: 'theirs' })
    h.setWorktree(theirs.id, '/wt/theirs')
    // No live session on `theirs`: a permitted wake here WOULD reach the spawn seam.
    await rejectsWith(
      h.gate.dispatch(h.agentCap(mine.id, asSessionId('sMine')), undefined, 'send', {
        to: theirs.id,
        body: 'wake up',
        lifecycle: 'wake',
      })!,
      'PRECONDITION_FAILED',
      `issue ${theirs.id} is outside your subtree; re-run with --outside-scope to confirm`,
    )
    expect(h.wakeSpawns).toEqual([])

    // Confirmed, the same send reaches the seam — proving the seam really is
    // behind this check and a spawn always required write access to the target.
    await h.gate.dispatch(h.agentCap(mine.id, asSessionId('sMine')), true, 'send', {
      to: theirs.id,
      body: 'wake up',
      lifecycle: 'wake',
    })
    expect(h.wakeSpawns).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// A3 — THE THREE ERROR CASES, verbatim. POD-728 must make the unknown id and
// the out-of-scope id INDISTINGUISHABLE (the consistent-error rule in §3.1.5):
// divergent errors make the send path an existence oracle. Today they differ,
// and this test records the divergence IN THE ASSERTION so the convergence is a
// deliberate, documented change rather than a silent one.
// ---------------------------------------------------------------------------

describe('characterization: unknown vs out-of-scope vs in-scope target (A3)', () => {
  it('DIVERGES today: an unknown id succeeds-then-dead-letters while an out-of-scope id throws PRECONDITION_FAILED', async () => {
    const h = mailHarness()
    const mine = h.createIssue({ title: 'mine' })
    const theirs = h.createIssue({ title: 'theirs' })
    h.put({ sessionId: asSessionId('sMine'), issueId: mine.id, phase: 'idle' })
    const cap = h.agentCap(mine.id, asSessionId('sMine2'))

    // (1) UNKNOWN id. `resolveRef` returns an unresolvable ref unchanged and
    // checkIssueAccess skips the scope gate for a target it cannot find, so the
    // send SUCCEEDS at the RPC layer and the message dead-letters at delivery.
    // No error, no code — the caller learns the id does not exist.
    const unknown = (await h.gate.dispatch(cap, undefined, 'send', {
      to: 'iss_does_not_exist',
      body: 'x',
    })) as { ok: boolean; disposition: string; reason?: string }
    expect(unknown).toMatchObject({
      ok: false,
      disposition: 'dead_letter',
      reason: 'dead-lettered: issue no longer exists',
    })
    // A nonexistent SEQ behaves the same way.
    const unknownSeq = (await h.gate.dispatch(cap, undefined, 'send', {
      to: '#99999',
      body: 'x',
    })) as { disposition: string }
    expect(unknownSeq.disposition).toBe('dead_letter')

    // (2) EXISTS but OUTSIDE the caller's scope: a throw that NAMES the issue id.
    let outOfScope: TRPCError | null = null
    try {
      await h.gate.dispatch(cap, undefined, 'send', { to: theirs.id, body: 'x' })
    } catch (e) {
      outOfScope = e as TRPCError
    }
    expect(outOfScope).toBeInstanceOf(TRPCError)
    expect({ code: outOfScope!.code, message: outOfScope!.message }).toEqual({
      code: 'PRECONDITION_FAILED',
      message: `issue ${theirs.id} is outside your subtree; re-run with --outside-scope to confirm`,
    })

    // (3) EXISTS and IN scope: plain success.
    const inScope = (await h.gate.dispatch(cap, undefined, 'send', {
      to: mine.id,
      body: 'x',
    })) as { ok: boolean }
    expect(inScope.ok).toBe(true)

    // THE DIVERGENCE ITSELF, asserted as today's behaviour: an unknown id and an
    // out-of-scope id are distinguishable, and the out-of-scope error even leaks
    // the internal issue id. POD-728 must collapse these two into one identical
    // response; when it does, THIS assertion is what has to change, on purpose.
    expect(typeof unknown.disposition).toBe('string')
    expect(outOfScope!.message).toContain(theirs.id)
  })

  it('never writes a legacy mirror row for an unresolvable ref (#463 belt-and-braces)', async () => {
    const h = mailHarness()
    const mine = h.createIssue({ title: 'mine' })
    const r = (await h.gate.dispatch(h.agentCap(mine.id, asSessionId('sMine')), undefined, 'send', {
      to: 'iss_nope',
      body: 'x',
    })) as { id: string }
    // The mirror insert would raise a raw SQLite FOREIGN KEY error; the guard
    // makes it an undeliverable message instead.
    expect(h.store.issues.getIssueMessage(r.id)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// A4 — INBOX SCOPE ARITHMETIC: three arms, and peek is NOT consume.
// ---------------------------------------------------------------------------

describe('characterization: inbox scope arithmetic — own consumes, in-scope peeks do not (A4)', () => {
  it('consumes only the caller’s OWN issue box', async () => {
    const h = mailHarness()
    const own = h.createIssue({ title: 'own' })
    h.svc.send({ kind: 'operator' }, { to: { kind: 'issue', id: own.id }, body: 'for you' })

    const rows = (await h.gate.dispatch(h.agentCap(own.id, asSessionId('sMe')), undefined, 'inbox', {
      issue: own.id,
    })) as { id: string; status: string }[]
    expect(rows.map((m) => m.status)).toEqual(['read'])
    expect(h.svc.message(rows[0]!.id)!).toMatchObject({ status: 'read', deliveredTo: 'sMe' })
  })

  it('returns a DESCENDANT issue’s box unfiltered but does NOT consume it (a peek is not a consume)', async () => {
    const h = mailHarness()
    const parent = h.createIssue({ title: 'parent' })
    const child = h.createIssue({ title: 'child', parentId: parent.id })
    // Traffic between two OTHER principals, in the child's box.
    const other = h.createIssue({ title: 'other' })
    const foreign = h.svc.send(
      { kind: 'agent', issueId: other.id, sessionId: asSessionId('sOther') },
      { to: { kind: 'issue', id: child.id }, body: 'not for the parent' },
    )

    const rows = (await h.gate.dispatch(h.agentCap(parent.id, asSessionId('sParent')), undefined, 'inbox', {
      issue: child.id,
    })) as { id: string; body: string; status: string }[]
    // In scope (the peeked issue's ancestors include the caller's subtree root):
    // the body comes back UNFILTERED even though the caller neither sent nor
    // received it. SINGLE-TENANT ARTEFACT — §3.1.5 revisits who may read whose
    // traffic once principals are people.
    expect(rows.map((m) => m.body)).toEqual(['not for the parent'])
    // And it is NOT consumed: still queued for its real recipient.
    expect(h.svc.message(foreign.message.id)!.status).toBe('queued')
    expect(rows[0]!.status).toBe('queued')
  })

  it('filters an OUT-OF-SCOPE peek down to rows the caller could mayView', async () => {
    const h = mailHarness()
    const mine = h.createIssue({ title: 'mine' })
    const unrelated = h.createIssue({ title: 'unrelated' })
    const third = h.createIssue({ title: 'third' })
    // (a) traffic between two other principals — invisible.
    h.svc.send(
      { kind: 'agent', issueId: third.id, sessionId: asSessionId('sThird') },
      { to: { kind: 'issue', id: unrelated.id }, body: 'private' },
    )
    // (b) something the caller itself SENT there — visible (the sender may re-read).
    const own = h.svc.send(
      { kind: 'agent', issueId: mine.id, sessionId: asSessionId('sMine') },
      { to: { kind: 'issue', id: unrelated.id }, body: 'mine to see' },
    )

    const rows = (await h.gate.dispatch(h.agentCap(mine.id, asSessionId('sMine')), undefined, 'inbox', {
      issue: unrelated.id,
    })) as { id: string; body: string }[]
    expect(rows.map((m) => m.body)).toEqual(['mine to see'])
    expect(rows[0]!.id).toBe(own.message.id)
    // A peek never consumes outside the caller's own box either.
    expect(h.svc.message(own.message.id)!.status).not.toBe('read')
  })

  it('consumes the caller’s OWN principals on a bare inbox, and refuses a caller with no mailbox', async () => {
    const h = mailHarness()
    const mine = h.createIssue({ title: 'mine' })
    h.svc.send({ kind: 'operator' }, { to: { kind: 'issue', id: mine.id }, body: 'issue mail' })
    const rows = (await h.gate.dispatch(h.agentCap(mine.id, asSessionId('sMe')), undefined, 'inbox', {})) as {
      status: string
    }[]
    expect(rows.map((m) => m.status)).toEqual(['read'])

    const noMailbox: Capability = {
      role: 'worker',
      scope: { kind: 'none' },
      actorUser: FIRST_ADMIN_USER_ID,
      onBehalfOf: FIRST_ADMIN_USER_ID,
    }
    await expect(h.gate.dispatch(noMailbox, undefined, 'inbox', {})).rejects.toThrow(
      'no mailbox bound to this caller',
    )
  })
})

// ---------------------------------------------------------------------------
// A5 — the read surfaces' authz: show / status / reply / dismiss / ledger.
// ---------------------------------------------------------------------------

describe('characterization: read-surface and reply authz (A5)', () => {
  // EDITED BY POD-728, and this pin anticipated the edit: it read "POD-728
  // reclassifies this (own traffic for a member, cross-user at admin grade) —
  // this pin is what proves the reclassification happened."
  //
  // THE DECISION IT IMPLEMENTS: `mail.ledger`'s exposure classification in
  // packages/commands/src/mail/contracts.ts. `operator` was one person when
  // "operator surface" was written; readiness §3.2 requires every role-level
  // attribution to name a person, so the gate splits along ADR 3 Amendment 1
  // D15's line — the role floor says a member may ATTEMPT the query, the row
  // gate says which rows come back. It stays a QUERY either way.
  it('gives a member their OWN ledger traffic and reserves cross-user rows for admin grade', async () => {
    const h = mailHarness()
    const mine = h.createIssue({ title: 'mine' })
    const theirs = h.createIssue({ title: 'theirs' })
    h.svc.send({ kind: 'operator' }, { to: { kind: 'issue', id: mine.id }, body: 'x' })
    // THE COUNTERFACTUAL: traffic in a box the member is not a party to. Without
    // this row the filtered result and the unfiltered one are the same list and
    // the assertion below would pass on a ledger that filtered nothing.
    h.svc.send({ kind: 'operator' }, { to: { kind: 'issue', id: theirs.id }, body: 'not yours' })

    const member = h.agentCap(mine.id, asSessionId('sMe'))
    // No longer a refusal: a member may read the ledger, and gets their own row.
    const own = (await h.gate.dispatch(member, undefined, 'ledger', {
      issueId: mine.id,
    })) as { body: string }[]
    expect(own.map((r) => r.body)).toEqual(['x'])

    // The other issue's traffic is NOT theirs to read, and the refusal is an
    // empty page rather than an error — a distinguishable refusal would confirm
    // that the issue exists (the contract's errorConsistency clause).
    expect(await h.gate.dispatch(member, undefined, 'ledger', { issueId: theirs.id })).toEqual([])
    // ADMIN GRADE gets the cross-user projection: the SAME query, a row back.
    // This is the counterfactual — without it, "member sees []" would also pass
    // against a ledger that returned nothing to anyone.
    const cross = (await h.gate.dispatch(OPERATOR, undefined, 'ledger', {
      issueId: theirs.id,
    })) as { body: string }[]
    expect(cross.map((r) => r.body)).toEqual(['not yours'])

    // An UNFILTERED ledger query still returns nothing at all — "no filter" is
    // not "everything", so there is no accidental firehose behind either grade.
    expect(await h.gate.dispatch(OPERATOR, undefined, 'ledger', {})).toEqual([])
    expect(await h.gate.dispatch(member, undefined, 'ledger', {})).toEqual([])
    const rows = (await h.gate.dispatch(OPERATOR, undefined, 'ledger', {
      issueId: mine.id,
    })) as unknown[]
    expect(rows).toHaveLength(1)
  })

  it('lets only the recipient (or the operator) reply, and never consumes queued status on show', async () => {
    const h = mailHarness()
    const from = h.createIssue({ title: 'from' })
    const to = h.createIssue({ title: 'to' })
    const bystander = h.createIssue({ title: 'bystander' })
    h.put({ sessionId: asSessionId('sFrom'), issueId: from.id, phase: 'idle' })
    h.put({ sessionId: asSessionId('sTo'), issueId: to.id, phase: 'idle' })
    const original = h.svc.send(
      { kind: 'agent', issueId: from.id, sessionId: asSessionId('sFrom') },
      { to: { kind: 'session', id: 'sTo' }, body: 'q', urgency: 'next-turn' },
    )
    const oid = original.message.id

    await expect(
      h.gate.dispatch(h.agentCap(bystander.id, asSessionId('sBy')), undefined, 'reply', { id: oid, body: 'no' }),
    ).rejects.toThrow('only the recipient of a message may reply to it')
    await expect(
      h.gate.dispatch(h.agentCap(bystander.id, asSessionId('sBy')), undefined, 'show', { id: oid }),
    ).rejects.toThrow('not allowed to view a message you neither sent nor received')
    await expect(
      h.gate.dispatch(h.agentCap(bystander.id, asSessionId('sBy')), undefined, 'dismiss', { id: oid }),
    ).rejects.toThrow('only the recipient of a message may dismiss it')
    await expect(h.gate.dispatch(OPERATOR, undefined, 'show', { id: 'msg_nope' })).rejects.toThrow(
      'unknown message msg_nope',
    )

    // `show` is a pure read: the SENDER may re-read what it sent, and neither
    // read consumes the row.
    const shown = (await h.gate.dispatch(h.agentCap(from.id, asSessionId('sFrom')), undefined, 'show', {
      id: oid,
    })) as { status: string }
    expect(shown.status).toBe('queued')
    expect(h.svc.message(oid)!.status).toBe('queued')

    // The recipient may reply; so may the operator.
    expect(
      (
        (await h.gate.dispatch(h.agentCap(to.id, asSessionId('sTo')), undefined, 'reply', {
          id: oid,
          body: 'yes',
        })) as { ok: boolean }
      ).ok,
    ).toBe(true)
  })

  it('dismisses a recipient-owned message straight to `read` without opening the inbox', async () => {
    const h = mailHarness()
    const to = h.createIssue({ title: 'to' })
    h.put({ sessionId: asSessionId('sTo'), issueId: to.id, phase: 'idle' })
    const r = h.svc.send({ kind: 'operator' }, { to: { kind: 'issue', id: to.id }, body: 'x' })
    const wire = (await h.gate.dispatch(h.agentCap(to.id, asSessionId('sTo')), undefined, 'dismiss', {
      id: r.message.id,
    })) as { status: string; readAt: string | null }
    expect(wire.status).toBe('read')
    expect(wire.readAt).toBe(h.now())
  })

  it('returns pendingReminders only for the CALLING session, and nothing for a session-less caller', async () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: 's1' }, body: 'answer me', expectsResponse: true },
    )
    expect(await h.gate.dispatch(OPERATOR, undefined, 'pendingReminders', {})).toEqual([])
    expect(
      await h.gate.dispatch(h.agentCap(iss.id, asSessionId('s1')), undefined, 'pendingReminders', {}),
    ).toEqual([{ id: expect.any(String), from: 'operator', body: 'answer me' }])
  })
})

// ---------------------------------------------------------------------------
// A6 — THE OPERATOR PRINCIPAL CLASS, end to end. POD-728 dissolves this class
// into named people, and every behaviour below is a decision point: which of
// them survives per-user? Each is pinned as its own assertion so the answer
// shows up in the diff.
// ---------------------------------------------------------------------------

describe('characterization: the operator principal class (A6)', () => {
  it('is exempt from the wake cooldown, and the sweep does not brake it either', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'sleeper' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, status: 'hibernated' })
    const to = { kind: 'session' as const, id: 's1' }

    // Three wakes back to back, no clock movement: all keep `wake`. An agent
    // sender would be clamped on the second (see the D5 cooldown pin).
    for (const body of ['1', '2', '3']) {
      const r = h.svc.send({ kind: 'operator' }, { to, body, lifecycle: 'wake' })
      expect(r.message.lifecycle).toBe('wake')
      expect(r.message.clampedFrom).toBeNull()
    }
    // recordWake RETURNS EARLY for an operator: no durable cooldown row is
    // written at all. The key also shows senderKey collapsing every operator to
    // the literal string 'operator' (see the senderKey pin below).
    expect(h.store.messages.getWakeCooldown(`operator|${iss.id}`)).toBeNull()

    // And the sweep does not brake an operator wake: a still-queued operator
    // wake is re-attempted whatever the cooldown window says.
    h.transport.ok = false
    const queuedWake = h.svc.send({ kind: 'operator' }, { to, body: '4', lifecycle: 'wake' })
    const before = h.pushes.length
    h.svc.sweep()
    expect(h.pushes.length).toBeGreaterThan(before)
    expect(h.svc.message(queuedWake.message.id)!.status).toBe('queued')
  })

  it('renders the labels as "the operator" on both sides', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    // fromLabel: only reachable through the ONE framed operator case, a question.
    const q = h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: 's1' }, body: 'q', kind: 'question' },
    )
    expect(h.pushes[0]!.text).toContain('· from the operator · to your session ·')
    expect(q.message.kind).toBe('question')

    // toLabel: an operator-ADDRESSED row is never pushed (see the queueing pin),
    // so render it directly — the label is "the operator".
    const escalation = h.svc.send(
      { kind: 'agent', issueId: iss.id, sessionId: asSessionId('s1') },
      { to: { kind: 'operator' }, body: 'help' },
    )
    expect(h.svc.renderFor(escalation.message)).toBe(
      `[podium message ${escalation.message.id} · from issue:#${iss.seq} · to the operator · ` +
        `reply: podium mail reply ${escalation.message.id}]\nhelp\n` +
        `[end podium message ${escalation.message.id}]`,
    )
  })

  it('keeps a toKind:operator row queued for UI pickup, skipped by both attemptDelivery and the sweep', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'escalating' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    const r = h.svc.send(
      { kind: 'agent', issueId: iss.id, sessionId: asSessionId('s1') },
      { to: { kind: 'operator' }, body: 'human, please look' },
    )
    // Its "delivery" is the operator reading their inbox, not a black hole.
    expect(r).toMatchObject({ ok: true, queued: true, disposition: 'queued' })
    expect(h.pushes).toEqual([])
    h.advance(WAKE_COOLDOWN_MS * 10)
    h.svc.sweep()
    expect(h.pushes).toEqual([])
    expect(h.svc.message(r.message.id)!.status).toBe('queued')
    // An inbox read does NOT consume an operator-addressed row either.
    h.svc.readInbox([{ kind: 'operator' }], { consume: null })
    expect(h.svc.message(r.message.id)!.status).toBe('queued')
  })

  it('falls back to kind operator in replyTarget for superagent, operator and system senders', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    const rows: MessageRow[] = (['superagent', 'operator', 'system'] as const).map(
      (fromKind) =>
        h.svc.send(
          fromKind === 'system' ? { kind: 'system', name: 'steward' } : { kind: fromKind },
          { to: { kind: 'issue', id: iss.id }, body: fromKind },
        ).message,
    )
    for (const row of rows) {
      // SINGLE-OPERATOR ARTEFACT: every non-agent sender's replies land in the
      // ONE operator box. §3.1.6 S1/S2/S3 make the superagent and attention
      // routing per-user, so POD-728 must decide whose box these go to.
      expect(h.svc.replyTarget(row)).toEqual({ kind: 'operator' })
    }
  })

  it('keys superagent cooldowns by their accountable user', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'sleeper' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, status: 'hibernated' })
    const to = { kind: 'session' as const, id: 's1' }

    const first = h.svc.send({ kind: 'superagent' }, { to, body: '1', lifecycle: 'wake' })
    expect(first.message.lifecycle).toBe('wake')
    // Superagent automation is private per owner, so its unattended-wake brake
    // is keyed by that accountable user rather than shared across the instance.
    expect(h.store.messages.getWakeCooldown(`superagent:${FIRST_ADMIN_USER_ID}|${iss.id}`)).toBe(h.now())
    const second = h.svc.send({ kind: 'superagent' }, { to, body: '2', lifecycle: 'wake' })
    expect(second.message.lifecycle).toBe('wait')
    expect(JSON.parse(second.message.clampedFrom!).reasons).toEqual([
      'wake cooldown (1 per 10min per sender+issue)',
    ])
    // An agent sender, by contrast, is keyed per session.
    expect(h.store.messages.getWakeCooldown(`agent:s1|${iss.id}`)).toBeNull()
  })

  it('collapses every operator to one principal for the responds-to-request check', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'target' })
    h.put({ sessionId: asSessionId('s1'), issueId: iss.id, phase: 'idle' })
    // An operator asks for a response...
    const asked = h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'session', id: 's1' }, body: 'reply please', expectsResponse: true },
    )
    // ... and "another" operator replies in-thread. senderKey collapses BOTH to
    // the literal string 'operator', so this reads as the requester answering
    // its own request and does NOT satisfy it. SINGLE-OPERATOR ARTEFACT: with
    // named people (§3.2 attribution) these are two different principals and one
    // of them genuinely IS the answer.
    h.svc.send(
      { kind: 'operator' },
      {
        to: { kind: 'session', id: 's1' },
        kind: 'message',
        inReplyTo: asked.message.id,
        body: 'answering as a different human',
      },
    )
    expect(h.svc.message(asked.message.id)!.ackedBy).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// A7 — the LEGACY RAW REF reply regression class (POD-463): rows migrated by
// 016 hold `issue:#N` in from_issue. A reply must resolve it, and must never
// hand an unresolvable ref to the issue_messages mirror's foreign key.
// ---------------------------------------------------------------------------

describe('characterization: reply to a legacy raw-ref sender (A7, POD-463)', () => {
  const legacyRow = (
    h: ReturnType<typeof mailHarness>,
    fromIssue: string,
    fromSession: string | null,
  ): MessageRow => {
    const row: MessageRow = {
      id: `msg_legacy_${fromIssue.replace(/\W/g, '')}_${fromSession ?? 'none'}`,
      threadId: 'thr_legacy',
      inReplyTo: null,
      fromKind: 'agent',
      fromSession: fromSession === null ? null : asSessionId(fromSession),
      fromName: null,
      // The migrated shape: a REF STRING where an id belongs.
      fromIssue: asIssueId(fromIssue),
      toKind: 'operator',
      toId: null,
      kind: 'message',
      urgency: 'fyi',
      lifecycle: 'wait',
      body: 'from the old world',
      expiresAt: null,
      createdAt: h.now(),
      status: 'queued',
      deliveredAt: null,
      deliveredTo: null,
      ackedBy: null,
      hop: 0,
      clampedFrom: null,
      remindedAt: null,
      factKey: null,
      factTarget: null,
      expectsResponse: false,
    }
    h.store.messages.addMessage(row)
    return row
  }

  it('resolves a legacy `issue:#N` sender ref to the real issue and mirrors under the real id', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'legacy sender' })
    const original = legacyRow(h, `issue:#${iss.seq}`, null)
    expect(h.svc.replyTarget(original)).toEqual({ kind: 'issue', id: iss.id })

    const reply = h.svc.sendReply({ kind: 'operator' }, { inReplyTo: original.id, body: 'ack' })
    expect(reply.message.toId).toBe(iss.id)
    // The legacy mirror row is written under the RESOLVED id, not the ref string.
    expect(h.store.issues.getIssueMessage(reply.message.id)).toMatchObject({ issueId: iss.id })
  })

  it('falls through to the sender SESSION when the legacy ref does not resolve', () => {
    const h = mailHarness()
    h.put({ sessionId: asSessionId('sLegacy'), cwd: '/elsewhere', phase: 'idle' })
    // A ref no issue owns. Anything that doesn't resolve must NOT reach the FK.
    const original = legacyRow(h, 'issue:#99999', 'sLegacy')
    expect(h.svc.replyTarget(original)).toEqual({ kind: 'session', id: 'sLegacy' })
    const reply = h.svc.sendReply({ kind: 'operator' }, { inReplyTo: original.id, body: 'ack' })
    expect(reply.message).toMatchObject({ toKind: 'session', toId: 'sLegacy' })
    // Session-addressed: no mirror row at all, so no FK to violate.
    expect(h.store.issues.getIssueMessage(reply.message.id)).toBeNull()
  })

  it('falls back to the operator box when an unresolvable ref has no session either', () => {
    const h = mailHarness()
    const original = legacyRow(h, 'issue:#99999', null)
    expect(h.svc.replyTarget(original)).toEqual({ kind: 'operator' })
    // The reply lands in the operator box instead of raising a raw SQLite
    // FOREIGN KEY error out of the mirror insert (#463).
    const reply = h.svc.sendReply({ kind: 'operator' }, { inReplyTo: original.id, body: 'ack' })
    expect(reply.message.toKind).toBe('operator')
    expect(h.store.issues.getIssueMessage(reply.message.id)).toBeNull()
  })

  it('prefers a LIVE sender session over the sender issue, and the issue once that session is gone', () => {
    const h = mailHarness()
    const iss = h.createIssue({ title: 'sender issue' })
    h.put({ sessionId: asSessionId('sAlive'), issueId: iss.id, phase: 'idle' })
    const original = legacyRow(h, `issue:#${iss.seq}`, 'sAlive')
    expect(h.svc.replyTarget(original)).toEqual({ kind: 'session', id: 'sAlive' })
    h.sessions.length = 0
    expect(h.svc.replyTarget(original)).toEqual({ kind: 'issue', id: iss.id })
  })
})
