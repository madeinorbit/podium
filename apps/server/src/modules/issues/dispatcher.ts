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

import {
  ISSUE_COMMAND_NAMES,
  type IssueContractName,
  runsAsArtifactEffect,
  writesThroughEntry,
} from '@podium/commands'
import type { IssueProc, IssueTrpc } from '@podium/issue-client'
import { spawnedByParentSessionId, type UserId } from '@podium/model'
import { SyncSubmitRefusedError } from '@podium/protocol'
import type { MutationLedgerPort, ReceiptCompaction } from '@podium/sync'
import { z } from 'zod'
import {
  actsInOrReport,
  type CommandPrincipal,
  onBehalfOfUser,
  resolvePrincipalAsync,
} from '../../command-principal'
import type { Capability } from '../../issue-authz'
import { foreignPrincipalRefusal } from '../front-door'
import type { SyncWriteEntry } from '../sync-write/entry'
import { ARTIFACT_TRANSPORT, type ArtifactCall } from './artifact-effect-record'
import {
  commandAccess,
  type IssueCaller,
  IssueCommandCtx,
  type IssueCommandDeps,
} from './command-ctx'
import { withoutHiddenTaskFields } from './execution-visibility'
import { issueReceiptCompaction } from './receipt-digest'
import { type AnyIssueCommandDef, guardIssueCommand, issueRegistry } from './registry'
import { NO_SUCH_PROCEDURE } from './relay-gate'
import { answerMailSendAsBefore, startAfterCreate, submitIssueWrite } from './sync-write'
import { isIssueWorkCommand } from './work-effects'

/** A ledger that runs the body every time and records nothing: see `withoutDedup`. */
const RUN_EVERY_TIME: MutationLedgerPort = {
  apply: async <T>(
    _id: unknown,
    _proc: string,
    body: () => T | Promise<T>,
  ): Promise<{ outcome: 'applied'; value: Awaited<T> }> => ({
    outcome: 'applied',
    value: await body(),
  }),
  once: async <T>(_id: unknown, _proc: string, body: () => T | Promise<T>): Promise<Awaited<T>> =>
    await body(),
}

/** Whose eyes a command's result is for: the person, or an agent's human. A
 *  system job reads for the server itself (`null`). A bare in-process caller
 *  with no principal is decided by the human its capability names. */
function resultViewer(caller: IssueCaller): UserId | null {
  if (caller.principal) return onBehalfOfUser(caller.principal)
  return caller.capability.onBehalfOf ?? null
}

/**
 * The in-process command surface derived from the registry: runs one command as
 * `caller` with the full router-equivalent pipeline (guard on the RAW input,
 * zod parse with the SAME schema the router mounts, then the handler), serving
 * the daemon relay gate and the in-process MCP. Replaces IssueCommandService's
 * 60-odd hand-mirrored methods and its Proxy adapters (callerFor/asIssueTrpc).
 */
export class IssueCommandDispatcher {
  constructor(private readonly deps: IssueCommandDeps) {}

  /**
   * This dispatcher with its handlers' dedup turned off, for the sync write
   * entry point (POD-6350). The entry point has already deduplicated the call by
   * the envelope's mutationId and holds that id in flight while the handler
   * runs; a handler's own `withMutation` under the same id would join the
   * in-flight owner, which is itself, and never return. Everything else (the
   * arbitration, the services) is this dispatcher's.
   */
  withoutDedup(): IssueCommandDispatcher {
    return new IssueCommandDispatcher({ ...this.deps, mutations: RUN_EVERY_TIME })
  }

  /**
   * This dispatcher running the commands that act on machines inline, for their
   * own effect executors (POD-6414): the executor IS the run the record stands
   * for, so it must not create another record.
   */
  withoutEffects(): IssueCommandDispatcher {
    const { workEffects: _workEffects, ...deps } = this.deps
    return new IssueCommandDispatcher(deps)
  }

  /**
   * This dispatcher for an effect record's run (POD-6603): the commands that
   * act on machines inline ({@link withoutEffects}), writing as the issue
   * service's own work after the record committed (`effectRunWriter`, the
   * `issues.server` origin) when the caller brings no writer.
   */
  forEffectRun(): IssueCommandDispatcher {
    const { workEffects: _workEffects, ...deps } = this.deps
    const writer = this.deps.effectRunWriter
    if (writer === undefined) return new IssueCommandDispatcher(deps)
    return new IssueCommandDispatcher({ ...deps, directWriter: writer })
  }

