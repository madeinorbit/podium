/**
 * THE CUTOVER'S OWN PROPERTIES (POD-729) — the four claims the deletion makes,
 * each asserted against the thing that actually decides it.
 *
 *  1. The messages router has NO hand-written procedure left (the POD-424 gate
 *     criterion). Asserted against the router's SOURCE TEXT, because that is
 *     what a person edits: a runtime check of the built router would happily
 *     pass on a tenth procedure someone adds by hand next year.
 *  2. No call path reaches message DELIVERY without the contract's policy —
 *     also a source audit, with an explicit allowlist, so a new bypass is a
 *     failing test rather than a thing a reviewer has to notice.
 *  3. Both transports run the SAME authz path. Proven by replaying POD-728's
 *     ceiling and consistent-error scenarios over each transport tag and
 *     comparing the ANSWERS, not by reading two call sites and agreeing they
 *     look alike.
 *  4. The apply-time ceiling and the resolution-time ceiling are one object,
 *     and a composition root that gets that wrong fails at BOOT.
 *
 * On instruments: every audit here is paired with a count, and every refusal
 * with the same call succeeding. A grep that matched nothing and a grep whose
 * pattern is wrong produce the same green.
 */

import { asSessionId } from '@podium/model'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { TransportTag } from '@podium/commands'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeOracles, makeOracle, ptyFrames, waitFor } from '../sessions/oracle-support'
import { mailHarness, OPERATOR } from './characterization-support'
import { mailPolicy } from './handlers/context'
import { MAIL_COMMANDS } from './registry'

afterEach(() => disposeOracles())

const sourceOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

// ---------------------------------------------------------------------------
// 1. The POD-424 gate criterion, over the router's source
// ---------------------------------------------------------------------------

/** The body of `messages: t.router({ … })` in router.ts, brace-matched. */
function messagesRouterBlock(): string {
  const src = sourceOf('../../router.ts')
  const start = src.indexOf('messages: t.router({')
  expect(start).toBeGreaterThan(-1)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('messages router block is unbalanced')
}

describe('POD-424 gate: the messages router is DERIVED, not hand-written', () => {
  /** Every `<key>: mail(Query|Mutation)('<proc>'),` line in the messages block. */
  function derivedProcs(): { key: string; verb: 'query' | 'mutation'; proc: string }[] {
    const block = messagesRouterBlock()
    return [...block.matchAll(/^\s{4}(\w+): mail(Query|Mutation)\('(\w+)'\),$/gm)].map((m) => ({
      key: m[1] as string,
      verb: m[2] === 'Query' ? 'query' : 'mutation',
      proc: m[3] as string,
    }))
  }

  it('declares every procedure through the derivation helpers and none by hand', () => {
    // The instrument says YES first: if this extraction were wrong (an empty
    // slice, a block that stopped at the first nested brace) the assertions
    // below would pass vacuously. Nine procedures is what the surface has.
    const derived = derivedProcs()
    expect(derived).toHaveLength(9)
    // Each key is served by the contract of the same name — a `show:
    // mailQuery('ledger')` would type-check and serve the wrong command.
    for (const d of derived) expect(d.proc).toBe(d.key)
    for (const d of derived) expect(Object.hasOwn(MAIL_COMMANDS, d.proc)).toBe(true)

    // And nothing else: no hand-written body, no second validation surface.
    const block = messagesRouterBlock()
    expect(block).not.toContain('.mutation(')
    expect(block).not.toContain('.query(')
    expect(block).not.toContain('t.procedure')
    expect(block).not.toContain('z.unknown()')
  })

  it('serves nothing the contract table does not expose on trpc', () => {
    const derived = derivedProcs()
    expect(derived).toHaveLength(9)
    for (const d of derived) {
      const contract = MAIL_COMMANDS[d.proc as keyof typeof MAIL_COMMANDS].contract
      expect(contract.exposure).toContain('trpc')
    }
  })

  it('matches the WIRE VERB to the policy action on every one — inbox is a mutation because it consumes', () => {
    // The trap this closes: `inbox` reads like a query and is a `write`, because
    // reading your own box marks its rows read. Serving it as a query would
    // widen it to viewer-grade principals. The router's helpers refuse a
    // mismatch at module load; this asserts the pairing per procedure, so the
    // claim is checked against all nine rather than trusted from one.
    for (const d of derivedProcs()) {
      const action = MAIL_COMMANDS[d.proc as keyof typeof MAIL_COMMANDS].contract.policy.action
      expect({ proc: d.proc, verb: d.verb }).toEqual({
        proc: d.proc,
        verb: action === 'read' ? 'query' : 'mutation',
      })
    }
    // Non-vacuity: both verbs must actually occur, or a router that served
    // everything one way would satisfy the loop above if the table agreed.
    const verbs = new Set(derivedProcs().map((d) => d.verb))
    expect([...verbs].sort()).toEqual(['mutation', 'query'])
  })
})

