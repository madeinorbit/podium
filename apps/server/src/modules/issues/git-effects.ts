/**
 * AN ISSUE'S GIT ACTIONS AS EFFECT RECORDS (ADR 12 D5 E2, POD-6394).
 *
 * Merge, rebase, PR and integrate are one-shot effects on an issue. Each runs as
 * an effect record of its own kind, so every device sees it pending, running at
 * a stage ("rebasing", "merging", "closing"), and how it ended, and a server
 * that stops mid-run settles it on the next boot instead of forgetting it.
 *
 *  - EXECUTORS: the work is `GitWorkflow.action` / `integrate`, unchanged, with
 *    its stages reported. A git failure is `failed` with the git output as the
 *    result; a refusal (not started, unknown issue) is `failed` with code
 *    `refused`. Runs are keyed by the record: a merge that finds its issue
 *    already landed answers `succeeded` without merging again.
 *  - RECOVERY: a merge checks the world. Landed (stamped, or the branch is in its
 *    parent) → it finishes the landing (stamp, close) and succeeds. Not in its
 *    parent → `failed`, nothing landed. The machine cannot say → `unknown`. A PR
 *    with a recorded URL succeeded; otherwise, and for rebase and integrate,
 *    `unknown`: the git state is the operator's to look at.
 *  - THE OLD COMMANDS (`issues.action`, `issues.integrate`, every transport) are
 *    adapters: they create the record through `sync.submit` as their caller, wait
 *    for it to settle, and answer `{ ok, output, issue }` as they always did, so
 *    the CLI, MCP, the agent relay and the phone see no change.
 */

import { randomUUID } from 'node:crypto'
import { asMutationId, mintDeviceId } from '@podium/model'
import { z } from 'zod'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { EffectRow } from '../../store/effects'
import type { EffectExecutor, EffectOutcome } from '../effects/registry'
import type { IssueCaller } from './command-ctx'
import { type AnyIssueCommandDef, issueRegistry } from './registry'
import type { IssueProjection } from '@podium/model'
import { isIssueNotFound } from './service/not-found'
import { IssueRefusal, isIssueRefusal } from './service/refusal'
import { issueTarget } from './sync-write'

export type IssueGitAction = 'merge' | 'rebase' | 'pr' | 'integrate'

export const ISSUE_GIT_EFFECT_KIND: Readonly<Record<IssueGitAction, string>> = {
  merge: 'issue.merge',
  rebase: 'issue.rebase',
  pr: 'issue.pr',
  integrate: 'issue.integrate',
}

/** How long a record may wait to start (ADR 12's merge example: ten minutes). */
export const ISSUE_GIT_DEADLINE_MS = 10 * 60 * 1000

/**
 * How long an old command waits for its record to settle. Longer than the work
 * can take (a merge is at most four 35 s git round trips and a close; an
 * integrate replays every child), so a caller that waited before still gets its
 * answer; past it the record keeps running and its status shows on the issue.
 */
export const ISSUE_GIT_WAIT_MS: Readonly<Record<IssueGitAction, number>> = {
  merge: 10 * 60 * 1000,
  rebase: 5 * 60 * 1000,
  pr: 5 * 60 * 1000,
  integrate: 30 * 60 * 1000,
}

/** The record's input: the issue is its target, so there is nothing else. */
const NoInput = z.object({}).strict()

/** What a settled git effect holds as its result. */
interface GitResult {
  readonly output: string
  readonly landedSha?: string
  readonly prUrl?: string
}

export interface IssueGitEffectDeps {
  /** The composed modules, read per call (registered before they exist). */
  modules(): RegistryModules
}

function defOf(name: 'action' | 'integrate'): AnyIssueCommandDef {
  const def = (issueRegistry.defs as Record<string, AnyIssueCommandDef>)[name]
  if (def === undefined) throw new Error(`git effects: no issue command named ${name}`)
  return def
}

function callerOf(principal: CommandPrincipal): IssueCaller | undefined {
  if (principal.kind === 'system') return undefined
  return { capability: principal.capability, principal }
}

