/**
 * THE DIRECT WRITES: the census of exceptions (ADR 12 D9, POD-6593).
 *
 * Every tRPC write is generated from a registration: a sync registration
 * (`sync.ts`) or a plain one (`plain.ts`). The commands named here are neither
 * YET. Each writes synced rows, so it cannot be plain (the plain scope refuses a
 * synced write), but it reaches its service directly, which writes through the
 * writer it was given at composition rather than a command's own: the `client`
 * origins in `write-contexts.ts`. Moving one onto the sync write entry point (a
 * registration with its target check) is its owner issue's work.
 *
 * So this table is to the routes what `SYSTEM_WRITE_ORIGINS` is to the writers:
 * the one place an exception is written down, visible in review, each with what
 * it writes and the issue that removes it. One exception is inside a sync
 * route rather than here: `sessions.rename`'s rollback branch
 * (`renamePath() === 'legacy'`) writes through the session-state envelope, and
 * is POD-6601's too. A route for a name not listed here
 * fails at module load; `write-routes/write-routes.test.ts` holds every mutation
 * the server serves to the sync registry, the plain registry or this table.
 */

import type { Context } from '../../trpc'
import {
  buildWriteRoute,
  type ParserIn,
  type ParserOut,
  type RouteMiddleware,
  type RouteParser,
  type WriteRoute,
} from './builder'

export interface DirectWriteSpec {
  readonly what: string
  /** The issue that moves it onto a registration, and removes this entry. */
  readonly owner: string
}

const ISSUE_DIRECT = 'POD-6603'
const SESSION_DIRECT = 'POD-6601'

/** The issues that move the census onto registrations; it reaches zero before
 *  the write audits are deleted (POD-6595). */
export const DIRECT_WRITE_OWNERS = [ISSUE_DIRECT, SESSION_DIRECT] as const

export const DIRECT_WRITES = {
  'issues.start': {
    what: "starts an issue's work: worktree, branch and agent session",
    owner: ISSUE_DIRECT,
  },
  'issues.action': {
    what: "runs an issue's workflow action (merge, rebase, …)",
    owner: ISSUE_DIRECT,
  },
  'issues.cleanup': { what: "frees an issue's worktree", owner: ISSUE_DIRECT },
  'issues.stop': { what: "stops an issue's sessions", owner: ISSUE_DIRECT },
  'issues.integrate': { what: "integrates an issue's branch onto its parent", owner: ISSUE_DIRECT },
  'issues.ship': { what: 'enqueues the current issue on its ship lane', owner: ISSUE_DIRECT },
  'issues.addSession': { what: 'adds an agent session to an issue', owner: ISSUE_DIRECT },
  'issues.addShell': { what: "adds a shell to an issue's worktree", owner: ISSUE_DIRECT },
  'issues.refreshAssistant': { what: "refreshes an issue's assistant state", owner: ISSUE_DIRECT },
  'issues.answerQuestion': {
    what: "answers an issue's pending agent question and clears its needs-human flag",
    owner: ISSUE_DIRECT,
  },
  'sessions.answerAskUserQuestion': {
    what: "answers a session's pending question through its daemon",
    owner: SESSION_DIRECT,
  },
  'sessions.configure': { what: "changes a live session's model or effort", owner: SESSION_DIRECT },
  'sessions.create': { what: 'creates a session on a machine', owner: SESSION_DIRECT },
  'sessions.hibernate': { what: 'parks a session', owner: SESSION_DIRECT },
  'sessions.interrupt': { what: "interrupts a session's turn", owner: SESSION_DIRECT },
  'sessions.kill': { what: "ends a session's process", owner: SESSION_DIRECT },
  'sessions.resume': { what: 'resumes a parked session', owner: SESSION_DIRECT },
  'sessions.resurrect': { what: 'brings an exited session back', owner: SESSION_DIRECT },
  'sessions.stop': { what: 'stops a session', owner: SESSION_DIRECT },
  'sessions.uploadImage': { what: "stages an image on a session's machine", owner: SESSION_DIRECT },
} as const satisfies Record<string, DirectWriteSpec>

export type DirectWriteName = keyof typeof DIRECT_WRITES

export const isDirectWrite = (name: string): name is DirectWriteName =>
  Object.hasOwn(DIRECT_WRITES, name)

export interface DirectRouteSpec<P extends RouteParser, Out> {
  /** The wire schema. */
  readonly input: P
  readonly use?: readonly RouteMiddleware[]
  readonly run: (call: { readonly ctx: Context; readonly input: ParserOut<P> }) => Promise<Out>
}

/** The route of one direct write in the census (see the header). */
export function directRoute<P extends RouteParser, Out>(
  name: string,
  spec: DirectRouteSpec<P, Out>,
): WriteRoute<ParserIn<P>, Out> {
  if (!isDirectWrite(name)) {
    throw new Error(
      `write routes: ${name} is in neither registry nor the direct-write census (write-routes/direct.ts)`,
    )
  }
  return buildWriteRoute(
    { registration: name, path: 'direct' },
    spec.input,
    spec.use ?? [],
    async ({ ctx, input }) => await spec.run({ ctx, input: input as ParserOut<P> }),
  ) as WriteRoute<ParserIn<P>, Out>
}