// ---------------------------------------------------------------------------
// 1b. A command that WAKES declares that it executes (POD-1179)
// ---------------------------------------------------------------------------

/**
 * THE RUNNING-OBJECT HALF of `scripts/audit-mail-commands.ts`'s `wake-needs-use`
 * check, and the pairing is the point: that script reads source TEXT and resolves
 * no modules, so it would be satisfied by a contract table that no longer loads.
 * This reads the CONTRACT OBJECTS the server actually dispatches through.
 *
 * The claim: a mail command that can deliver at `lifecycle: 'wake'` reaches
 * `MessageDeliveryService.trySpawn` — it resumes or spawns a session, which is
 * code execution on that session's machine (readiness §3.1.4 M2) — and must
 * declare `machineVerb: 'use'`. POD-1179 is here because `mail.ask`'s declaration
 * was dropped resolving a duplicate contract and nothing noticed.
 */
describe('POD-1179: every wake-capable mail command declares machineVerb `use`', () => {
  /**
   * Contracts whose INPUT SCHEMA admits a caller-chosen `lifecycle: 'wake'`.
   *
   * Keyed on the PARSED OUTPUT, not on `success`. Zod strips unknown keys and
   * succeeds, so a `success`-only probe called every contract wake-capable —
   * including `mail.reply`, which has no lifecycle field at all. The counterfactual
   * below is what surfaced that; a probe with no failing arm would have shipped it.
   */
  const admitsWake = (contract: {
    input: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }
  }): boolean => {
    const parsed = contract.input.safeParse({
      to: '#1',
      sessionId: asSessionId('s1'),
      question: 'q',
      body: 'b',
      id: 'm1',
      prompt: 'p',
      lifecycle: 'wake',
    })
    return (
      parsed.success && (parsed.data as { lifecycle?: string } | undefined)?.lifecycle === 'wake'
    )
  }

  it('declares the verb on both wake-capable commands, and on nothing that cannot wake', () => {
    // Derived from the RUNNING contracts, not from a list restated here: a list
    // would keep agreeing with itself after the table changed underneath it.
    const declaring = Object.values(MAIL_COMMANDS)
      .filter((c) => c.contract.policy.machineVerb === 'use')
      .map((c) => c.contract.name)
      .sort()
    // `mail.send` admits a caller lifecycle; `mail.ask` hard-codes wake;
    // `mail.spawnAgent` places a new process by definition.
    expect(declaring).toEqual(['mail.ask', 'mail.send', 'mail.spawnAgent'])

    // The counterfactual that makes the list mean something: `mail.reply` is
    // wake-INCAPABLE, and the schema is what says so. If a lifecycle field were
    // ever added to the reply contract, this fails and the verb question has to
    // be answered again rather than inherited.
    const reply = MAIL_COMMANDS.reply.contract
    expect(reply.policy.machineVerb).toBeUndefined()
    expect(admitsWake(reply as never)).toBe(false)
    // …and the instrument can say YES: the same probe accepts `mail.send`, so a
    // `safeParse` that rejected everything could not produce the `false` above.
    expect(admitsWake(MAIL_COMMANDS.send.contract as never)).toBe(true)
  })

  it('keeps `use` out of the offline class — D18.3, over the objects rather than the text', () => {
    for (const { contract } of Object.values(MAIL_COMMANDS)) {
      if (contract.policy.machineVerb !== 'use') continue
      expect(contract.delivery.class).not.toBe('offline-eligible')
      expect(contract.exposure).not.toContain('outbox')
    }
  })
})

// ---------------------------------------------------------------------------
// 2. No un-governed path to delivery
// ---------------------------------------------------------------------------

/**
 * The senders that reach `MessageDeliveryService` without a mail contract, each
 * with the reason it is not a bypass. A NEW entry appearing here is a finding:
 * either it needs a contract, or it needs a line in this table saying why not.
 *
 * The rule that separates the two: a contract is required where a PRINCIPAL's
 * request causes the send. A send the SERVER originates on its own behalf (an
 * auto-ack, a dead-letter notice) has no principal to authorize and no address
 * a caller chose.
 */
