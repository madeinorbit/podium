import type { EffectiveChanges, EffectiveLocalState, EffectivePublication } from '../engine/effective-changes'
import { REPLICA_BINDING_KINDS } from '../engine/replica-binding'
import type { ReplicaKind, ReplicaRows } from '../replica/contract'
import { rowKey } from '../replica/kernel/kinds'

/** Explicit pilot inventory. No runtime handles, commands or kernel objects. */
export const NAVIGATION_INPUTS = [
  'view', 'openIssueId', 'selectedIssueId', 'selectedWorktree', 'workspaces',
  'paneA', 'paneB', 'split', 'focusedPane', 'dockTab', 'superOpen',
] as const satisfies readonly (keyof EffectiveLocalState)[]
export type NavigationKey = typeof NAVIGATION_INPUTS[number]
export interface ReadCell<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}
const token = (...parts: string[]) => JSON.stringify(parts)
const collection = (kind: ReplicaKind) => token('collection', kind)
const navigation = (key: NavigationKey) => token('navigation', key)

/** Validate the boundary's shallow value shape, without traversing or converting
 * the runtime-owned workspace tree. Detailed domain validation stays upstream. */
function validateNavigation(key: NavigationKey, value: unknown): void {
  let valid: boolean
  switch (key) {
    case 'view': valid = ['workspace', 'settings', 'usage', 'issues', 'automations', 'specs', 'workflows'].includes(value as string); break
    case 'dockTab': valid = ['superagent', 'files', 'git', 'issue'].includes(value as string); break
    case 'focusedPane': valid = value === 'A' || value === 'B'; break
    case 'split': case 'superOpen': valid = typeof value === 'boolean'; break
    case 'workspaces': valid = typeof value === 'object' && value !== null && !Array.isArray(value); break
    default: valid = value === null || typeof value === 'string'
  }
  if (!valid) throw new Error(`Invalid presentation navigation: ${key}`)
}

/** Every input foregroundIssue reads, including visibility loss without revision
 * movement. The collection dependency covers whichever issue navigation selects.
 * Keep this next to the derivation; mutation oracles remove EACH entry. */
export const FOREGROUND_INPUTS = [
  collection('issues'), navigation('view'), navigation('openIssueId'), navigation('selectedIssueId'),
] as const

export interface PresentationModel {
  row<K extends ReplicaKind>(kind: K, id: string): ReadCell<Readonly<ReplicaRows[K]> | undefined>
  draft(id: string): ReadCell<string | undefined>
  navigation<K extends NavigationKey>(key: K): ReadCell<EffectiveLocalState[K] | undefined>
  foregroundIssue(): ReadCell<Readonly<ReplicaRows['issues']> | undefined>
}

/** One principal, private shallow Maps, immutable borrowed row values. Cell
 * identity is shared; derivations run lazily once per invalidation, regardless of
 * consumer count. No dependency discovery and no library-specific API. */