/** The git answer as an outcome. */
function outcomeOf(r: { ok: boolean; output: string }, extra: Omit<GitResult, 'output'> = {}) {
  const result: GitResult = { output: r.output, ...extra }
  if (r.ok) return { status: 'succeeded', result } as const satisfies EffectOutcome
  const firstLine = r.output.split('\n').find((line) => line.trim() !== '') ?? 'git failed'
  return {
    status: 'failed',
    error: { code: 'git', message: firstLine.trim() },
    result,
  } as const satisfies EffectOutcome
}

/** A refusal or a vanished issue is a definitive failure, not a lost track. */
async function refusalsAsFailed(work: () => Promise<EffectOutcome>): Promise<EffectOutcome> {
  try {
    return await work()
  } catch (error) {
    if (isIssueRefusal(error) || isIssueNotFound(error)) {
      return {
        status: 'failed',
        error: { code: 'refused', message: (error as Error).message },
      }
    }
    throw error
  }
}

const UNKNOWN_GIT_STATE: EffectOutcome = {
  status: 'unknown',
  error: {
    code: 'lost-track',
    message: 'The server stopped while this ran; check the branch before running it again.',
  },
}

export function registerIssueGitEffects(deps: IssueGitEffectDeps): void {
  const effects = deps.modules().effects
  if (effects === undefined) throw new Error('git effects: no effects module')
  const workflow = () => deps.modules().issues.gitWorkflow

  /** The issue command's own scope check, on the record's issue. */
  const target =
    (name: 'action' | 'integrate') =>
    async (t: { kind: string; id: string }, principal: CommandPrincipal) => {
      const caller = callerOf(principal)
      if (caller === undefined || t.kind !== 'issue') return undefined
      return await issueTarget(deps.modules(), defOf(name), { id: t.id }, caller)
    }

  const gitAction = (action: 'merge' | 'rebase' | 'pr'): EffectExecutor<Record<string, never>> => ({
    kind: ISSUE_GIT_EFFECT_KIND[action],
    input: NoInput as z.ZodType<Record<string, never>>,
    target: target('action'),
    deadlineMs: ISSUE_GIT_DEADLINE_MS,
    run: async (ctx) =>
      await refusalsAsFailed(async () => {
        const issueId = ctx.record.target.id
        if (action === 'merge' && (await workflow().branchLanded(issueId)) === true) {
          // Keyed by the record: the work is already done (a replay, or a run
          // that crashed after the merge). Finish the landing; never merge twice.
          const issue = await workflow().finishLanding(issueId)
          return {
            status: 'succeeded',
            result: { output: 'already landed', ...landedOf(issue) },
          }
        }
        const r = await workflow().action(issueId, action, {
          onStage: async (stage) => await ctx.stage(stage),
        })
        return outcomeOf(r, action === 'merge' ? landedOf(r.issue) : prOf(r.issue))
      }),
    recover: async (ctx) =>
      await refusalsAsFailed(async () => {
        const issueId = ctx.record.target.id
        if (action === 'merge') {
          const landed = await workflow().branchLanded(issueId)
          if (landed === undefined) return UNKNOWN_GIT_STATE
          if (!landed) {
            return {
              status: 'failed',
              error: {
                code: 'interrupted',
                message: 'The server stopped before the merge; the branch is not in its parent.',
              },
            }
          }
          const issue = await workflow().finishLanding(issueId)
          return {
            status: 'succeeded',
            result: { output: 'landed before the server stopped', ...landedOf(issue) },
          }
        }
        if (action === 'pr') {
          const issue = await deps.modules().issues.reports.getMeta(issueId)
          if (issue?.prUrl)
            return { status: 'succeeded', result: { output: issue.prUrl, prUrl: issue.prUrl } }
        }
        return UNKNOWN_GIT_STATE
      }),
  })

  effects.executors.register(gitAction('merge'))
  effects.executors.register(gitAction('rebase'))
  effects.executors.register(gitAction('pr'))
  effects.executors.register<Record<string, never>>({
    kind: ISSUE_GIT_EFFECT_KIND.integrate,
    input: NoInput as z.ZodType<Record<string, never>>,
    target: target('integrate'),
    deadlineMs: ISSUE_GIT_DEADLINE_MS,
    run: async (ctx) =>
      await refusalsAsFailed(async () => {
        await ctx.stage('integrating')
        const r = await workflow().integrate(ctx.record.target.id, {
          actor: ctx.record.actor ?? `system:effect:${ctx.record.id}`,
          onBehalfOf: ctx.record.createdBy,
        })
        return outcomeOf(r)
      }),
    recover: async () => UNKNOWN_GIT_STATE,
  })
}