const ALLOWED_DIRECT_SENDERS: Record<string, string> = {
  'modules/messages/handlers/send.ts':
    'THE governed path itself — the `mail.send` handler, reached only through the contract.',
  'modules/messages/handlers/reply.ts': 'The `mail.reply` handler. Same: behind the contract.',
  'modules/messages/handlers/ask.ts':
    'The `mail.ask` handler — moved out of the gate’s hand-written switch by POD-729, which is ' +
    'why it is on this list at all rather than being an ungoverned send.',
  'relay.ts':
    'TWO sites, both server-originated. (1) `sendMessage`, the port the ISSUES registry’s ' +
    '`mailSend` proc uses: gated by the issues registry’s own authz, but through a second ' +
    'contract home — a FINDING for POD-311, which owns collapsing the two tables, not something ' +
    'to absorb into this diff. (2) `notifyCoordinator`, a `kind:"system"` workflow notice with no ' +
    'principal and no caller-supplied address.',
  'modules/superagent/tools.ts':
    'FINDING, reported not absorbed: the superagent tool surface reaches delivery directly. Its ' +
    'caller is the operator’s own superagent, so today it is an operator-authority path; under ' +
    'multi-user it needs the contract. POD-313 owns the superagent surface.',
}

describe('every path to message delivery is accounted for', () => {
  it('has no direct MessageDeliveryService caller outside the allowlist', () => {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    const files = walk(root).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    // Instrument check: the walk must have found the tree, not an empty one.
    expect(files.length).toBeGreaterThan(100)
    const callers = new Set<string>()
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      if (
        /(?:messages\(\)|messagesSvc|modules\.messages|\bsvc)\.(?:send|sendAndConfirm|sendReply)\(/.test(
          src,
        )
      ) {
        callers.add(file.slice(root.length).replace(/^\/+/, ''))
      }
    }
    // Instrument check again: a pattern that matched NOTHING would satisfy any
    // subset assertion, so require that it found the known senders first.
    expect(callers.size).toBeGreaterThan(3)
    expect([...callers].sort()).toEqual(Object.keys(ALLOWED_DIRECT_SENDERS).sort())
  })

  it('does not reach delivery from the session command plane at all', () => {
    // THE DELETION, asserted by ABSENCE plus a shape check. `sendText` and
    // `resumeAndSend` used to call the delivery service here; they dispatch the
    // contract now, and the dependency they used to do it with is gone — so a
    // re-introduction cannot compile against the same seam, it has to add a new
    // one, which this assertion sees.
    const src = sourceOf('../sessions/command-plane.ts')
    // The DEPENDENCY is gone, not merely unused: `SessionCommandDeps` no longer
    // has a `messages()` member, so a re-introduction cannot compile against the
    // old seam — it has to declare a new one, which this assertion sees.
    expect(src).not.toMatch(/^\s*messages\(\)/m)
    expect(src).not.toContain('deps.messages()')
    expect(src).not.toContain('ctx.deps.messages()')
    expect(src).toContain('ctx.deps.mailSend(')
  })

  it('applies idempotency in the framework envelope, not in the handlers', () => {
    const src = sourceOf('../sessions/command-plane.ts')
    // THE MECHANISM CHANGED UNDER THIS TEST AND ITS CLAIM DID NOT (POD-382, at the
    // integration merge). It used to read `ctx.sessions.withMutation(mutationId,
    // \`sessions.${key}\`)`; that method is deleted, and dedup is now
    // `@podium/sync`'s `MutationLedger` — one implementation shared by the presence
    // envelope, this dispatcher and the issue registry, injected as a dep rather
    // than borrowed from the session service.
    //
    // What this test is FOR is unchanged and is asserted the same way: exactly ONE
    // idempotency call site in this file, and it is the dispatcher's, not a
    // handler's. The count is what carries the claim — a handler that wrapped
    // itself would make it two.
    // COMMENTS STRIPPED FIRST. The count is the assertion, and this file documents
    // the seam it deleted by NAMING it — a doc comment saying "it used to be
    // ctx.sessions.withMutation(...)" is not a call site, and counting it made the
    // instrument report 2 for a file with exactly one.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const sites = [...code.matchAll(/\.(?:withMutation|once)\(/g)]
    expect(sites).toHaveLength(1)
    expect(code).toContain('ctx.deps.mutations.once(')
    // And the old seam is GONE, not merely unused: a re-introduction cannot
    // compile against `ctx.sessions.withMutation` because the service no longer
    // has it, so it would have to declare a new one — which the count above sees.
    expect(code).not.toContain('ctx.sessions.withMutation')
  })
})

