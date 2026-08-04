/**
 * THE IN-PROCESS ISSUE COMMAND SURFACE — the third of the three concerns
 * `registry.ts` used to hold (POD-1398).
 *
 * The table declares WHAT the commands are; this declares HOW one is run. It is
 * the only consumer that needs both halves at runtime, which is why it sits at
 * the bottom of the dependency order (`command-ctx.ts` → `registry.ts` → here)
 * rather than beside either of them. Nothing imports it back: `relay.ts`
 * constructs it, and the daemon relay gate and in-process MCP call through it.
 *
 * Two derived surfaces live on it, both of which the pre-POD-311 code kept as
 * hand-mirrored duplicates: {@link IssueCommandDispatcher.dispatch}, the raw
 * relay/MCP pipeline (guard → parse → handle), and
 * {@link IssueCommandDispatcher.asIssueTrpc}, the typed `IssueTrpc` client the
 * in-process MCP tools call.
 */

import { ISSUE_COMMAND_NAMES, type IssueContractName } from '@podium/commands'
import type { IssueProc, IssueTrpc } from '@podium/issue-client'
import { spawnedByParentSessionId } from '@podium/model'
import { z } from 'zod'
import { resolvePrincipal } from '../../command-principal'
import type { Capability } from '../../issue-authz'
import { findSessionById } from '../sessions/session-by-id'
import {
  commandAccess,
  type IssueCaller,
  IssueCommandCtx,
  type IssueCommandDeps,
} from './command-ctx'
import { enforceExpectedRevision } from './conflict'
import { type AnyIssueCommandDef, guardIssueCommand, issueRegistry } from './registry'

/**
 * The in-process command surface derived from the registry: runs one command as
 * `caller` with the full router-equivalent pipeline (guard on the RAW input,
 * zod parse with the SAME schema the router mounts, then the handler), serving
 * the daemon relay gate and the in-process MCP. Replaces IssueCommandService's
 * 60-odd hand-mirrored methods and its Proxy adapters (callerFor/asIssueTrpc).
 */
export class IssueCommandDispatcher {
  constructor(private readonly deps: IssueCommandDeps) {}

  /** Execute one ALREADY-guarded, ALREADY-parsed command (the tRPC path: the
   *  derived middleware guarded, tRPC parsed `def.input`). */
  run<D extends AnyIssueCommandDef>(
    caller: IssueCaller,
    name: string,
    def: D,
    input: z.infer<D['input']>,
  ): ReturnType<D['handler']> {
    this.checkExpectedRevision(name, def, input)
    return def.handler(
      new IssueCommandCtx(this.deps, caller, name, def.target),
      input,
    ) as ReturnType<D['handler']>
  }

  /**
   * Refuse a write whose `expectedRevision` no longer matches the authority
   * (ADR 3 D13.3) — BEFORE the handler runs, so a stale write never reaches the
   * store.
   *
   * POD-1246: the catch-up merge brought the twenty-three `exp-rev` contracts and
   * their `expectedRevision` input key across from main, and `conflict.ts` with
   * them, but NOTHING CALLED IT — `enforceExpectedRevision` had zero callers on
   * this branch. The field parsed, validated and was then ignored, so every
   * caller that asked for conflict detection silently got none. That is the
   * fail-open shape: the protection is absent exactly when it is relied upon.
   *
   * Here rather than in the handlers, for the reason main gives: `run` is the one
   * choke point every issue mutation resolves through, so a new command cannot
   * forget the check. Thirty-nine handlers each remembering to wrap themselves is
   * a rule that holds until someone adds the fortieth.
   *
   * Only `exp-rev` contracts are checked. A command declaring `append` or `cmd`
   * has no revision baseline by definition, and reading a field its contract does
   * not carry would be guessing at its rule.
   *
   * A missing target issue is left to the handler: every issue write resolves its
   * row and throws `unknown issue …`, so nothing applies, and that NOT_FOUND
   * serves the caller better than a conflict blaming a revision. Hub-mirrored
   * issues take the same arm — `get()` reads local rows only, so the write
   * forwards with `expectedRevision` untouched and the HOME authority enforces
   * against its own row (ADR 1: one home authority).
   */
  private checkExpectedRevision(name: string, def: AnyIssueCommandDef, input: unknown): void {
    if (def.conflict !== 'exp-rev') return
    const envelope = (input ?? {}) as { expectedRevision?: number }
    if (envelope.expectedRevision == null) return
    const ref = def.target?.((input ?? {}) as Record<string, unknown>)
    if (ref == null) return
    const issue = this.deps.issues.reports.get(ref)
    if (!issue) return
    enforceExpectedRevision({
      command: `issues.${name}`,
      issueId: issue.id,
      expected: envelope.expectedRevision,
      actual: issue.revision,
    })
  }