function landedOf(issue: IssueProjection | null | undefined): { landedSha?: string } {
  const sha = (issue as { landedSha?: string | null } | null | undefined)?.landedSha
  return sha ? { landedSha: sha } : {}
}

function prOf(issue: IssueProjection | null | undefined): { prUrl?: string } {
  const url = (issue as { prUrl?: string | null } | null | undefined)?.prUrl
  return url ? { prUrl: url } : {}
}

// ---------------------------------------------------------------------------
// The old commands as adapters
// ---------------------------------------------------------------------------

export interface IssueGitEffectPort {
  /** Run one git action as an effect record, as this caller; answer as the old command did. */
  run(
    caller: IssueCaller,
    action: IssueGitAction,
    ref: string,
  ): Promise<{ ok: boolean; output: string; issue: IssueProjection }>
}

export function issueGitEffectPort(deps: IssueGitEffectDeps): IssueGitEffectPort {
  return {
    run: async (caller, action, ref) => {
      const modules = deps.modules()
      const effects = modules.effects
      const principal = caller.principal
      if (effects === undefined || principal === undefined) {
        throw new Error(`issues.${action}: the effect path is not wired`)
      }
      const issueId = await modules.issues.reports.resolveRef(ref)
      const id = mintDeviceId('eff_')
      const { reply, cause } = await modules.syncWrite.submitDetailed(
        {
          mutationId: asMutationId(`mut_${action}_${randomUUID()}`),
          command: 'effects.create',
          version: 1,
          input: {
            id,
            kind: ISSUE_GIT_EFFECT_KIND[action],
            target: { kind: 'issue', id: issueId },
            input: {},
          },
          ...(caller.overrideScope === true ? { confirmed: true as const } : {}),
        },
        principal,
        // An agent reaches the issue commands over the daemon relay; a person over
        // tRPC (the apps, the CLI over HTTP, in-process MCP).
        principal.kind === 'agent' ? 'relay' : 'trpc',
      )
      if (reply.outcome !== 'applied') {
        if (cause !== undefined) throw cause
        throw new IssueRefusal(`issues.${action} was refused (${reply.refusal.kind})`)
      }
      const settled = await effects.awaitSettled(id, ISSUE_GIT_WAIT_MS[action])
      const issue = await modules.issues.gitWorkflow.projectionNow(issueId)
      return { ...answerOf(action, id, settled), issue }
    },
  }
}

/** The old command's `{ ok, output }` for a settled (or still running) record. */
function answerOf(
  action: IssueGitAction,
  id: string,
  row: EffectRow | undefined,
): { ok: boolean; output: string } {
  if (row === undefined) return { ok: false, output: `issues.${action}: effect ${id} is gone` }
  const output = (row.result as GitResult | undefined)?.output
  switch (row.status) {
    case 'succeeded':
      return { ok: true, output: output ?? '' }
    case 'failed':
      // A refusal answers as the refusal it always was.
      if (row.error?.code === 'refused') throw new IssueRefusal(row.error.message)
      return { ok: false, output: output ?? row.error?.message ?? 'failed' }
    case 'pending':
    case 'running':
      return {
        ok: false,
        output: `issues.${action} is still running as effect ${id}${row.stage ? ` (${row.stage})` : ''}; its status shows on the issue`,
      }
    default:
      return {
        ok: false,
        output: `issues.${action} ${row.status}: ${row.error?.message ?? ''}`.trim(),
      }
  }
}
