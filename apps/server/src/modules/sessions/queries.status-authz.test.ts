/**
 * `sessions.status` IS OWNERSHIP-CHECKED LIKE ITS THREE SIBLINGS [PDM-229].
 *
 * THE DEFECT THIS PINS IS A DISCLOSURE, NOT A THROW. Before the repair,
 * `SESSION_QUERIES.status` resolved any caller-supplied ref and returned the
 * target's issue, its repo's `git log` and `git status`, and the files it
 * touched — to anyone who could reach the server. `recap`, `transcriptRead`
 * and `read`, declared in the SAME table over the SAME resource, all assert
 * `mayReadSession` first. The asymmetry was the evidence.
 *
 * SO THE NEGATIVE ASSERTS ABSENCE OF THE PAYLOAD, not just the presence of an
 * error. A test that only checked `rejects.toThrow` would pass against a
 * version that built the whole status projection, event-logged the read and
 * shelled the target's repository before throwing on the way out — which is
 * disclosure with a tidy return code. `events` and `repoOps` below are the
 * real observation: a refused read must leave no trace and touch no repo.
 *
 * THE FIXTURE CARRIES NO CAPABILITY, and that is deliberate (false-green
 * catalogue #14). `FamilyState.caller` is a two-field identity — a user id and
 * an actor session id — and NOT a capability, so there is no admin short
 * circuit available at this seam to decide an assertion for the wrong reason.
 * The stranger is a plain second identity; the only thing that can allow or
 * refuse it is the ownership rule under test.
 *
 * THE TOOLKIT IS REAL. `SessionReadToolkit` is constructed rather than stubbed,
 * so "the stranger got nothing" is a fact about the code path rather than
 * about a mock's call log.
 *
 * OWNER, GRANTEE AND STRANGER ARE THREE DISTINCT IDENTITIES. Collapsing
 * grantee into owner — the tidier fixture — would let a bare `owner === caller`
 * check pass every assertion here, and the grant arm would go untested.
 */

