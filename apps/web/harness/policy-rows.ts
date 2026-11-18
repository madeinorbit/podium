/**
 * POD-7094 — the synthetic corpus as the server's first download serves it
 * (design POD-7059 "Collections", "Policy", "Comes with").
 *
 * The cold-start collector feeds the client the corpus inside the routed
 * `/sync/bootstrap` answer. Since POD-7086 the client installs every whole
 * record of an answer as held, so appending the whole corpus would put all
 * history on the device and measure the harness, not the design. This
 * splits the rows the way the policy does, with the shared declarations
 * (`@podium/model` `records/declarations.ts`) and their rule evaluator:
 * - a record of a by-rule kind is whole when a collection of the policy's
 *   steps holds it (`matchesWhere`), or when a held record comes with it: a
 *   session comes with its issue, an issue with its parents, a sidebar issue
 *   with its sessions that are not archived;
 * - a record that comes with an issue or a session is whole when that one is;
 * - the always kinds and the windowed ones are whole; body records are not
 *   sent (they load when an issue is opened);
 * - every issue that is not whole goes as a stub; any other record is left
 *   out.
 * The rule evaluator is the client's own, so a rule change follows here.
 */
import { COLLECTIONS, matchesWhere, recordOf, type Where } from '@podium/model'

export interface WireRow {
  readonly entity: string
  readonly entityId: string
  readonly value: Record<string, unknown>
}

export interface PolicyStepWire {
  readonly step: string
  readonly collections: readonly string[]
}

export interface PolicyWire {
  readonly steps: readonly PolicyStepWire[]
  readonly recentDays: number
}

export interface PolicyRows {
  /** Whole records, in corpus order. */
  readonly whole: WireRow[]
  /** Issue stubs: the stub fields picked from the issue. */
  readonly stubs: WireRow[]
  readonly counts: {
    readonly issues: number
    readonly sessions: number
    readonly stubs: number
    readonly dropped: number
  }
}

const ISSUE = 'issueProjection'
const SESSION = 'session'

export function policyRows(rows: readonly WireRow[], policy: PolicyWire, now: number): PolicyRows {
  const args = { recentDays: policy.recentDays }
  const held = new Map<string, Set<string>>()
  const hold = (kind: string, id: string) => {
    let ids = held.get(kind)
    if (ids === undefined) held.set(kind, (ids = new Set()))
    ids.add(id)
  }
  const holds = (kind: string, id: string) => held.get(kind)?.has(id) === true
  const byKind = new Map<string, WireRow[]>()
  for (const row of rows) {
    let list = byKind.get(row.entity)
    if (list === undefined) byKind.set(row.entity, (list = []))
    list.push(row)
  }
  // Collections the policy holds, by kind (main part only; the stubs step is the stub part).
  const rules = new Map<string, { id: string; where: Where | undefined }[]>()
  for (const step of policy.steps)
    for (const id of step.collections) {
      const collection = COLLECTIONS.get(id)
      if (collection === undefined || collection.part === 'stub') continue
      let list = rules.get(collection.of)
      if (list === undefined) rules.set(collection.of, (list = []))
      list.push({ id, where: collection.where })
    }
  const sidebar = new Set<string>()
  for (const [kind, list] of rules)
    for (const row of byKind.get(kind) ?? [])
      for (const rule of list)
        if (rule.where === undefined || matchesWhere(rule.where, row.value, { now, args })) {
          hold(kind, row.entityId)
          if (rule.id === `${ISSUE}.sidebar`) sidebar.add(row.entityId)
        }
  const issues = new Map((byKind.get(ISSUE) ?? []).map((row) => [row.entityId, row.value]))
  // A sidebar issue comes with its sessions that are not archived.
  for (const row of byKind.get(SESSION) ?? []) {
    const issueId = row.value['issueId']
    if (typeof issueId === 'string' && sidebar.has(issueId) && row.value['archived'] !== true)
      hold(SESSION, row.entityId)
  }
  // A session comes with its issue.
  for (const row of byKind.get(SESSION) ?? []) {
    if (!holds(SESSION, row.entityId)) continue
    const issueId = row.value['issueId']
    if (typeof issueId === 'string' && issues.has(issueId)) hold(ISSUE, issueId)
  }
  // An issue comes with its parent, and so every ancestor.
  for (const id of [...(held.get(ISSUE) ?? [])]) {
    let parent = issues.get(id)?.['parentId']
    while (typeof parent === 'string' && issues.has(parent) && !holds(ISSUE, parent)) {
      hold(ISSUE, parent)
      parent = issues.get(parent)?.['parentId']
    }
  }
  const whole: WireRow[] = []
  const stubs: WireRow[] = []
  let dropped = 0
  const stubFields = recordOf(ISSUE)?.stub ?? []
  for (const row of rows) {
    const declaration = recordOf(row.entity)
    const group = declaration?.group
    let keep: boolean
    if (group === 'byRule') keep = holds(row.entity, row.entityId)
    else if (group === 'comesWithIssue' || group === 'comesWithSession') {
      const to = group === 'comesWithIssue' ? ISSUE : SESSION
      keep = Object.entries(declaration?.links ?? {}).some(([field, link]) => {
        const target = row.value[field]
        return (link as { to: string }).to === to && typeof target === 'string' && holds(to, target)
      })
    } else keep = group !== 'body'
    if (keep) whole.push(row)
    else if (row.entity === ISSUE) {
      const stub: Record<string, unknown> = {}
      for (const field of stubFields)
        if (row.value[field] !== undefined) stub[field] = row.value[field]
      stubs.push({ entity: ISSUE, entityId: row.entityId, value: stub })
    } else dropped += 1
  }
  return {
    whole,
    stubs,
    counts: {
      issues: held.get(ISSUE)?.size ?? 0,
      sessions: held.get(SESSION)?.size ?? 0,
      stubs: stubs.length,
      dropped,
    },
  }
}