function walk(dir: string): string[] {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'migrations') continue
    const full = `${dir}/${entry}`
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

// ---------------------------------------------------------------------------
// 3. One authz path, proven over BOTH transports
// ---------------------------------------------------------------------------

const BOTH: readonly TransportTag[] = ['trpc', 'relay']

/** A ceiling that hides exactly the named issue ids from the delegating human. */
const ceilingHiding = (hidden: () => string[]) => ({
  canSee: (e: { kind: 'issue' | 'session'; id: string }) => !hidden().includes(e.id),
})

/** Run one scenario on one transport and reduce it to a comparable answer. */
async function outcome(
  run: () => Promise<unknown> | undefined,
): Promise<{ threw: boolean; message?: string; ok?: boolean; disposition?: string }> {
  try {
    const r = (await run()) as { ok?: boolean; disposition?: string } | undefined
    return {
      threw: false,
      ...(r?.ok !== undefined ? { ok: r.ok } : {}),
      ...(r?.disposition !== undefined ? { disposition: r.disposition } : {}),
    }
  } catch (error) {
    return { threw: true, message: (error as Error).message }
  }
}

describe('the tRPC arm and the relay arm reach the SAME answer', () => {
  it('applies the human ceiling identically on both — and allows identically when it should', async () => {
    const allowed: unknown[] = []
    const denied: unknown[] = []
    for (const transport of BOTH) {
      const hidden: string[] = []
      const ceiling = ceilingHiding(() => hidden)
      const policy = mailPolicy({ ceiling })
      const h = mailHarness({ ceiling, authorizeAtApply: policy.authorizeAtApply })
      const mine = h.createIssue({ title: 'mine' })
      const theirs = h.createIssue({ title: 'theirs' })
      const cap = h.agentCap(mine.id, asSessionId('sMine'))

      // ALLOWED first, so the instrument is known to be able to say yes: without
      // this arm a broken fixture and a working ceiling look identical.
      allowed.push(
        await outcome(() =>
          h.gate.dispatch(cap, true, 'send', { to: theirs.id, body: 'x' }, transport),
        ),
      )
      hidden.push(theirs.id)
      denied.push(
        await outcome(() =>
          h.gate.dispatch(cap, true, 'send', { to: theirs.id, body: 'x' }, transport),
        ),
      )
    }
    // The claim is EQUALITY across transports, so the test compares them.
    expect(allowed[0]).toEqual(allowed[1])
    expect(denied[0]).toEqual(denied[1])
    // …and that the two scenarios are actually different, or the equality above
    // would hold for a gate that did nothing at all.
    expect(denied[0]).not.toEqual(allowed[0])
  })

  it('makes beyond-ceiling and unknown-id indistinguishable on both arms', async () => {
    for (const transport of BOTH) {
      const hidden: string[] = []
      const ceiling = ceilingHiding(() => hidden)
      const policy = mailPolicy({ ceiling })
      const h = mailHarness({ ceiling, authorizeAtApply: policy.authorizeAtApply })
      const mine = h.createIssue({ title: 'mine' })
      const theirs = h.createIssue({ title: 'theirs' })
      hidden.push(theirs.id)
      const cap = h.agentCap(mine.id, asSessionId('sMine'))

      const beyond = await outcome(() =>
        h.gate.dispatch(cap, true, 'send', { to: theirs.id, body: 'x' }, transport),
      )
      const unknown = await outcome(() =>
        h.gate.dispatch(cap, true, 'send', { to: '#99999', body: 'x' }, transport),
      )
      expect(beyond).toEqual(unknown)
      // Non-vacuity: both must actually be the dead-letter answer, not two
      // identical `undefined`s from a dispatch that never ran.
      expect(beyond.disposition).toBe('dead_letter')
    }
  })

  it('refuses a proc the contract does not expose on that transport — default-closed', () => {
    const h = mailHarness()
    // `pendingReminders` is relay-only (the stop hook). The relay serves it; the
    // tRPC arm must answer "no such proc", which is what an unexposed command
    // is indistinguishable from.
    expect(h.gate.dispatch(OPERATOR, undefined, 'pendingReminders', {}, 'relay')).toBeDefined()
    expect(h.gate.dispatch(OPERATOR, undefined, 'pendingReminders', {}, 'trpc')).toBeUndefined()
    // The counterfactual: a proc that IS exposed on trpc answers there.
    expect(h.gate.dispatch(OPERATOR, undefined, 'ledger', {}, 'trpc')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 4. One ceiling object, enforced at boot
// ---------------------------------------------------------------------------

describe('the two halves of the ceiling are one object', () => {
  const ceiling = { canSee: () => true }

  it('refuses to compose a gate whose delivery service carries a DIFFERENT ceiling', () => {
    const other = { canSee: () => true }
    expect(() =>
      mailHarness({ ceiling, authorizeAtApply: mailPolicy({ ceiling: other }).authorizeAtApply }),
    ).toThrow(/DIFFERENT object/)
  })

  it('refuses a real ceiling with no apply-time port at all — half a ceiling', () => {
    expect(() => mailHarness({ ceiling })).toThrow(/carries no apply-time port/)
  })

  it('composes when both come from one mailPolicy() — the instrument can say yes', () => {
    const policy = mailPolicy({ ceiling })
    expect(() =>
      mailHarness({
        ceiling: policy.gateOptions.ceiling,
        authorizeAtApply: policy.authorizeAtApply,
      }),
    ).not.toThrow()
  })

  it('leaves the single-user default alone — neither half wired is not a misconfiguration', () => {
    expect(() => mailHarness()).not.toThrow()
  })

  it('wires the apply-time port at the REAL composition root', () => {
    // The criterion is "live end to end", not "unit-tested against the handler",
    // and this is the assertion that separates them: relay.ts must hand the
    // delivery service a port from `mailPolicy()`. A comment saying so is not
    // evidence; the source is.
    const src = sourceOf('../../relay.ts')
    expect(src).toContain('const mail = principalMailPolicy({')
    expect(src).toContain('authorizeAtApply: mail.authorizeAtApply')
    expect(src).toContain('mail.gateOptions')
  })
})

// ---------------------------------------------------------------------------
// 5. The queued-send rejection, live through a mailPolicy()-composed pair
// ---------------------------------------------------------------------------

describe('the queued-send rejection is live through the COMPOSED pair, not just the handler', () => {
  /**
   * POD-728 proved the mechanism against a hand-written `authorizeAtApply`.
   * What this adds is the composition: the port comes from `mailPolicy()`,
   * built from the SAME ceiling object the gate resolves addresses with, and
   * the send is a CONTRACT DISPATCH rather than a direct `svc.send`. That pair
   * is what relay.ts now wires, so this exercises the shipped shape.
   */
  function composed(hidden: string[]) {
    const ceiling = ceilingHiding(() => hidden)
    const policy = mailPolicy({ ceiling })
    return mailHarness({
      ceiling: policy.gateOptions.ceiling,
      authorizeAtApply: policy.authorizeAtApply,
    })
  }

  it('rejects at the drain and tells the sender, once the target leaves the ceiling', async () => {
    const hidden: string[] = []
    const h = composed(hidden)
    const target = h.createIssue({ title: 'target' })
    const sender = h.createIssue({ title: 'sender' })
    h.put({ sessionId: asSessionId('sSender'), issueId: sender.id, phase: 'idle' })

    // Accepted while the target is visible; no live session there, so it QUEUES —
    // which is the state the whole re-authorization rule is about.
    const accepted = (await h.gate.dispatch(
      h.agentCap(sender.id, asSessionId('sSender')),
      true,
      'send',
      {
        to: target.id,
        body: 'work please',
      },
    )) as { id: string; disposition: string }
    expect(accepted.disposition).toBe('held')
    expect(h.svc.message(accepted.id)?.status).toBe('queued')

    // The target leaves the delegating human's visibility BETWEEN accept and
    // drain — the one mutation this scenario is about.
    hidden.push(target.id)
    h.put({ sessionId: asSessionId('sTarget'), issueId: target.id, phase: 'idle' })
    h.svc.sweep()

    // Never applied…
    expect(h.svc.message(accepted.id)?.status).toBe('dead_letter')
    expect(h.pushes.filter((p) => p.sessionId === 'sTarget')).toEqual([])
    // …and never silently dropped (ADR 3 D9). The reason is the one an id that
    // does not exist gives, so the queue is not an existence oracle one step
    // removed (D20.2).
    const notices = h.svc
      .inbox([{ kind: 'session', id: 'sSender' }], { limit: 50 })
      .filter((m) => m.body.includes(accepted.id))
    expect(notices.length).toBeGreaterThan(0)
    expect(notices.at(-1)?.body).toContain('issue no longer exists')
  })

  it('delivers the identical send when nothing was revoked — the instrument can say yes', async () => {
    const h = composed([])
    const target = h.createIssue({ title: 'target' })
    const sender = h.createIssue({ title: 'sender' })
    h.put({ sessionId: asSessionId('sSender'), issueId: sender.id, phase: 'idle' })

    const accepted = (await h.gate.dispatch(
      h.agentCap(sender.id, asSessionId('sSender')),
      true,
      'send',
      {
        to: target.id,
        body: 'work please',
      },
    )) as { id: string; disposition: string }
    h.put({ sessionId: asSessionId('sTarget'), issueId: target.id, phase: 'idle' })
    h.svc.sweep()

    expect(h.svc.message(accepted.id)?.status).not.toBe('dead_letter')
    expect(h.pushes.filter((p) => p.sessionId === 'sTarget').length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 6. THE ROUND TRIP, over the real stack
// ---------------------------------------------------------------------------

describe('mail e2e: send -> delivery -> reply, through the derived surfaces', () => {
  /**
   * The acceptance criterion asks for the whole loop, so this drives the REAL
   * server: `appRouter` for the human seam and the daemon relay for the agent
   * seam, over a live `SessionRegistry`. Nothing here is a harness stand-in —
   * if the derived procedures, the contract dispatch or the composition root
   * were wrong, this is the test that notices.
   *
   * It also crosses the two transports on purpose: the send goes out over tRPC
   * and the reply comes back over the relay. One authz path means the round
   * trip closes even though the two ends never share a code path above the
   * gate.
   */
  it('delivers an issue-addressed send to the live agent and threads its reply back', async () => {
    const o = makeOracle()
    const issue = o.reg.issues.create({ repoPath: '/r', title: 'Target', startNow: false })
    o.reg.issues.update(issue.id, { worktreePath: '/r/.worktrees/t' })
    const { sessionId } = await o.call.sessions.create({
      agentKind: 'claude-code',
      cwd: '/r/.worktrees/t',
      issueId: issue.id,
    })
    // Live and idle, so the push lands rather than queueing.
    o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'claude',
      cwd: '/r/.worktrees/t',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentState',
      sessionId,
      state: { phase: 'idle', since: new Date().toISOString(), nativeSubagentCount: 0 },
    })
    o.daemon.length = 0

    // SEND — the operator's tRPC `messages.send`, now a derived procedure whose
    // schema is the contract's own instance.
    const sent = (await o.call.messages.send({
      to: issue.id,
      body: 'please confirm you got this',
      urgency: 'next-turn',
    })) as { id: string; ok: boolean; disposition: string }
    expect(sent.ok).toBe(true)

    // DELIVERY — the body reaches the agent's PTY, byte-faithful inside the
    // server-rendered envelope.
    await waitFor(() => ptyFrames(o.daemon).length > 0, 'the message to reach the PTY')
    const frames = ptyFrames(o.daemon)
    // Exactly one frame — a second would mean a duplicate delivery, which the
    // joined-blob form of this assertion could not see.
    expect(frames).toHaveLength(1)
    expect(frames[0]?.inputOrigin).toBe('mail')
    // The body is byte-faithful. No envelope assertion here: an OPERATOR send
    // lands unwrapped by design ([spec:SP-34d7] deliversUnwrapped), so the id
    // is not in the frame — the reply below uses the id the SENDER was handed,
    // which is the operator's real affordance.
    expect(frames[0]?.data).toContain('please confirm you got this')

    // REPLY — the recipient answers over the RELAY, the agent seam, using the
    // message id it just read out of its own envelope.
    const replied = await o.relay({
      requestId: 'r-1',
      sessionId,
      router: 'messages',
      proc: 'reply',
      input: { id: sent.id, body: 'got it' },
    })
    expect(replied.ok).toBe(true)

    // The thread closes: the reply is threaded onto the original, and the
    // original is ACKED by that very row — asserted by identity, not by
    // "something is non-null", so a reply that acked the wrong message would
    // still fail.
    const ledger = (await o.call.messages.ledger({ issueId: issue.id })) as {
      id: string
      body: string
      inReplyTo: string | null
      threadId: string
    }[]
    const reply = ledger.find((m) => m.body.includes('got it'))
    expect(reply).toBeDefined()
    expect(reply?.inReplyTo).toBe(sent.id)

    const original = (await o.call.messages.show({ id: sent.id })) as {
      threadId: string
      ackedBy: string | null
    }
    expect(original.ackedBy).toBe(reply?.id)
    expect(reply?.threadId).toBe(original.threadId)
  })
})