export function createPresentationModel(source: EffectiveChanges) {
  const rows = new Map<ReplicaKind, Map<string, object>>()
  const drafts = new Map<string, string>()
  const nav = new Map<NavigationKey, unknown>()
  type Cell = { dirty: boolean; value: unknown; read: () => unknown; listeners: Set<() => void>; inputs: readonly string[] }
  const cells = new Map<string, Cell>()
  const readers = new Map<string, ReadCell<unknown>>()
  const dependents = new Map<string, Set<Cell>>()
  let destroyed = false
  let generation = 0
  let off: (() => void) | undefined
  let active = false

  function cell<T>(key: string, inputs: readonly string[], read: () => T): ReadCell<T> {
    const existing = readers.get(key)
    if (existing) return existing as ReadCell<T>
    const state: Cell = { dirty: true, value: undefined, read, listeners: new Set(), inputs }
    if (!destroyed) {
      cells.set(key, state)
      for (const input of inputs) {
        let set = dependents.get(input)
        if (!set) dependents.set(input, set = new Set())
        set.add(state)
      }
    }
    const reader: ReadCell<T> = Object.freeze({
      getSnapshot: () => {
        if (destroyed) return undefined as T
        if (state.dirty) { state.value = state.read(); state.dirty = false }
        return state.value as T
      },
      subscribe: (listener: () => void) => {
        if (destroyed) return () => {}
        // Separate registrations, even when the callback identity is shared.
        const notify = () => { if (state.listeners.has(notify)) listener() }
        state.listeners.add(notify)
        return () => { state.listeners.delete(notify) }
      },
    })
    if (!destroyed) readers.set(key, reader)
    return reader
  }

  const model: PresentationModel = Object.freeze({
    row: <K extends ReplicaKind>(kind: K, id: string) => {
      const key = token('row', kind, id)
      return cell(key, [key], () => rows.get(kind)?.get(id) as Readonly<ReplicaRows[K]> | undefined)
    },
    draft: (id: string) => {
      const key = token('draft', id)
      return cell(key, [key], () => drafts.get(id))
    },
    navigation: <K extends NavigationKey>(key: K) =>
      cell(navigation(key), [navigation(key)], () => nav.get(key) as EffectiveLocalState[K] | undefined),
    foregroundIssue: () => cell('foregroundIssue', FOREGROUND_INPUTS, () => {
      const view = nav.get('view')
      const id = view === 'issues' ? nav.get('openIssueId') : view === 'workspace' ? nav.get('selectedIssueId') : null
      return typeof id === 'string' ? rows.get('issues')?.get(id) as Readonly<ReplicaRows['issues']> | undefined : undefined
    }),
  })

  function apply(publication: EffectivePublication): void {
    // PREPARE AND VALIDATE before touching any map: notification batching is
    // not rollback. A throwing view or mismatched address leaves everything old.
    const replacement = publication.type === 'replace'
    const stagedRows: Array<{ kind: ReplicaKind; id: string; value: object | undefined }> = []
    const seen = new Set<string>()
    const addresses = replacement
      ? REPLICA_BINDING_KINDS.flatMap(kind => publication.view.ids(kind).map(id => ({ kind, id, presence: 'present' as const })))
      : publication.rows
    for (const { kind, id, presence } of addresses) {
      if (!REPLICA_BINDING_KINDS.includes(kind) || typeof id !== 'string' || !id) throw new Error('Invalid presentation address')
      const key = token(kind, id)
      if (seen.has(key)) throw new Error('Duplicate presentation address')
      seen.add(key)
      const value = publication.view.row(kind, id)
      if ((presence !== 'present' && presence !== 'absent') || (presence === 'present') !== (value !== undefined)) throw new Error('Invalid presentation presence')
      if (value !== undefined && (typeof value !== 'object' || value === null || rowKey(kind, value) !== id)) throw new Error('Mismatched presentation row')
      stagedRows.push({ kind, id, value })
    }
    const stagedNav = new Map<NavigationKey, unknown>()
    for (const key of NAVIGATION_INPUTS) {
      if (replacement || publication.local.includes(key)) {
        const value = publication.view.local(key)
        validateNavigation(key, value)
        stagedNav.set(key, value)
      }
    }
    let stagedDrafts: Map<string, string> | undefined
    if (replacement || publication.local.includes('drafts')) {
      const value = publication.view.local('drafts')
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid presentation drafts')
      stagedDrafts = new Map(Object.entries(value))
      for (const text of stagedDrafts.values()) if (typeof text !== 'string') throw new Error('Invalid presentation draft')
    }

    // ONE outer action: install every value, invalidate every affected cell,
    // then notify. No callback can read a partially installed seed or delta.
    const invalidated = new Set<string>()
    if (replacement) {
      for (const [kind, entries] of rows) for (const id of entries.keys()) {
        invalidated.add(token('row', kind, id)); invalidated.add(collection(kind))
      }
      rows.clear()
    }
    for (const { kind, id, value } of stagedRows) {
      let entries = rows.get(kind)
      if (!entries) rows.set(kind, entries = new Map())
      if (entries.get(id) === value) continue
      if (value === undefined) entries.delete(id)
      else entries.set(id, value)
      invalidated.add(token('row', kind, id)); invalidated.add(collection(kind))
    }
    for (const [key, value] of stagedNav) {
      if (!Object.is(nav.get(key), value)) invalidated.add(navigation(key))
      nav.set(key, value)
    }
    if (stagedDrafts) {
      for (const id of new Set([...drafts.keys(), ...stagedDrafts.keys()])) {
        if (drafts.get(id) !== stagedDrafts.get(id)) invalidated.add(token('draft', id))
      }
      drafts.clear()
      for (const [id, value] of stagedDrafts) drafts.set(id, value)
    }
    const notifications = new Set<() => void>()
    for (const input of invalidated) for (const dependent of dependents.get(input) ?? []) {
      dependent.dirty = true
      for (const listener of dependent.listeners) notifications.add(listener)
    }
    const errors: unknown[] = []
    for (const notify of notifications) {
      if (destroyed) break
      try { notify() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Presentation listener failed')
  }

  function start(): void {
    if (destroyed || active) return
    active = true
    const epoch = ++generation
    try {
      const unsubscribe = source.subscribe(publication => {
        if (!destroyed && active && epoch === generation) apply(publication)
      })
      // A seed subscriber may stop/destroy during synchronous delivery.
      if (!active || destroyed || epoch !== generation) unsubscribe()
      else off = unsubscribe
    } catch (error) { if (epoch === generation) { active = false; generation++ }; throw error }
  }
  function stop(): void {
    active = false
    generation++
    const unsubscribe = off
    off = undefined
    unsubscribe?.()
  }
  function destroy(): void {
    if (destroyed) return
    destroyed = true
    stop()
    rows.clear(); drafts.clear(); nav.clear()
    for (const state of cells.values()) { state.value = undefined; state.listeners.clear() }
    cells.clear(); readers.clear(); dependents.clear()
  }
  start()
  return { model, start, stop, destroy }
}