  /** Execute one ALREADY-guarded, ALREADY-parsed command (the tRPC path: the
   *  derived middleware guarded, tRPC parsed `def.input`). */
  async run<D extends AnyIssueCommandDef>(
    caller: IssueCaller,
    name: string,
    def: D,
    input: z.infer<D['input']>,
  ): Promise<Awaited<ReturnType<D['handler']>>> {
    // The same check as `dispatch`: the tRPC and effect-run callers bring their
    // principal, which must act in this store's workspace (POD-7483).
    this.refuseForeignPrincipal(caller)
    // A command that acts on machines runs as an effect record (POD-6414): on
    // every transport its old answer comes from the record once it settles, and
    // it never runs here (POD-6603). Only the record's own executor, through
    // `forEffectRun`, runs the handler below.
    const work = this.deps.workEffects
    if (work !== undefined && isIssueWorkCommand(name)) {
      return await this.visibleResult(
        caller,
        (await work.run(caller, name, input)) as Awaited<ReturnType<D['handler']>>,
      )
    }
    // A panelApply artifact op moves files in an effect record (POD-6420). Ahead
    // of the revision arbitration: the record's commit is a panelApply of its
    // own, arbitrated where it runs, and arbitration scopes do not nest.
    const artifacts = this.deps.artifactEffects
    if (artifacts !== undefined && runsAsArtifactEffect(name, input)) {
      const answer = await artifacts.run(caller, input as ArtifactCall)
      if (answer !== ARTIFACT_TRANSPORT)
        return await this.visibleResult(caller, answer as Awaited<ReturnType<D['handler']>>)
      // An upload's byte packet: the handler stages it, writing no issue, so it
      // runs without a writer (POD-6605).
    }
    // The result leaves for a person or an agent: the task fields that point
    // into someone else's private work are taken out first (design §4.2).
    const execute = async (): Promise<Awaited<ReturnType<D['handler']>>> =>
      await this.visibleResult(
        caller,
        (await def.handler(
          new IssueCommandCtx(this.deps, caller, name, def.target),
          input,
        )) as Awaited<ReturnType<D['handler']>>,
      )
    if (def.conflict !== 'exp-rev') return await execute()

    const envelope = (input ?? {}) as { expectedRevision?: number }
    const ref = def.target?.((input ?? {}) as Record<string, unknown>)
    if (ref == null) return await execute()
    // Arbitration needs identity and revision, not a report that enumerates
    // every issue to derive children and joins the target's session history.
    const issue = await this.deps.issues.reports.getMeta(ref)
    if (!issue) return await execute()

    return await this.deps.arbitration.run(
      {
        command: `issues.${name}`,
        issueId: issue.id,
        ...(envelope.expectedRevision === undefined
          ? {}
          : { expectedRevision: envelope.expectedRevision }),
        currentRevision: async () => (await this.deps.issues.reports.getMeta(issue.id))?.revision,
      },
      execute,
    )
  }

  /**
   * How one call's receipt stores a large answer and how a replay rebuilds it
   * (POD-7035, `receipt-digest.ts`): as `caller`, with this dispatcher's
   * services and private-field rule.
   */
  receiptCompaction(caller: IssueCaller, name: string, input: unknown): ReceiptCompaction {
    const def = (issueRegistry.defs as Record<string, AnyIssueCommandDef>)[name]
    return issueReceiptCompaction(name, input, {
      context: () => new IssueCommandCtx(this.deps, caller, name, def?.target),
      visible: async (value) => await this.visibleResult(caller, value),
    })
  }

  /** Every transport and effect answer obeys the caller's private-field rule. */
  async visibleResult<T>(caller: IssueCaller, value: T): Promise<T> {
    return await withoutHiddenTaskFields(value, resultViewer(caller), this.deps.executionFacts)
  }

