/** Add the synthetic world at the same collection boundaries as the server.
 * The server's real rows remain in order; full rows and related markers are
 * deduplicated by collection-fixture just as CollectionAnswer does. */
import { COLLECTIONS } from '@podium/model'
import { instanceKey } from '../../../packages/sync/src/replica/cache-state'

function mergeMarker(original, extra) {
  if (!extra?.range || !original.range) return original
  const page = COLLECTIONS.get(original.collection)?.page
  const before = (a, b) => {
    for (let i = 0; i < page.sort.length; i++) {
      if (a[i] === b[i]) continue
      if (a[i] == null) return false
      if (b[i] == null) return true
      return page.sort[i].direction === 'asc' ? a[i] < b[i] : a[i] > b[i]
    }
    return true
  }
  const a = original.range,
    b = extra.range
  const range = a.end ? b : b.end ? a : before(a.through, b.through) ? a : b
  const out = { ...original, range: { ...range, end: a.end && b.end } }
  if (typeof original.total === 'number' && typeof extra.total === 'number')
    out.total = original.total + extra.total
  return out
}

export function augmentAnswer(records, fixture, requested = []) {
  const first = records[0],
    complete = records.at(-1)
  const chunks = records.filter((x) => x.type === 'feedBootstrap')
  const changes = chunks.flatMap((x) => x.changes)
  const requestedByKey = new Map(requested.map((spec) => [instanceKey(spec), spec]))
  const roots = records
    .filter((x) => x.type === 'collectionComplete')
    .flatMap((x) => x.instances)
    .map((marker) => ({ ...marker, ...requestedByKey.get(instanceKey(marker)), part: marker.part }))
  const canonical = new Set(roots.map(instanceKey))
  const answer = fixture.close(roots)
  fixture.validate(answer)
  const markers = new Map(answer.markers.map((marker) => [instanceKey(marker), marker]))
  const groups = new Map()
  for (const event of answer.events) {
    const list = groups.get(event.root) ?? []
    list.push(event)
    groups.set(event.root, list)
  }
  // POD-7122: an answer whose records are all synthetic has no server chunk
  // to copy; its rows still need a well-formed feedBootstrap envelope, or the
  // client refuses the line (invalid-record) and the loader asks again forever.
  const envelope = chunks[0] ?? {
    type: 'feedBootstrap',
    feedId: first.feedId,
    epoch: first.epoch,
    minAvailableSeq: first.minAvailableSeq,
  }
  const template = { ...envelope, fromSeq: 0, seq: first.seq, last: false }
  delete template.countsByEntity
  const all = []
  const rows = (values) => {
    for (let at = 0; at < values.length; at += 64) {
      const slice = values.slice(at, at + 64),
        stub = slice[0].part === 'stub'
      const changes = slice.map((row) => ({
        entity: row.entity,
        entityId: row.entityId,
        value: row.value,
        seq: first.seq,
        op: 'upsert',
        ...(stub ? { part: 'stub' } : {}),
      }))
      all.push(
        stub
          ? {
              type: 'feedStubs',
              feedId: first.feedId,
              epoch: first.epoch,
              fromSeq: 0,
              seq: first.seq,
              minAvailableSeq: template.minAvailableSeq,
              changes,
            }
          : { ...template, changes },
      )
    }
  }
  const mark = (instances) => {
    for (let at = 0; at < instances.length; at += 1000)
      all.push({
        type: 'collectionComplete',
        feedId: first.feedId,
        epoch: first.epoch,
        seq: first.seq,
        instances: instances.slice(at, at + 1000),
      })
  }
  for (const record of records.slice(1, -1)) {
    if (record.type !== 'collectionComplete') {
      const next = record.type === 'feedBootstrap' ? { ...record, last: false } : record
      delete next.countsByEntity
      all.push(next)
      continue
    }
    const after = []
    for (const original of record.instances) {
      const events = groups.get(instanceKey(original)) ?? []
      if (events.length) {
        rows(events[0].rows)
        after.push(...events.slice(1))
      }
    }
    mark(
      record.instances.map((original) => mergeMarker(original, markers.get(instanceKey(original)))),
    )
    for (const event of after) {
      rows(event.rows)
      mark(event.markers.filter((marker) => !canonical.has(instanceKey(marker))))
    }
  }
  all.push({ ...template, last: true, changes: [] })
  const count = all.reduce((n, record) => n + (record.changes?.length ?? 0), 0)
  for (const record of all) if (record.type === 'feedBootstrap') record.totalRows = count
  const body =
    [{ ...first, totalRows: count }, ...all, { ...complete, rows: count, records: all.length }]
      .map((x) => JSON.stringify(x))
      .join('\n') + '\n'
  const whole = answer.rows.filter((row) => row.part !== 'stub')
  return {
    body,
    first,
    chunks,
    count,
    changes,
    counts: {
      issues: whole.filter((row) => row.entity === 'issueProjection').length,
      sessions: whole.filter((row) => row.entity === 'session').length,
      stubs: answer.rows.length - whole.length,
      whole: whole.length,
    },
  }
}
