import { buildWorktreeRootIndex, isHeadlessSession, worktreeForCwdIndexed, type SessionMeta, type IssueWire, type WorktreeRootEntry } from '@podium/model'
import type { ReplicaKind, ReplicaRows } from '../replica/contract'
import { sessionBelongsToIssue } from '../viewmodels/session-ownership'
import { missionParentId } from '../viewmodels/mission'

/** ID sets, not ordered UI rows. Consumers choose their domain ordering and read
 * content through row cells. Empty/missing keys are valid subscription inputs. */
export type Relationship = 'sessionsByIssue' | 'attachedSessionsByIssue' | 'sessionsByWorktree' | 'childrenByParent' | 'issuesByRepository' | 'dependentsByIssue' | 'dependencyEdgesByIssue' | 'outgoingEdges' | 'incomingEdges' | 'allChildrenByParent' | 'issuesByStartingSession'
export const relationshipKey = (kind: Relationship, id: string, type?: string) => JSON.stringify(['relationship', kind, id, type ?? null])
type SessionInput = Pick<SessionMeta, 'sessionId' | 'issueId' | 'cwd' | 'archived' | 'headless'>
type IssueInput = Pick<IssueWire, 'id' | 'worktreePath' | 'parentId' | 'archived' | 'deletedAt' | 'repoId'> & { deps?: IssueWire['deps']; startedBySession?: IssueWire['startedBySession'] }
export interface RelationshipRow { kind: ReplicaKind; id: string; value: object | undefined }
const EMPTY: readonly string[] = Object.freeze([])
const normalize = (path: string) => path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
function ancestors(cwd: string): string[] {
  const result: string[] = []
  let path = normalize(cwd)
  while (path) {
    result.push(path)
    if (path === '/') break
    const slash = path.lastIndexOf('/')
    if (slash < 0) break
    path = slash === 0 ? '/' : path.slice(0, slash)
  }
  return result
}
function put(map: Map<string, Set<string>>, key: string, id: string, add: boolean) {
  if (add) {
    let set = map.get(key)
    if (!set) map.set(key, set = new Set())
    set.add(id)
  } else {
    const set = map.get(key)
    set?.delete(id)
    if (!set?.size) map.delete(key)
  }
}

/** Fixed domain indexes. Only replacements enumerate collections. Deltas visit
 * addressed rows, their path ancestors, and incoming/outgoing candidate buckets.
 * Missing references are PRIVATE candidates, never public memberships. */