import {
  asSessionId,
  type SessionId,
  type SessionMeta,
  type SessionMetaInput,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import { metasAsFacts } from '../../test-support/session-facts'
import type { FamilyState } from '../derived-family'
import type { IssueService } from '../issues/service'
import type { MessageDeliveryService } from '../messages/service'
import { SESSION_QUERIES } from './queries'
import { SessionReadToolkit } from './read-toolkit'

const OWNER = 'u_owner'
const GRANTEE = 'u_grantee'
/** Neither the owner nor a grantee. Holds no capability of any kind. */
const STRANGER = 'u_stranger'

const TARGET = asSessionId('s_target')
/** A second member of the same issue, owned by nobody the caller knows. Only
 *  the last test uses it — it exists to make the resolved-once property
 *  observable. */
const SIBLING = asSessionId('s_sibling')

const ISSUE = {
  id: 'iss_a',
  seq: 228,
  stage: 'in_progress',
  title: 'The issue',
  worktreePath: '/wt/a',
  panel: { todos: [{ text: 'ship it', done: false }], artifacts: [], deferred: [] },
}

function session(over: Partial<SessionMetaInput>): SessionMeta {
  return {
    sessionId: TARGET,
    cwd: '/wt/a',
    agentKind: 'claude-code',
    status: 'live',
    createdAt: 't',
    machineId: 'm1',
    issueId: ISSUE.id,
    agentState: { phase: 'working', since: 't', nativeSubagentCount: 0 },
    ...over,
  } as SessionMeta
}

interface Ownership {
  readonly owner: string
  readonly grants: readonly string[]
}

function harness(opts?: {
  /** The fleet the FIRST `sessionFacts()` read sees. */
  fleet?: SessionMeta[]
  /** The fleet every LATER read sees, modelling a fleet that moved between a
   *  resolution taken for authorization and a second one taken to project. */
  fleetAfterFirstRead?: SessionMeta[]
  owners?: Record<string, Ownership>
}) {
  /** Every cross-session read the toolkit logs. A refused read must add none. */
  const events: { kind: string; subject: string }[] = []
  /** Every `git` invocation against the target's working tree. Likewise none. */
  const repoOps: string[] = []
  /** Which session ids ownership was actually asked about. */
  const ownerReads: SessionId[] = []
  /** Which session ids were actually projected (i.e. whose status was built). */
  const projected: SessionId[] = []

  const first = opts?.fleet ?? [session({})]
  const later = opts?.fleetAfterFirstRead ?? first
  let factsReads = 0
  const fleetNow = (): SessionMeta[] => (factsReads++ === 0 ? first : later)
  const everySession = (): SessionMeta[] => [...first, ...later]

  const owners: Record<string, Ownership> = opts?.owners ?? {
    [TARGET]: { owner: OWNER, grants: [] },
  }

  const toolkit = new SessionReadToolkit({
    sessionFacts: () => metasAsFacts(fleetNow()),
    sessionById: async (sessionId: SessionId) => {
      projected.push(sessionId)
      return everySession().find((s) => s.sessionId === sessionId)
    },
    sessionsById: async (sessionIds: Iterable<SessionId>) => {
      const wanted = new Set(sessionIds)
      return everySession().filter((s) => wanted.has(s.sessionId))
    },
    issues: {
      resolveRef: (ref: string) => {
        if (ref === '#228' || ref === '228' || ref === ISSUE.id) return ISSUE.id
        throw new Error(`unknown ref ${ref}`)
      },
      getMeta: (id: string) => (id === ISSUE.id ? ISSUE : undefined),
      get: (id: string) => (id === ISSUE.id ? ISSUE : undefined),
      issueForCwd: () => null,
    } as unknown as IssueService,
    messages: {
      deliveredUnacked: () => [{ id: 'm1' }],
    } as unknown as MessageDeliveryService,
    events: {
      appendEvent: async (e: { kind: string; subject: string }) => {
        events.push({ kind: e.kind, subject: e.subject })
        return 1
      },
    },
    repoOp: async (op: string) => {
      repoOps.push(op)
      return op === 'log'
        ? { ok: true, output: 'c1 secret commit subject' }
        : { ok: true, output: '## branch\n M private.ts' }
    },
    readTranscript: async () => ({ items: [], hasMore: false }),
    watermarks: {
      get: async () => undefined,
      set: async () => undefined,
    },
  } as never)

  /** A `FamilyState` carrying ONLY what this read reaches for: the caller's
   *  identity, the ownership port, and the toolkit. Anything else a handler
   *  touched would throw rather than quietly read `undefined`. */
  const stateFor = (userId: string): FamilyState =>
    ({
      caller: { userId, actorSessionId: undefined, sessionState: undefined },
      modules: {
        readToolkit: toolkit,
        sessions: {
          sessionOwner: async (sessionId: SessionId) => {
            ownerReads.push(sessionId)
            return owners[sessionId]
          },
        },
      },
    }) as unknown as FamilyState

  return { stateFor, events, repoOps, ownerReads, projected }
}

const statusFor = async (state: FamilyState, ref: string) =>
  await SESSION_QUERIES.status.run(state, { ref })

describe('sessions.status ownership', () => {
  it('answers the owner with the status of the session they own', async () => {
    const h = harness()
    const result = await statusFor(h.stateFor(OWNER), TARGET)
    expect(result.sessionId).toBe(TARGET)
    // The payload really is the sensitive one the finding describes — asserting
    // it here is what stops the refusal tests below from passing against a
    // version that simply broke the read for everybody.
    expect(result.commits).toEqual(['c1 secret commit subject'])
    expect(result.files).toContain(' M private.ts')
    expect(result.issue).toMatchObject({ seq: 228, title: 'The issue' })
  })

  /**
   * TRANSITIONAL, AND IT MUST FLIP WHEN PDM-251 LANDS — do not read this as the
   * v1 sharing rule. It pins what `mayReadOwned` answers TODAY, which is the
   * task owner-or-grant shape (`AuthTarget` kind `owned`). PDM-251 is open
   * against exactly that: a grant on a shared task still opens the private
   * sessions attached to it, and the owner-only `private` target that should
   * decide a SESSION exists in the model with nothing building one yet.
   *
   * So when a session authorization target becomes `private`, THIS ASSERTION
   * BECOMES A REFUSAL. It is here to stop a regression to bare `owner ===
   * caller` equality, not to defend grantee access on its merits. Left as a
   * positive case so the flip is a visible, deliberate edit rather than a test
   * that quietly already agreed.
   */
  it('answers a grantee today — transitional, see PDM-251', async () => {
    const h = harness({ owners: { [TARGET]: { owner: OWNER, grants: [GRANTEE] } } })
    const result = await statusFor(h.stateFor(GRANTEE), TARGET)
    expect(result.sessionId).toBe(TARGET)
  })

  it('refuses a stranger with NOT_FOUND rather than FORBIDDEN', async () => {
    const h = harness()
    const err = await statusFor(h.stateFor(STRANGER), TARGET).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TRPCError)
    // NOT_FOUND, because FORBIDDEN would confirm the session exists.
    expect((err as TRPCError).code).toBe('NOT_FOUND')
  })

  it('discloses nothing to a stranger: no read is logged and no repo is inspected', async () => {
    const h = harness()
    await statusFor(h.stateFor(STRANGER), TARGET).catch(() => undefined)
    // THE ASSERTION THIS FILE EXISTS FOR. The pre-repair handler reached all
    // three of these before returning the payload.
    expect(h.events).toEqual([])
    expect(h.repoOps).toEqual([])
    expect(h.projected).toEqual([])
  })

  it('refuses an unresolvable ref the same way it refuses a stranger', async () => {
    const h = harness()
    const unknown = await statusFor(h.stateFor(OWNER), '#999').catch((e: unknown) => e)
    const refused = await statusFor(h.stateFor(STRANGER), TARGET).catch((e: unknown) => e)
    expect(unknown).toBeInstanceOf(TRPCError)
    // Same code for "no such session" and "not yours" — a caller cannot use the
    // two to decide which sessions exist.
    expect((unknown as TRPCError).code).toBe((refused as TRPCError).code)
    expect((unknown as TRPCError).code).toBe('NOT_FOUND')
  })

  it('projects the session it authorized, even when the fleet moves mid-read', async () => {
    // An ISSUE ref resolves to the issue's best member — live preferred. Here
    // the live member changes between the first read of the fleet and the
    // second, which is exactly the window a handler opens if it resolves once
    // to authorize and again to project.
    const h = harness({
      fleet: [
        session({ sessionId: TARGET, status: 'live', lastActiveAt: '2' }),
        session({ sessionId: SIBLING, status: 'hibernated', lastActiveAt: '1' }),
      ],
      fleetAfterFirstRead: [
        session({ sessionId: TARGET, status: 'hibernated', lastActiveAt: '2' }),
        session({ sessionId: SIBLING, status: 'live', lastActiveAt: '3' }),
      ],
      owners: {
        [TARGET]: { owner: OWNER, grants: [] },
        [SIBLING]: { owner: STRANGER, grants: [] },
      },
    })
    const result = await statusFor(h.stateFor(OWNER), '#228')
    // Authorized TARGET, so TARGET is what may be returned. A second resolution
    // would have answered with SIBLING — a session this caller does not own.
    expect(h.ownerReads).toEqual([TARGET])
    expect(result.sessionId).toBe(TARGET)
    expect(h.projected).toEqual([TARGET])
  })
})
