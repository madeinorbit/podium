/**
 * THE RELAY'S THREE SESSION READS ARE GATED ON THE TARGET'S OWNER, NOT ITS ISSUE
 * [POD-3900].
 *
 * WHAT FAILS HERE BEFORE THE FIX, stated plainly so a reader does not have to
 * infer it: `sessions.status`, `sessions.read` and `sessions.recap` resolved the
 * target and then asked `checkIssueAccess(..., 'write', targetIssueId)` — a
 * question about the TASK. Two members of one task have different owners, so a
 * colleague with write on a shared task read every other member's session
 * through this arm: the target's issue, its repo's `git log` and `git status`
 * and the files it touched (status), and its transcript text (read, recap).
 * ADR 9 Amendment 1 D7 and D13 say a colleague sees owner, title and live/idle
 * state and nothing more.
 *
 * WHY THE READER HERE HOLDS ISSUE WRITE, AND WHY THAT IS THE WHOLE POINT. A test
 * asserting "a stranger cannot read across the relay" passes before the fix and
 * after it, because the arm already required issue access — the inert guard,
 * catalogue shape 4. The failing case is a member who IS granted the task and is
 * NOT the owner. Bob's capability is exactly what `capabilityForSession` mints
 * for him: `worker` / `subtree` rooted at the task both sessions sit on. He
 * passes `checkIssueAccess` and must still be refused.
 *
 * THE POSITIVE ARMS ARE NOT DECORATION. They are what says this file measures
 * ownership rather than blacklisting a caller: Alice reads her own session
 * through the same dispatch and gets the private payload, and Bob's session
 * reads the CHILD it spawned — a session whose durable owner is Alice, not its
 * parent's human (see `CHILD` below) — and still gets it. Take the
 * ownership gate out and the refusals go green; take the self/parent arms out
 * and the positives go red.
 *
 * NOTHING HERE STUBS THE DECISION. `resolvePrincipalAsync` is the real resolver
 * wired the way the composition root wires it (relay.ts), and the owner-or-grant
 * answer is the real `mayReadOwned` underneath `sessionOwner`. The fixture
 * supplies rows, never verdicts.
 */

import {
  asSessionId,
  type Capability,
  asUserId,
  type SessionId,
  type SessionMeta,
  type SessionMetaInput,
  type UserId,
} from '@podium/model'
import { describe, expect, it } from 'vitest'
import { resolvePrincipalAsync } from '../../command-principal'
import { metaAsFacts } from '../../test-support/session-facts'
import type { IssueService } from '../issues/service'
import type { MessageDeliveryService } from '../messages/service'
import type { SessionLifecycle } from '../sessions/lifecycle'
import { SessionReadToolkit } from '../sessions/read-toolkit'
import { type AgentRelayDispatchDeps, makeAgentRelayDispatch } from './relay-dispatch'

const ALICE = asUserId('u_alice')
const BOB = asUserId('u_bob')

/** Alice's session. The private target of every refusal below. */
const ALICES = asSessionId('s_alice')
/** Bob's session. A member of the SAME task, with write on it. */
const BOBS = asSessionId('s_bob')
/** Spawned by Bob's session and owned by ALICE. POD-3901 fixed `spawn-agent.ts`
 *  to stamp the spawning human, so `podium agent spawn` no longer produces this
 *  row — but `issues/service/workflow.ts` still stamps the ISSUE row's owner on
 *  both its spawns, so a cross-owner child is still reachable and the parent arm
 *  under test is still load-bearing. Bob must be able to read it. */
const CHILD = asSessionId('s_child')

const ISSUE = {
  id: 'iss_a',
  seq: 228,
  stage: 'in_progress',
  title: 'The shared task',
  worktreePath: '/wt/a',
  panel: { todos: [], artifacts: [], deferred: [] },
}

const OWNER_OF: Record<string, UserId> = {
  [ALICES]: ALICE,
  [BOBS]: BOB,
  [CHILD]: ALICE,
}

function session(over: Partial<SessionMetaInput>): SessionMeta {
  return {
    cwd: '/wt/a',
    issueId: ISSUE.id,
    agentKind: 'claude-code',
    createdAt: 't',
    lastActiveAt: 't',
    machineId: 'm1',
    status: 'live',
    title: 'a session',
    agentState: { phase: 'working', since: 't', nativeSubagentCount: 0 },
    ...over,
  } as SessionMeta
}

const FLEET: SessionMeta[] = [
  session({ sessionId: ALICES }),
  session({ sessionId: BOBS }),
  session({ sessionId: CHILD, spawnedBy: `session:${BOBS}` }),
]

/** The transcript the two text reads return. If a refusal ever answers with
 *  this string, the gate did not run. */
const SECRET = 'ALICE PRIVATE TRANSCRIPT LINE'

