/**
 * THE ISSUE AS A GENERIC RECORD (ADR 12 D3/D4, POD-6391).
 *
 * The adapter between the generic commands and the issue family. It adds no
 * issue logic of its own: a create runs the family's `create` and an edit its
 * `update`, through the same dispatcher the old routes use, so the family's
 * guards (agent proposals, decision closes, label rules) and its Authority
 * arbitration of `exp-rev` apply exactly as they do there. The generic layer has
 * already refused the fields a client may not write, required the revision, and
 * refused a create on an id that exists.
 *
 * A create files the issue without starting it. `seq`, the human number, is the
 * label the family fills in inside the same write (`nextIssueSeq`).
 */

import { ISSUE_RECORD } from '@podium/commands'
import type { CommandPrincipal } from '../../command-principal'
import type { RegistryModules } from '../../relay'
import type { IssueCaller } from '../issues/command-ctx'
import { type AnyIssueCommandDef, issueRegistry } from '../issues/registry'
import { issueRefusalOf, issueTarget } from '../issues/sync-write'
import { SyncWriteRefused } from '../sync-write/entry'
import { NO_TARGET, type SyncWriteContext, type SyncWriteRegistry } from '../sync-write/registry'
import { registerRecordKind } from './generic'

export interface IssueRecordDeps {
  modules(): RegistryModules
}

function callerOf(principal: CommandPrincipal): IssueCaller | undefined {
  if (principal.kind === 'system') return undefined
  return { capability: principal.capability, principal }
}

type FamilyCommand = 'create' | 'update' | 'setLabels' | 'defer' | 'undefer'

function defOf(name: FamilyCommand): AnyIssueCommandDef {
  const def = (issueRegistry.defs as Record<string, AnyIssueCommandDef>)[name]
  if (def === undefined) throw new Error(`records: no issue command named ${name}`)
  return def
}

export function registerIssueRecord(registry: SyncWriteRegistry, deps: IssueRecordDeps): void {
  /** One family command, without its own dedup (the entry point has deduplicated). */
  const run = async (ctx: SyncWriteContext, name: FamilyCommand, input: unknown) => {
    const principal = callerOf(ctx.principal)
    if (principal === undefined) throw new Error('issue record write reached its handler as system')
    // The write commits on this command's own writer, as every sync handler's.
    const caller: IssueCaller = { ...principal, writer: ctx.ledger }
    const def = defOf(name)
    // `run` takes ALREADY-parsed input, as the tRPC path hands it: parse with the
    // family's own schema so its defaults and transforms apply.
    const parsed = def.input.safeParse(input)
    if (!parsed.success) {
      throw new SyncWriteRefused({
        kind: 'invalid',
        details: [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))],
      })
    }
    try {
      return await deps.modules().issueCommands.withoutDedup().run(caller, name, def, parsed.data)
    } catch (error) {
      const refusal = issueRefusalOf(error)
      if (refusal === undefined) throw error
      throw new SyncWriteRefused(refusal, { cause: error })
    }
  }

  registerRecordKind(registry, ISSUE_RECORD, {
    target: async (op, id, { principal }) => {
      const caller = callerOf(principal)
      if (caller === undefined) return undefined
      // A create is additive, as `issues.create`: the role decides.
      if (op === 'create') return NO_TARGET
      return await issueTarget(deps.modules(), defOf('update'), { id }, caller)
    },
    read: async (id) => {
      // `getMeta` also resolves display refs; a record is addressed by its id only.
      const row = await deps.modules().issues.reports.getMeta(id)
      return row !== null && row.id === id ? { revision: row.revision ?? undefined } : undefined
    },
    create: async (ctx, id, fields) => await run(ctx, 'create', { ...fields, id, startNow: false }),
    // EACH PLAIN FIELD THROUGH THE FAMILY COMMAND THAT OWNS IT (POD-6405), so
    // its rules and events are the family's: labels through `setLabels` (the
    // label rules, the normalized set), a past `deferUntil` through `undefer`
    // (the backdate on the server's clock and `issue.unsnoozed`, never a
    // misfired `issue.snoozed`), a cleared one through `defer(null)`, and the
    // rest through `update`. All in this one unit of work.
    edit: async (ctx, id, patch, expectedRevision, unset) => {
      if (unset.some((name) => name !== 'deferUntil')) {
        throw new SyncWriteRefused({ kind: 'invalid', details: ['unset'] })
      }
      const { labels, deferUntil, ...rest } = patch
      let last: unknown
      if (Object.keys(rest).length > 0) {
        last = await run(ctx, 'update', {
          id,
          patch: rest,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        })
      }
      if (labels !== undefined) last = await run(ctx, 'setLabels', { id, labels })
      if (unset.includes('deferUntil')) last = await run(ctx, 'defer', { id, until: null })
      else if (typeof deferUntil === 'string') {
        const at = Date.parse(deferUntil)
        last =
          Number.isFinite(at) && at <= Date.now()
            ? await run(ctx, 'undefer', { id })
            : await run(ctx, 'update', { id, patch: { deferUntil } })
      }
      return last
    },
  })
}
