/**
 * THE MULTI-USER PROPERTIES the contracts declare (POD-728).
 *
 * POD-727's suites pin what mail DOES today; this file proves the properties the
 * contracts add: the human ceiling, the consistent-error rule, apply-time
 * re-authorization of a queued send, and the machine `use` boundary.
 *
 * Each suite states the instrument check it needs to be believed. A ceiling test
 * that only ever denies, or a placement test that only ever refuses, is a
 * refusal-only instrument: it looks identical whether the mechanism works or the
 * fixture is broken. So every denial here is paired with the SAME call
 * succeeding under a ceiling that allows it.
 */

import { asSessionId } from '@podium/model'
import type { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import type { Capability } from '../../issue-authz'
import { mailHarness, OPERATOR } from './characterization-support'
import { applyAuthFromCeiling } from './handlers/context'

/** A ceiling that hides exactly the named issue ids from the delegating human. */
const ceilingHiding = (hidden: () => string[]) => ({
  canSee: (e: { kind: 'issue' | 'session'; id: string }) => !hidden().includes(e.id),
})

// ---------------------------------------------------------------------------
// The human ceiling (readiness §3.1.5 / ADR 3 Amendment 1 D20.2)
// ---------------------------------------------------------------------------

describe('the human ceiling bounds addressing — not the agent’s own scope', () => {
  it('lets an agent address OUTSIDE its subtree but INSIDE its human’s visibility, through the confirmation path', async () => {
    const hidden: string[] = []
    const ceiling = ceilingHiding(() => hidden)
    const h = mailHarness({ ceiling, authorizeAtApply: applyAuthFromCeiling(ceiling) })
    const mine = h.createIssue({ title: 'mine' })
    const theirs = h.createIssue({ title: 'theirs' })
    h.put({ sessionId: asSessionId('sTheirs'), issueId: theirs.id, phase: 'idle' })
    const cap = h.agentCap(mine.id, 'sMine')

    // Without the confirmation it is a WIDENING, not a denial: an issue the
    // human can see, outside the agent's own subtree, answers confirm-required
    // and NAMES its target — which is safe precisely because the human can
    // already see it. D20.1 ratifies this shape rather than collapsing it.
    await expect(
      h.gate.dispatch(cap, undefined, 'send', { to: theirs.id, body: 'x' }),
    ).rejects.toThrow(/outside your subtree; re-run with --outside-scope/)

    // With it, the send goes through — today's cross-issue coordination path,
    // preserved.
    const ok = (await h.gate.dispatch(cap, true, 'send', { to: theirs.id, body: 'x' })) as {
      ok: boolean
      disposition: string
    }
    expect(ok.ok).toBe(true)
    expect(ok.disposition).not.toBe('dead_letter')
  })

  it('denies the SAME send once the target is beyond the human ceiling', async () => {
    const hidden: string[] = []
    const ceiling = ceilingHiding(() => hidden)
    const h = mailHarness({ ceiling, authorizeAtApply: applyAuthFromCeiling(ceiling) })
    const mine = h.createIssue({ title: 'mine' })
    const theirs = h.createIssue({ title: 'theirs' })
    h.put({ sessionId: asSessionId('sTheirs'), issueId: theirs.id, phase: 'idle' })
    const cap = h.agentCap(mine.id, 'sMine')

    // Raise the ceiling against it. The capability, the confirmation and the
    // target are all UNCHANGED from the passing case above — the only thing
    // that moved is what the human can see.
    hidden.push(theirs.id)
    const denied = (await h.gate.dispatch(cap, true, 'send', { to: theirs.id, body: 'x' })) as {
      ok: boolean
      disposition: string
      reason?: string
    }
    expect(denied.ok).toBe(false)
    expect(denied.disposition).toBe('dead_letter')
    // And nothing landed in the invisible issue's mailbox: the apply-time gate
    // runs before the legacy mirror write, so a caller supplying the literal
    // internal id cannot inject a row into a workspace it cannot see.
    expect(h.store.issues.listIssueMessages(theirs.id)).toEqual([])
  })

  it('the beyond-ceiling denial is INDISTINGUISHABLE from the unknown-id error', async () => {
    const hidden: string[] = []
    const ceiling = ceilingHiding(() => hidden)
    const h = mailHarness({ ceiling, authorizeAtApply: applyAuthFromCeiling(ceiling) })
    const mine = h.createIssue({ title: 'mine' })
    const theirs = h.createIssue({ title: 'theirs' })
    hidden.push(theirs.id)
    const cap = h.agentCap(mine.id, 'sMine')

    const shape = async (to: string, override: boolean | undefined): Promise<unknown> => {
      try {
        const r = (await h.gate.dispatch(cap, override, 'send', { to, body: 'x' })) as Record<
          string,
          unknown
        >
        // Everything except the per-row id, which differs for any two sends.
        const { id: _id, ...rest } = r
        return { threw: false, ...rest }
      } catch (e) {
        return { threw: true, code: (e as TRPCError).code, message: (e as Error).message }
      }
    }

    // BOTH override values, because they exercise different code. WITHOUT the
    // confirmation is the sharp one: an invisible id that still resolved would
    // reach checkIssueAccess against a REAL target and answer confirm-required,
    // naming the issue — which is the existence oracle D20 forbids. The gate's
    // re-addressing branch is what stops that, and only this arm exercises it.
    for (const override of [undefined, true] as const) {
      const unknown = await shape('iss_does_not_exist', override)
      const beyondCeiling = await shape(theirs.id, override)
      expect(beyondCeiling).toEqual(unknown)
      // The instrument check: the comparison would also pass if BOTH calls threw
      // the same generic error, so pin the shape they actually converged on.
      expect(unknown).toMatchObject({
        threw: false,
        ok: false,
        disposition: 'dead_letter',
        reason: 'dead-lettered: issue no longer exists',
      })
    }
  })

  it('a peek at an invisible issue’s inbox is EMPTY — the same answer a nonexistent issue gives', async () => {
    const hidden: string[] = []
    const ceiling = ceilingHiding(() => hidden)
    const h = mailHarness({ ceiling, authorizeAtApply: applyAuthFromCeiling(ceiling) })
    const mine = h.createIssue({ title: 'mine' })
    const theirs = h.createIssue({ title: 'theirs' })
    const cap = h.agentCap(mine.id, 'sMine')
    // A row this agent may `mayView` in the OTHER issue's box — one it sent
    // itself. Without it the peek returns [] for mayView reasons and the test
    // would pass whether or not the ceiling was ever consulted (the read path
    // has no delivery step, so nothing else would catch it).
    h.svc.send(
      { kind: 'agent', issueId: mine.id, sessionId: asSessionId('sMine') },
      { to: { kind: 'issue', id: theirs.id }, body: 'mine to see' },
    )

    // THE INSTRUMENT SAYS YES FIRST: under a ceiling that allows, the peek
    // genuinely returns the row.
    const visible = (await h.gate.dispatch(cap, undefined, 'inbox', {
      issue: theirs.id,
    })) as { body: string }[]
    expect(visible.map((r) => r.body)).toEqual(['mine to see'])

    // Raise the ceiling: the SAME peek is empty…
    hidden.push(theirs.id)
    const invisible = await h.gate.dispatch(cap, undefined, 'inbox', { issue: theirs.id })
    expect(invisible).toEqual([])
    // …and empty is exactly what a nonexistent issue answers, so the filtered
    // path cannot be used as an existence oracle either.
    expect(await h.gate.dispatch(cap, undefined, 'inbox', { issue: 'iss_nope' })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Apply-time re-authorization of a QUEUED send (ADR 3 D8 / Amendment 1 D16)
// ---------------------------------------------------------------------------

describe('a queued send is re-authorized at the drain, not at accept', () => {
  it('rejects and SURFACES a send whose principal lost access while it sat queued', () => {
    let revoked = false
    const h = mailHarness({
      authorizeAtApply: () =>
        revoked
          ? // A sender who HAD access and lost it may be told so: they already
            // knew the target existed, so nothing new leaks. That is a different
            // case from the beyond-ceiling one above, and deliberately worded
            // differently.
            { ok: false, reason: 'sender no longer has access to the target' }
          : { ok: true },
    })
    const target = h.createIssue({ title: 'target' })
    const sender = h.createIssue({ title: 'sender' })
    h.put({ sessionId: asSessionId('sSender'), issueId: sender.id, phase: 'idle' })
    // No live session on the target, so the row is ACCEPTED and stays queued —
    // which is the state the whole re-authorization rule is about.
    const r = h.svc.send(
      { kind: 'agent', issueId: sender.id, sessionId: asSessionId('sSender') },
      { to: { kind: 'issue', id: target.id }, body: 'work please' },
    )
    expect(r.disposition).toBe('held')
    expect(h.svc.message(r.message.id)?.status).toBe('queued')

    // Access is revoked BETWEEN accept and drain.
    revoked = true
    h.put({ sessionId: asSessionId('sTarget'), issueId: target.id, phase: 'idle' })
    h.svc.sweep()

    const after = h.svc.message(r.message.id)
    // REJECTED at apply: never applied…
    expect(after?.status).toBe('dead_letter')
    expect(h.pushes.filter((p) => p.sessionId === 'sTarget')).toEqual([])
    // …and never silently dropped — the sender is told (ADR 3 D9).
    const notices = h.svc
      .inbox([{ kind: 'session', id: 'sSender' }], { limit: 50 })
      .filter((m) => m.body.includes(r.message.id))
    expect(notices.length).toBeGreaterThan(0)
    expect(notices.at(-1)?.body).toContain('sender no longer has access to the target')
  })

  it('refuses the LEGACY MIRROR write too, for a sender that never passed the gate', () => {
    // Defence in depth, and it is not redundant: the gate's address resolution
    // protects callers that COME THROUGH the gate, but the substrate has
    // internal senders that call `send()` directly with a real issue id — the
    // spawn-on-wake seam, the superagent, system notices. For those the
    // apply-time gate is the only thing standing between an unauthorized sender
    // and a row in the target's legacy mailbox, and a mirror row is visible
    // there whether or not delivery ever succeeds.
    let allowed = true
    const h = mailHarness({
      authorizeAtApply: () =>
        allowed ? { ok: true } : { ok: false, reason: 'issue no longer exists' },
    })
    const target = h.createIssue({ title: 'target' })
    const sender = h.createIssue({ title: 'sender' })

    // THE INSTRUMENT SAYS YES FIRST: allowed, the mirror row IS written.
    const ok = h.svc.send(
      { kind: 'agent', issueId: sender.id, sessionId: asSessionId('sSender') },
      { to: { kind: 'issue', id: target.id }, body: 'legitimate' },
    )
    expect(h.store.issues.getIssueMessage(ok.message.id)).not.toBeNull()

    allowed = false
    const denied = h.svc.send(
      { kind: 'agent', issueId: sender.id, sessionId: asSessionId('sSender') },
      { to: { kind: 'issue', id: target.id }, body: 'injected' },
    )
    expect(h.store.issues.getIssueMessage(denied.message.id)).toBeNull()
    expect(h.store.issues.listIssueMessages(target.id).map((m) => m.body)).toEqual(['legitimate'])
  })

  it('delivers the same message when access was NOT revoked — the instrument can say yes', () => {
    const h = mailHarness({ authorizeAtApply: () => ({ ok: true }) })
    const target = h.createIssue({ title: 'target' })
    const sender = h.createIssue({ title: 'sender' })
    h.put({ sessionId: asSessionId('sSender'), issueId: sender.id, phase: 'idle' })
    const r = h.svc.send(
      { kind: 'agent', issueId: sender.id, sessionId: asSessionId('sSender') },
      { to: { kind: 'issue', id: target.id }, body: 'work please' },
    )
    h.put({ sessionId: asSessionId('sTarget'), issueId: target.id, phase: 'idle' })
    h.svc.sweep()
    expect(h.svc.message(r.message.id)?.status).not.toBe('dead_letter')
    expect(h.pushes.filter((p) => p.sessionId === 'sTarget').length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Machine placement (readiness §3.1.4 M1/M5/M6)
// ---------------------------------------------------------------------------

describe('spawnAgent places work on OWNED COMPUTE and fails closed', () => {
  const machines = (opts: { use: boolean; reachable: boolean }) => ({
    mayUse: () => opts.use,
    isReachable: () => opts.reachable,
  })

  const withMachine = (h: ReturnType<typeof mailHarness>): { id: string; seq: number } => {
    const issue = h.createIssue({ title: 'work' })
    h.issues.update(issue.id, { machineId: 'mac_alices_laptop' })
    return issue
  }

  it('denies a spawn onto a machine the effective principal may not USE', async () => {
    const h = mailHarness({ machines: machines({ use: false, reachable: true }) })
    const issue = withMachine(h)
    await expect(
      h.gate.dispatch(h.agentCap(issue.id, 'sMe'), undefined, 'spawnAgent', {
        issue: issue.id,
        prompt: 'go',
      }),
    ).rejects.toThrow(/not allowed to run agents on machine mac_alices_laptop/)
    // Never silently retargeted: no session was created anywhere.
    expect(h.gateSpawns).toEqual([])
  })

  it('keeps UNAUTHORIZED distinguishable from UNREACHABLE — the deliberate opposite of the address rule', async () => {
    const denied = mailHarness({ machines: machines({ use: false, reachable: true }) })
    const offline = mailHarness({ machines: machines({ use: true, reachable: false }) })
    const a = withMachine(denied)
    const b = withMachine(offline)
    const message = async (h: ReturnType<typeof mailHarness>, id: string): Promise<string> => {
      try {
        await h.gate.dispatch(h.agentCap(id, 'sMe'), undefined, 'spawnAgent', {
          issue: id,
          prompt: 'go',
        })
        return 'no error'
      } catch (e) {
        return (e as Error).message
      }
    }
    const unauthorized = await message(denied, a.id)
    const unreachable = await message(offline, b.id)
    expect(unauthorized).not.toBe(unreachable)
    expect(unauthorized).toMatch(/grant you 'use'/)
    expect(unreachable).toMatch(/not reachable right now/)
  })

  it('spawns when the principal holds `use` — the instrument can say yes', async () => {
    const h = mailHarness({ machines: machines({ use: true, reachable: true }) })
    const issue = withMachine(h)
    const r = (await h.gate.dispatch(h.agentCap(issue.id, 'sMe'), undefined, 'spawnAgent', {
      issue: issue.id,
      prompt: 'go',
    })) as { ok: boolean; machine: string | null }
    expect(r.ok).toBe(true)
    expect(h.gateSpawns).toHaveLength(1)
    expect(h.gateSpawns[0]?.machineId).toBe('mac_alices_laptop')
  })
})

// ---------------------------------------------------------------------------
// Sender identity — ADR 3 D7, both halves of the pair
// ---------------------------------------------------------------------------

describe('sender identity is stamped from the capability and cannot be influenced from payload', () => {
  /** Every field a caller might hope contributes to `from`, on one send. */
  const IMPERSONATION_PAYLOAD = {
    from: 'operator',
    fromKind: 'operator',
    fromIssue: 'iss_someone_else',
    fromSession: 'sSomeoneElse',
    fromName: 'steward',
    sender: { kind: 'operator' },
    // The on-behalf-of half — the new one. ADR 3 Amendment 1 D14.3: it is
    // resolved from the delegation reference, never from a payload string.
    onBehalfOf: 'usr_someone_else',
    actor: 'usr_someone_else',
    actorSessionId: 'sSomeoneElse',
    capability: { role: 'admin', scope: { kind: 'all' } },
  }

  it('ignores every impersonation field on `send`', async () => {
    const h = mailHarness()
    const mine = h.createIssue({ title: 'mine' })
    const cap: Capability = h.agentCap(mine.id, 'sMine')
    const r = (await h.gate.dispatch(cap, undefined, 'send', {
      to: mine.id,
      body: 'x',
      ...IMPERSONATION_PAYLOAD,
    })) as { id: string }
    const row = h.svc.message(r.id)
    expect(row?.fromKind).toBe('agent')
    expect(row?.fromIssue).toBe(mine.id)
    expect(row?.fromSession).toBe('sMine')
    expect(row?.fromName ?? null).toBeNull()
  })

  it('ignores them on `reply` too — the second write surface', async () => {
    const h = mailHarness()
    const mine = h.createIssue({ title: 'mine' })
    h.put({ sessionId: asSessionId('sMine'), issueId: mine.id, phase: 'idle' })
    const original = h.svc.send(
      { kind: 'operator' },
      { to: { kind: 'issue', id: mine.id }, body: 'ping' },
    )
    const r = (await h.gate.dispatch(h.agentCap(mine.id, 'sMine'), undefined, 'reply', {
      id: original.message.id,
      body: 'pong',
      ...IMPERSONATION_PAYLOAD,
    })) as { id: string }
    const row = h.svc.message(r.id)
    expect(row?.fromKind).toBe('agent')
    expect(row?.fromIssue).toBe(mine.id)
    expect(row?.fromSession).toBe('sMine')
  })

  it('the CAPABILITY still decides — the counterfactual that proves the assertion is not vacuous', async () => {
    // Same payload, a different capability: the stamped sender MOVES. Without
    // this, "fromKind is agent" would pass against a surface that hard-coded it.
    const h = mailHarness()
    const mine = h.createIssue({ title: 'mine' })
    h.put({ sessionId: asSessionId('sMine'), issueId: mine.id, phase: 'idle' })
    const r = (await h.gate.dispatch(OPERATOR, undefined, 'send', {
      to: mine.id,
      body: 'x',
      ...IMPERSONATION_PAYLOAD,
      fromKind: 'agent',
      fromIssue: mine.id,
    })) as { id: string }
    expect(h.svc.message(r.id)?.fromKind).toBe('operator')
  })
})