function harness() {
  const issues = {
    // Non-null: this test is about the ISSUE branch of the arm, which is the
    // branch that was the whole defect. `resolveRef`/`getMeta` are here because
    // `resolveTarget` falls back to them for a non-session ref.
    issueForCwd: () => ISSUE.id,
    resolveRef: (ref: string) => {
      if (ref === '#228' || ref === ISSUE.id) return ISSUE.id
      throw new Error(`unknown ref ${ref}`)
    },
    getMeta: (id: string) => (id === ISSUE.id ? ISSUE : undefined),
    get: (id: string) => (id === ISSUE.id ? ISSUE : undefined),
    // What `checkIssueAccess` asks. Bob's subtree scope is rooted at this very
    // issue, so the issue gate ALLOWS him — that is the precondition this file
    // exists to prove is not sufficient.
    has: (id: string) => id === ISSUE.id,
    ancestorIds: (id: string) => [id],
  } as unknown as IssueService

  const readToolkit = new SessionReadToolkit({
    sessionFacts: () => FLEET.map(metaAsFacts),
    sessionById: async (sessionId: SessionId) => FLEET.find((s) => s.sessionId === sessionId),
    sessionsById: async (sessionIds: Iterable<SessionId>) => {
      const wanted = new Set(sessionIds)
      return FLEET.filter((s) => wanted.has(s.sessionId))
    },
    issues,
    messages: { deliveredUnacked: () => [] } as unknown as MessageDeliveryService,
    events: { appendEvent: async () => 1 },
    repoOp: async (op: string) => ({
      ok: true,
      output: op === 'log' ? 'c0ffee private subject' : '## branch\n M secret-file.ts',
    }),
    readTranscript: async () => ({
      items: [{ role: 'assistant', text: SECRET, cursor: 'c1', ts: 't' }],
      hasMore: false,
    }),
    watermarks: { getRecapWatermark: async () => undefined, setRecapWatermark: async () => undefined },
    now: () => 't',
  } as never)

  /** The ownership lookup every transport already shares. Rows, not verdicts. */
  const sessionsSvc = {
    sessionOwner: async (sessionId: SessionId) => {
      const owner = OWNER_OF[sessionId]
      return owner ? { owner, grants: [] as string[] } : undefined
    },
  } as unknown as SessionLifecycle

  const dispatch = makeAgentRelayDispatch({
    readToolkit,
    issues,
    sessionsSvc,
    // THE REAL RESOLVER, wired as relay.ts wires it: the delegation chain is
    // walked over `spawnedBy`, and the human is the OWNER of the chain's root.
    principalForCapability: (capability: Capability) =>
      resolvePrincipalAsync(capability, {
        parentSessionOf: async (candidate) => {
          const row = FLEET.find((s) => s.sessionId === candidate)
          const parent = row?.spawnedBy?.startsWith('session:')
            ? asSessionId(row.spawnedBy.slice('session:'.length))
            : undefined
          return parent
        },
        onBehalfOfFor: async (candidate) => OWNER_OF[candidate],
      }),
  } as unknown as AgentRelayDispatchDeps)

  return dispatch
}

/** Exactly what `capabilityForSession` mints for a session on this issue. */
function capabilityFor(sessionId: SessionId, onBehalfOf: UserId) {
  return {
    role: 'worker',
    scope: { kind: 'subtree', rootId: ISSUE.id },
    actorSessionId: sessionId,
    onBehalfOf,
  } as never
}

const BOB_CAP = capabilityFor(BOBS, BOB)
const ALICE_CAP = capabilityFor(ALICES, ALICE)

const ARMS = [
  { proc: 'read', input: { sessionId: ALICES } },
  { proc: 'recap', input: { sessionId: ALICES } },
  { proc: 'status', input: { ref: ALICES } },
] as const

describe('relay session reads are gated on the target owner', () => {
  it.each(ARMS)(
    'refuses sessions.$proc to a task member who does not own the session',
    async ({ proc, input }) => {
      const dispatch = harness()
      await expect(dispatch(BOB_CAP, false, 'sessions', proc, input)).rejects.toThrow(
        // The SAME message an unresolvable ref produces: a refusal must not
        // confirm that the session exists.
        `no session found for ${ALICES}`,
      )
    },
  )

  it('is not the issue gate refusing: Bob holds write on the task both sessions sit on', async () => {
    const dispatch = harness()
    // Bob reading his OWN session crosses the identical `checkIssueAccess` call
    // with the identical capability. If the issue gate were what refused above,
    // this would refuse too.
    const own = (await dispatch(BOB_CAP, false, 'sessions', 'status', { ref: BOBS })) as {
      sessionId: SessionId
    }
    expect(own.sessionId).toBe(BOBS)
  })

  it('lets the owner read her own session, transcript and all', async () => {
    const dispatch = harness()
    const status = (await dispatch(ALICE_CAP, false, 'sessions', 'status', {
      ref: ALICES,
    })) as { sessionId: SessionId; repo?: { log?: string } }
    expect(status.sessionId).toBe(ALICES)
    const read = (await dispatch(ALICE_CAP, false, 'sessions', 'read', {
      sessionId: ALICES,
    })) as { items: { text: string }[] }
    expect(read.items.map((i) => i.text)).toContain(SECRET)
  })

  it('lets a spawned session read ITSELF, whoever the task says owns it', async () => {
    // Not a redundant self-case. `principalForCapability` resolves the human at
    // the ROOT of the delegation chain (D16.2), which for this child is Bob;
    // its own durable owner is Alice (see `CHILD`). So the two disagree, and
    // without the self arm a session could not read its own transcript.
    const dispatch = harness()
    const read = (await dispatch(capabilityFor(CHILD, ALICE), false, 'sessions', 'read', {
      sessionId: CHILD,
    })) as { items: { text: string }[] }
    expect(read.items.map((i) => i.text)).toContain(SECRET)
  })

  it('lets a parent read the session it spawned, even when the task owns it', async () => {
    const dispatch = harness()
    const read = (await dispatch(BOB_CAP, false, 'sessions', 'read', {
      sessionId: CHILD,
    })) as { items: { text: string }[] }
    expect(read.items.map((i) => i.text)).toContain(SECRET)
  })
})