  /**
   * Run one relayed/MCP command from RAW input: guard, parse, handle — the
   * exact pipeline the derived router applies. Unknown router/proc pairs return
   * NO_SUCH_PROCEDURE; a real command may successfully resolve to undefined.
   */
  async dispatch(
    caller: IssueCaller,
    router: string,
    proc: string,
    rawInput: unknown,
    transport: 'relay' | 'mcp' = 'relay',
  ): Promise<unknown> {
    if (router === 'repos') {
      if (proc !== 'inferFromPath') return NO_SUCH_PROCEDURE
      const input = z.object({ path: z.string() }).parse(rawInput)
      return { repoPath: (await this.deps.inferRepoFromPath(input.path)) ?? null }
    }
    if (router !== 'issues' || !Object.hasOwn(issueRegistry.defs, proc)) return NO_SUCH_PROCEDURE
    const effectiveCaller: IssueCaller = caller.principal
      ? caller
      : {
          ...caller,
          principal: await resolvePrincipalAsync(this.deps.workspaceId, caller.capability, {
            parentSessionOf: async (sessionId) =>
              spawnedByParentSessionId((await this.deps.sessionById(sessionId))?.spawnedBy),
          }),
        }
    // A caller's own principal must act in this store's workspace (POD-7483).
    // Until capabilities carry their workspace (POD-7558), a principal resolved
    // just above names this registry's workspace by construction, so the check
    // can fail only for a principal the caller brought: the sync write family's.
    // Relayed and MCP callers bring none today.
    this.refuseForeignPrincipal(effectiveCaller)
    const def = (issueRegistry.defs as Record<string, AnyIssueCommandDef>)[
      proc
    ] as AnyIssueCommandDef
    return await Promise.resolve().then(async () => {
      await guardIssueCommand(effectiveCaller, commandAccess(this.deps.issues), proc, def, rawInput)
      const input: unknown = def.input.parse(rawInput)
      const entry = this.deps.syncWrite?.()
      const principal = effectiveCaller.principal
      if (entry !== undefined && principal !== undefined && writesThroughEntry(proc, input)) {
        return await this.throughEntry(
          entry,
          { ...effectiveCaller, principal },
          transport,
          proc,
          input,
        )
      }
      return await this.run(effectiveCaller, proc, def, input)
    })
  }

  /** Refuse a caller whose principal is another workspace's, as a non-member. */
  private refuseForeignPrincipal(caller: IssueCaller): void {
    const principal = caller.principal
    if (principal && !actsInOrReport(principal, this.deps.workspaceId, 'issue-dispatch')) {
      throw foreignPrincipalRefusal()
    }
  }

  /**
   * A listed write (`SYNCED_ISSUE_COMMANDS`) through the sync write entry point
   * (ADR 12 D2, POD-6413): this transport's thin adapter. The guard above has
   * already run, so a refused caller keeps the message it always got; the entry
   * point checks again, deduplicates and runs the handler in one unit of work.
   * Relay and MCP callers read the thrown error's message, so a handler's own
   * error is rethrown as it was; a refusal with none reads as its plain sentence.
   */
  private async throughEntry(
    entry: Pick<SyncWriteEntry, 'submitDetailed'>,
    caller: IssueCaller & { principal: CommandPrincipal },
    transport: 'relay' | 'mcp',
    proc: string,
    input: unknown,
  ): Promise<unknown> {
    const { reply, cause } = await submitIssueWrite(entry, {
      principal: caller.principal,
      transport,
      name: proc,
      input,
      confirmed: caller.overrideScope === true,
    })
    if (reply.outcome !== 'applied') {
      if (cause !== undefined) throw cause
      throw new SyncSubmitRefusedError(`issues.${proc}`, reply.refusal)
    }
    if (proc === 'mailSend')
      return await answerMailSendAsBefore(this.deps.mailHandOnOf, reply.result)
    if (proc !== 'create') return reply.result
    return await this.visibleResult(
      caller,
      await startAfterCreate(this.deps.issues, caller, input, reply.result, this),
    )
  }

  /**
   * IssueTrpc-shaped client (`.<router>.<proc>.mutate|query(input)`) for the
   * in-process MCP / shared issue command table — a plain object built over the
   * registry's key set (typed derivation), not a Proxy: an unknown proc is a
   * compile-time hole, not a runtime maybe.
   */
  asIssueTrpc(capability: Capability, overrideScope?: boolean): IssueTrpc {
    // The in-process MCP surface (the superagent's issue tools): its writes reach
    // the entry point as MCP calls.
    const caller: IssueCaller = {
      capability,
      ...(overrideScope ? { overrideScope } : {}),
    }
    const proc = (router: 'issues' | 'repos', name: string): IssueProc => {
      const call = async (input?: unknown): Promise<unknown> => {
        const result = await this.dispatch(caller, router, name, input, 'mcp')
        if (result === NO_SUCH_PROCEDURE)
          throw new Error(`no such issue procedure: ${router}.${name}`)
        return result
      }
      return { query: call, mutate: call }
    }
    const issues = Object.fromEntries(
      ISSUE_COMMAND_NAMES.map((name) => [name, proc('issues', name)]),
    ) as Record<IssueContractName, IssueProc>
    // The in-process surface doesn't serve the lock router
    // — locks ride the daemon relay / HTTP (podium lock CLI).
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
      lock,
    } as IssueTrpc
  }
}