export function createRelationshipIndexes() {
  const sessions = new Map<string, SessionInput>()
  const issues = new Map<string, IssueInput>()
  const wires = new Map<string, IssueInput>()
  const projections = new Map<string, IssueInput>()
  const repos = new Set<string>()
  const edges = new Map<string, ReplicaRows['issueDeps']>()
  const explicit = new Map<string, Set<string>>()
  const beneath = new Map<string, Set<string>>()
  const issuesAtRoot = new Map<string, Set<string>>()
  const incoming = new Map<string, Set<string>>()
  const edgesAtIssue = new Map<string, Set<string>>()
  const repoIssues = new Map<string, Set<string>>()
  const rootCounts = new Map<string, number>()
  const externalRoots = new Set<string>()
  const roots = new Map<string, WorktreeRootEntry>()
  const buckets = new Map<string, Set<string>>()
  const snapshots = new Map<string, readonly string[]>()
  const contributions = new Map<string, Map<string, string>>()
  const stats = { sessionMembershipEvaluations: 0, issueMembershipEvaluations: 0, edgeMembershipEvaluations: 0, bucketWrites: 0 }
  let changed = new Set<string>()
  const visible = (id: string) => issues.has(id)
  const addAll = (to: Set<string>, from?: Iterable<string>) => { if (from) for (const id of from) to.add(id) }
  function install(owner: string, next: Map<string, string>) {
    const old = contributions.get(owner) ?? new Map<string, string>()
    for (const [key, id] of old) if (next.get(key) !== id) {
      put(buckets, key, id, false); changed.add(key); snapshots.delete(key); stats.bucketWrites++
    }
    for (const [key, id] of next) if (old.get(key) !== id) {
      put(buckets, key, id, true); changed.add(key); snapshots.delete(key); stats.bucketWrites++
    }
    if (next.size) contributions.set(owner, next)
    else contributions.delete(owner)
  }
  function root(path: string, delta: number, dirty: Set<string>) {
    const count = (rootCounts.get(path) ?? 0) + delta
    if (count) rootCounts.set(path, count)
    else rootCounts.delete(path)
    const key = normalize(path)
    const variants = [key, ...(key === '/' ? [] : [`${key}/`])].filter(p => rootCounts.has(p))
    const entry = buildWorktreeRootIndex(variants).get(key)
    const old = roots.get(key)
    if (entry?.plain === old?.plain && entry?.inside === old?.inside) return
    if (entry) roots.set(key, entry)
    else roots.delete(key)
    addAll(dirty, beneath.get(key))
  }
  function sessionCandidates(s: SessionInput, add: boolean) {
    if (s.issueId !== undefined) put(explicit, s.issueId, s.sessionId, add)
    for (const path of ancestors(s.cwd ?? '')) put(beneath, path, s.sessionId, add)
  }
  function issueCandidates(i: IssueInput, add: boolean) {
    if (i.worktreePath) put(issuesAtRoot, i.worktreePath, i.id, add)
    if (i.repoId) put(repoIssues, i.repoId, i.id, add)
    if (i.parentId) put(incoming, i.parentId, i.id, add)
    for (const dep of i.deps ?? []) put(incoming, dep.id, i.id, add)
  }
  function refreshSession(id: string) {
    stats.sessionMembershipEvaluations++
    const next = new Map<string, string>()
    const s = sessions.get(id)
    if (s) {
      if (s.issueId !== undefined && visible(s.issueId)) next.set(relationshipKey('attachedSessionsByIssue', s.issueId), id)
      const wt = worktreeForCwdIndexed(s.cwd ?? '', roots)
      if (!s.archived && !isHeadlessSession(s)) {
        if (wt) next.set(relationshipKey('sessionsByWorktree', wt), id)
        const candidates = s.issueId !== undefined ? [s.issueId] : issuesAtRoot.get(wt ?? '') ?? []
        for (const issueId of candidates) {
          const issue = issues.get(issueId)
          if (issue && sessionBelongsToIssue(s, issue, wt)) next.set(relationshipKey('sessionsByIssue', issueId), id)
        }
      }
    }
    install(`session:${id}`, next)
  }
  function refreshIssue(id: string) {
    stats.issueMembershipEvaluations++
    const next = new Map<string, string>()
    const i = issues.get(id)
    if (i) {
      if (i.parentId && visible(i.parentId)) next.set(relationshipKey('allChildrenByParent', i.parentId), id)
      if (i.startedBySession) next.set(relationshipKey('issuesByStartingSession', i.startedBySession), id)
      const parent = missionParentId(i)
      if (parent && visible(parent)) next.set(relationshipKey('childrenByParent', parent), id)
      if (i.repoId && repos.has(i.repoId)) next.set(relationshipKey('issuesByRepository', i.repoId), id)
      for (const dep of i.deps ?? []) if (visible(dep.id)) next.set(relationshipKey('dependentsByIssue', dep.id, dep.type), id)
    }
    install(`issue:${id}`, next)
  }
  function refreshEdge(id: string) {
    stats.edgeMembershipEvaluations++
    const next = new Map<string, string>()
    const edge = edges.get(id)
    // Raw edge buckets deliberately retain missing endpoints for late arrival.
    if (edge) {
      next.set(relationshipKey('outgoingEdges', edge.fromId), id)
      next.set(relationshipKey('incomingEdges', edge.toId), id)
    }
    if (edge && visible(edge.fromId) && visible(edge.toId)) next.set(relationshipKey('dependencyEdgesByIssue', edge.toId, edge.type), id)
    install(`edge:${id}`, next)
  }
  const sessionInput = (s: SessionInput | undefined) => s && JSON.stringify([s.issueId, s.cwd, !!s.archived, isHeadlessSession(s)])
  const issueInput = (i: IssueInput | undefined) => i && JSON.stringify([i.parentId, !!i.archived, !!i.deletedAt, i.worktreePath, i.repoId, i.startedBySession, (i.deps ?? []).map(d => [d.id, d.type])])
  function pickIssue(row: IssueWire | ReplicaRows['issueProjections']): IssueInput {
    return { id: row.id, parentId: row.parentId, archived: row.archived, deletedAt: row.deletedAt,
      worktreePath: row.worktreePath ?? null, repoId: row.repoId, startedBySession: row.startedBySession, deps: 'deps' in row ? row.deps : undefined }
  }
  function clear() {
    sessions.clear(); issues.clear(); wires.clear(); projections.clear(); repos.clear(); edges.clear()
    explicit.clear(); beneath.clear(); issuesAtRoot.clear(); incoming.clear(); edgesAtIssue.clear(); repoIssues.clear()
    rootCounts.clear(); roots.clear(); buckets.clear(); snapshots.clear(); contributions.clear()
    for (const path of externalRoots) root(path, 1, new Set())
  }
  function apply(rows: readonly RelationshipRow[], replacement = false): Set<string> {
    changed = new Set()
    if (replacement) { for (const key of buckets.keys()) changed.add(key); externalRoots.clear(); clear() }
    const dirtySessions = new Set<string>(), dirtyIssues = new Set<string>(), dirtyEdges = new Set<string>()
    for (const { kind, id, value } of rows) {
      if (kind === 'sessions') {
        const old = sessions.get(id), row = value as SessionMeta | undefined
        const next: SessionInput | undefined = row && { sessionId: row.sessionId, issueId: row.issueId,
          cwd: row.cwd, archived: row.archived, headless: row.headless }
        // Content lives only in row cells. This map retains membership inputs.
        if (sessionInput(old) === sessionInput(next)) continue
        if (old) sessionCandidates(old, false)
        if (next) { sessions.set(id, next); sessionCandidates(next, true) } else sessions.delete(id)
        dirtySessions.add(id)
      } else if (kind === 'issues' || kind === 'issueProjections') {
        if (kind === 'issues') {
          if (value) wires.set(id, pickIssue(value as IssueWire)); else wires.delete(id)
        } else {
          if (value) projections.set(id, pickIssue(value as ReplicaRows['issueProjections'])); else projections.delete(id)
        }
        const old = issues.get(id)
        // Normalized own fields take precedence when present; their edges live
        // in issueDeps, never in a stale embedded wire supplement.
        const next = projections.get(id) ?? wires.get(id)
        if (issueInput(old) === issueInput(next)) continue
        if (!!old !== !!next) {
          addAll(dirtyIssues, incoming.get(id)); addAll(dirtyEdges, edgesAtIssue.get(id)); addAll(dirtySessions, explicit.get(id))
        }
        if (!!old !== !!next || old?.worktreePath !== next?.worktreePath) {
          for (const i of [old, next]) if (i?.worktreePath) addAll(dirtySessions, beneath.get(normalize(i.worktreePath)))
        }
        if (old) issueCandidates(old, false)
        if (next) { issues.set(id, next); issueCandidates(next, true) } else issues.delete(id)
        if (old?.worktreePath !== next?.worktreePath) {
          if (old?.worktreePath) root(old.worktreePath, -1, dirtySessions)
          if (next?.worktreePath) root(next.worktreePath, 1, dirtySessions)
        }
        dirtyIssues.add(id)
      } else if (kind === 'repos') {
        if (repos.has(id) === (value !== undefined)) continue
        if (value) repos.add(id); else repos.delete(id)
        addAll(dirtyIssues, repoIssues.get(id))
      } else if (kind === 'issueDeps') {
        const old = edges.get(id), next = value as ReplicaRows['issueDeps'] | undefined
        if (old) for (const issueId of [old.fromId, old.toId]) put(edgesAtIssue, issueId, id, false)
        if (next) {
          edges.set(id, next)
          for (const issueId of [next.fromId, next.toId]) put(edgesAtIssue, issueId, id, true)
        } else edges.delete(id)
        dirtyEdges.add(id)
      }
    }
    // All inputs installed first: address ordering cannot affect admission.
    for (const id of dirtySessions) refreshSession(id)
    for (const id of dirtyIssues) refreshIssue(id)
    for (const id of dirtyEdges) refreshEdge(id)
    return changed
  }
  return {
    apply,
    /** Host-discovered roots are not in EffectiveChanges (EngineState.repos is
     * not the replica repos kind). Future adapters supply explicit root deltas;
     * nothing is enabled or subscribed by this infrastructure. */
    updateWorktreePaths(added: readonly string[], removed: readonly string[]): Set<string> {
      changed = new Set()
      const dirty = new Set<string>()
      for (const path of removed) if (externalRoots.delete(path)) root(path, -1, dirty)
      for (const path of added) if (!externalRoots.has(path)) { externalRoots.add(path); root(path, 1, dirty) }
      for (const id of dirty) refreshSession(id)
      return changed
    },
    snapshot(key: string): readonly string[] {
      let value = snapshots.get(key)
      if (!value) { value = buckets.has(key) ? Object.freeze([...buckets.get(key)!].sort()) : EMPTY; snapshots.set(key, value) }
      return value
    },
    stats: () => ({ ...stats }),
    destroy() { externalRoots.clear(); clear() },
  }
}
