import { asSessionId, asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { systemPrincipal, userCommandPrincipal } from '../../../command-principal'
import { SessionStore } from '../../../store'
import { type IssueDeps, IssueService } from './index'
import { issueTestPlumbing } from './test-plumbing'

/**
 * `addComment` must never invent a caller identity (POD-1315).
 *
 * IssueService.addComment used to declare
 *
 *     principal: CommandPrincipal = userCommandPrincipal(FIRST_ADMIN_USER_ID, 'admin')
 *
 * so a caller that simply forgot the argument silently acted as the instance
 * administrator. The count-occurrences-of-FIRST_ADMIN_USER_ID scan that watches
 * for ambient principals could not see it: a defaulted parameter and a harmless
 * mention of the constant look identical to a grep. The guard therefore has to
 * live in the type system, and the `@ts-expect-error` probes below are the
 * enforcement — not documentation of it.
 *
 * WHY `@ts-expect-error` IS THE ASSERTION. Each probe passes only while the
 * call beneath it is a type error. Re-add a default (or make the parameter
 * optional again) and the call becomes legal, the directive becomes UNUSED, and
 * `tsgo --noEmit` fails the whole build with TS2578 — this file does not even
 * have to run. Verified in both directions: with the default restored,
 * `bun run typecheck` reports TS2578 at each probe; with the default absent and
 * a directive deleted, it reports TS2554 "Expected 4 arguments, but got 3".
 */

function harness() {
  const store = new SessionStore(':memory:')
  const broadcast = vi.fn()
  const deps: IssueDeps = {
    store,
    listSessions: () => [],
    getSettings: () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(() => ({ sessionId: asSessionId('s1'), machine: 'machine-under-test' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing((msg) => broadcast(msg)),
    now: () => '2026-06-30T00:00:00.000Z',
  }
  const svc = new IssueService(deps)
  const issue = svc.create({ repoPath: '/r', title: 'A', startNow: false })
  return { store, svc, issue }
}

describe('addComment requires an explicit principal', () => {
  it('refuses a call that names no principal — flat service surface', () => {
    const { svc, issue } = harness()
    // @ts-expect-error POD-1315: omitting the principal must not compile. If this
    // directive is reported unused, a default has come back — restore the fix,
    // do not delete the directive.
    svc.addComment(issue.id, 'mike', 'no principal named')
  })

  it('refuses a call that names no principal — capability module surface', () => {
    const { svc, issue } = harness()
    // @ts-expect-error POD-1315: same guard one layer down. The flat service's
    // type is an INTERSECTION that includes this module's signature, so leaving
    // the module's parameter optional would keep 3-argument calls legal even
    // with the facade's default removed. Both surfaces are pinned deliberately.
    svc.commentsMail.addComment(issue.id, 'mike', 'no principal named')
  })

  it('refuses `undefined` passed explicitly, not just an omitted argument', () => {
    const { svc, issue } = harness()
    // @ts-expect-error POD-1315: an optional parameter would accept this too.
    svc.addComment(issue.id, 'mike', 'explicitly nobody', undefined)
  })

  it('attributes the comment to the named human, never to the first admin', () => {
    const { store, svc, issue } = harness()
    const alice = asUserId('user:alice')
    expect(alice).not.toBe(FIRST_ADMIN_USER_ID)

    svc.addComment(issue.id, 'alice', 'my note', userCommandPrincipal(alice, 'member'))

    const [comment] = store.issues.listIssueComments(issue.id)
    expect(comment?.actor).toBe(alice)
    expect(comment?.onBehalfOf).toBe(alice)
  })

  it('stamps a system job as a system actor with no human behind it', () => {
    const { store, svc, issue } = harness()

    svc.addComment(issue.id, 'system:cleanup', 'freed the worktree', systemPrincipal('cleanup'))

    const [comment] = store.issues.listIssueComments(issue.id)
    // Visibly a job, not a person — and `onBehalfOf` stays null rather than
    // being filled in with an operator (ADR 3 Amendment 1 D21.2).
    expect(comment?.actor).toBe('system:cleanup')
    expect(comment?.onBehalfOf).toBeNull()
  })

  it('always records attribution — a comment can no longer land anonymously', () => {
    const { store, svc, issue } = harness()

    svc.addComment(
      issue.id,
      'mike',
      'attributed',
      userCommandPrincipal(FIRST_ADMIN_USER_ID, 'admin'),
    )

    const [comment] = store.issues.listIssueComments(issue.id)
    expect(comment?.actor).not.toBeNull()
  })
})