  /**
   * Run one relayed/MCP command from RAW input: guard, parse, handle — the
   * exact pipeline the derived router applies. Returns undefined for an unknown
   * router/proc so callers can shape their own "no such procedure" reply.
   */
  dispatch(
    caller: IssueCaller,
    router: string,
    proc: string,
    rawInput: unknown,
  ): Promise<unknown> | undefined {
    if (router === 'repos') {
      if (proc !== 'inferFromPath') return undefined
      return Promise.resolve().then(() => {
        const input = z.object({ path: z.string() }).parse(rawInput)
        return { repoPath: this.deps.inferRepoFromPath(input.path) ?? null }
      })
    }
    if (router !== 'issues' || !Object.hasOwn(issueRegistry.defs, proc)) return undefined
    const effectiveCaller: IssueCaller = caller.principal
      ? caller
      : {
          ...caller,
          principal: resolvePrincipal(caller.capability, {
            parentSessionOf: (sessionId) =>
              spawnedByParentSessionId(findSessionById(this.deps, sessionId)?.spawnedBy),
          }),
        }
    const def = (issueRegistry.defs as Record<string, AnyIssueCommandDef>)[
      proc
    ] as AnyIssueCommandDef
    return Promise.resolve().then(() => {
      guardIssueCommand(effectiveCaller, commandAccess(this.deps.issues), proc, def, rawInput)
      const input: unknown = def.input.parse(rawInput)
      return this.run(effectiveCaller, proc, def, input)
    })
  }

  /**
   * IssueTrpc-shaped client (`.<router>.<proc>.mutate|query(input)`) for the
   * in-process MCP / shared issue command table — a plain object built over the
   * registry's key set (typed derivation), not a Proxy: an unknown proc is a
   * compile-time hole, not a runtime maybe.
   */
  asIssueTrpc(capability: Capability, overrideScope?: boolean): IssueTrpc {
    const principal = resolvePrincipal(capability, {
      parentSessionOf: (sessionId) =>
        spawnedByParentSessionId(findSessionById(this.deps, sessionId)?.spawnedBy),
    })
    const caller: IssueCaller = {
      capability,
      principal,
      ...(overrideScope ? { overrideScope } : {}),
    }
    const proc = (router: 'issues' | 'repos', name: string): IssueProc => {
      const call = (input?: unknown): Promise<unknown> => {
        const result = this.dispatch(caller, router, name, input)
        if (result === undefined) throw new Error(`no such issue procedure: ${router}.${name}`)
        return result
      }
      return { query: call, mutate: call }
    }
    const issues = Object.fromEntries(
      ISSUE_COMMAND_NAMES.map((name) => [name, proc('issues', name)]),
    ) as Record<IssueContractName, IssueProc>
    // The in-process surface never served the specs router (pspec rides the
    // daemon relay / HTTP only) — keep the historical "no such procedure" throw.
    const specProc = (name: string): IssueProc => {
      const call = (): Promise<unknown> => {
        throw new Error(`no such issue procedure: specs.${name}`)
      }
      return { query: call, mutate: call }
    }
    const specs = Object.fromEntries(
      ['list', 'get', 'create', 'save', 'remove', 'search'].map((n) => [n, specProc(n)]),
    )
    // Like specs, the in-process surface doesn't serve the lock router
    // [spec:SP-85d1] — locks ride the daemon relay / HTTP (podium lock CLI).
    const lockProc = (name: string): IssueProc => {
      const call = (): Promise<unknown> => {
        throw new Error(`no such issue procedure: lock.${name}`)
      }
      return { query: call, mutate: call }
    }
    const lock = Object.fromEntries(
      ['acquire', 'release', 'renew', 'status', 'steal'].map((n) => [n, lockProc(n)]),
    )
    return {
      issues,
      repos: { inferFromPath: proc('repos', 'inferFromPath') },
      specs,
      lock,
    } as IssueTrpc
  }
}
