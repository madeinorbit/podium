import { parseIssueEventRowId } from '@podium/model'
import type { SqlDatabase } from '@podium/runtime/sqlite'
import { GrantEdgeVisibilityPolicy, NoDelegationsGranted, SyncRepository } from '@podium/sync/bootstrap-worker'
import { makeFeedVisibility } from '../feed-visibility'
import { syncServerTables } from '../migrations/sync-server-tables'
import type { WorldIndexReader } from '../modules/world-index'
import { createBunStoreExecutor } from '../store/executor/bun-driver'
import { IssuesRepository } from '../store/issues'
import { SessionsRepository } from '../store/sessions'
import { ShippingRepository } from '../store/shipping'
import { AutomationsRepository } from '../store/automations'
import { GrantsRepository, type GrantRow } from '../store/grants'

const unsupported = (): never => { throw new Error('snapshot cannot use writer state') }
const key = (kind: string, id: string) => JSON.stringify([kind, id])

/** Construct only query repositories: no SessionStore, migrations, authority or publication. */
export function bootstrapVisibility(database: SqlDatabase) {
  const executor = createBunStoreExecutor({ database })
  const context = (async () => {
  const q = executor.queries
  const grants = new GrantsRepository(q)
  const byResource = new Map<string, GrantRow[]>()
  // Caller has already established the read transaction; grants belong to its snapshot.
  for (const grant of await grants.loadWorldGrants()) {
    const k = key(grant.resourceKind, grant.resourceId)
    const rows = byResource.get(k) ?? []
    rows.push(grant)
    byResource.set(k, rows)
  }
  const worldIndex: WorldIndexReader = {
    grantsFor: (kind, id) => byResource.get(key(kind, id)) ?? [],
    issueForWorktree: unsupported, pendingCount: unsupported, user: unsupported, machine: unsupported,
  }
  const sync = new SyncRepository(q, syncServerTables)
  // The publisher mutates its window before capture and may swallow failure
  // (POD-4033). Only committed rows belong to this snapshot, in event-id order.
  const eventSubjects = new Map<string, { entity: 'issueEvent'; entityId: string }[]>()
  const eventRows = database.prepare("SELECT entity_id FROM change_latest WHERE entity = 'issueEvent'").all() as { entity_id: string }[]
  const events = eventRows.flatMap(row => {
    try { return [{ ...parseIssueEventRowId(row.entity_id), entityId: row.entity_id }] }
    catch { return [] }
  }).sort((a, b) => a.eventId - b.eventId)
  for (const event of events) {
    const subjects = eventSubjects.get(event.subject) ?? []
    subjects.push({ entity: 'issueEvent', entityId: event.entityId })
    eventSubjects.set(event.subject, subjects)
  }
  const visibility = makeFeedVisibility({
    store: {
      issues: new IssuesRepository(q, unsupported),
      sessions: new SessionsRepository(q, unsupported),
      shipping: new ShippingRepository(q),
      automations: new AutomationsRepository(q),
      sync,
    },
    worldIndex,
    audienceResourceIds: kind => grants.visibilityAudienceResourceIds(kind),
    audienceFor: (kind, id) => grants.visibilityAudienceFor(kind, id),
    // A job-local cache lives only as long as this immutable read snapshot.
    authorizationRevision: () => sync.maxChangeSeq(),
    issueEventSubjects: issueId => eventSubjects.get(issueId) ?? [],
  })
  return { policy: new GrantEdgeVisibilityPolicy(visibility.state, new NoDelegationsGranted()), anchors: visibility.anchors, sync }
  })()
  // Return ownership before the first async read can fail, so the caller always closes it.
  return { context, get policy() { return context.then(value => value.policy) }, executor }
}
