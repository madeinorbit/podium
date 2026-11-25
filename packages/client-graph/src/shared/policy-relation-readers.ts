/**
 * POD-7581 — RAW RELATION READERS THAT READ WHAT THE POLICY HOLDS.
 *
 * A list (the sidebar, the board, the header's mission summary) shows rows
 * the policy collections hold, and a row must not start a hold of its own:
 * one hold per row downloads every row's history. Such a reader reads the
 * relation's ids in memory on purpose. It is declared here with the policy
 * collections that bound what it reads and why that is the whole of what the
 * row shows, so the development guard accepts it (`raw-relation-warnings.ts`)
 * and the build check (`scripts/check-relation-reads.ts`) keeps the
 * declaration honest: the reader still exists, every bound is a policy
 * collection or something one comes with, a bound covers the relation's
 * target, and the relation is one a raw read would otherwise be warned about.
 *
 * A bound is written as:
 * - `<collection>`: a collection of the policy (`DESIGN_COLLECTIONS`: always,
 *   live, asking, recent, sidebar, the issueless sessions, the stubs).
 * - `<policy collection> > <collection>`: what that collection's records come
 *   with (`issueProjection.sidebar > session.ofIssue`).
 * - `<record kind> > <collection>`: what every held record of the kind comes
 *   with (`issueProjection > issueProjection.one`: its parent).
 */
import { COLLECTIONS, DESIGN_COLLECTIONS, RECORDS } from '@podium/model'
import { relationReads } from './relation-reads'

export interface PolicyRelationReader {
  readonly reader: string
  readonly relation: string
  /** What bounds the ids the reader finds in memory (see the header). */
  readonly bound: readonly string[]
  /** Why what the policy holds is all the reader shows. */
  readonly why: string
  /** Source declaration, checked so a declaration cannot outlive its reader. */
  readonly file: string
  readonly declaration: string
}

/** Each tuple is one reader and its relations, never a whole screen. */
function reader(
  name: string,
  relations: readonly string[],
  bound: readonly string[],
  why: string,
  file: string,
  declaration: string,
): PolicyRelationReader[] {
  return relations.map((relation) => ({
    reader: name,
    relation,
    bound,
    why,
    file: file.startsWith('apps/') ? file : `packages/client-graph/src/${file}`,
    declaration,
  }))
}

/** The sessions of the issues a list shows. */
const SESSIONS = [
  'issueProjection.sidebar > session.ofIssue',
  'session.live',
  'session.asking',
  'session.recent',
] as const
const SESSIONS_WHY =
  'A list row shows the sessions the policy holds: every unarchived session of an open issue (the sidebar comes with them), every live or asking session, and every one active in the last N days. An archived or older session of a closed issue is history the row does not show; a hold per row would download it for every row.'

/** The issues a list shows, and their ancestors. */
const ISSUES = [
  'issueProjection.sidebar',
  'issueProjection.recent',
  'issueProjection > issueProjection.one',
] as const
const CHILDREN_WHY =
  'A row nests the children the policy holds: every open issue and every one changed in the last N days. Each held issue comes with its parent chain, so a walk down from any row reaches every held descendant. A child closed and unchanged for N days is not shown; counts over all history come from the stubs.'

/** The incoming dependency edges of the issues a list shows. */
const EDGES = [...ISSUES, 'issueProjection > issueDep.ofIssue'] as const
const EDGES_WHY =
  'An incoming edge comes with the issue that depends (its own edges), so a row reads the spin-offs and dependents of every open or recently changed issue. An old closed spin-off or dependent is not one the row shows.'

/** Sessions that are starting or live: `session.live` holds every one. */
const LIVE_WHY =
  'Whether a session is open or working: such a session is starting or live, and session.live holds every one of them, so memory answers it whole.'

export const POLICY_RELATION_READERS: readonly PolicyRelationReader[] = [
  // ------------------------------------------------------- sidebar and rows
  ...reader(
    'IssueModel@*.missionBucket',
    ['issue.missionSessions', 'issue.bornSessions'],
    SESSIONS,
    SESSIONS_WHY,
    'models.ts',
    'get missionBucket(): MissionTaskBucket | null',
  ),
  ...reader(
    'IssueModel.missionBucket',
    ['issue.missionSessions', 'issue.bornSessions'],
    SESSIONS,
    SESSIONS_WHY,
    'models.ts',
    'get missionBucket(): MissionTaskBucket | null',
  ),
  ...reader(
    'IssueModel@*.live',
    ['issue.missionSessions'],
    ['session.live'],
    LIVE_WHY,
    'models.ts',
    'get live(): boolean',
  ),
  ...reader(
    'IssueModel.missionWorking',
    ['issue.missionSessions'],
    ['session.live'],
    LIVE_WHY,
    'models.ts',
    'get missionWorking(): boolean',
  ),
  ...reader(
    'IssueModel@*.memberSessionIds',
    ['issue.pageSessions'],
    SESSIONS,
    SESSIONS_WHY,
    'models.ts',
    'get memberSessionIds(): ReturnType<typeof asSessionId>[]',
  ),
  ...reader(
    'IssueModel.descendantTaskProgress',
    ['issue.pageSessions'],
    SESSIONS,
    SESSIONS_WHY,
    'models.ts',
    'private get descendantTaskProgress(): TaskProgress | null {',
  ),
  ...reader(
    'IssueModel.descendantTaskProgress',
    ['issue.treeChildren'],
    ISSUES,
    CHILDREN_WHY,
    'models.ts',
    'private get descendantTaskProgress(): TaskProgress | null {',
  ),
  ...reader(
    'Seats.pageSessions@*.partition',
    ['issue.pageSessions'],
    SESSIONS,
    SESSIONS_WHY,
    'session-seats.ts',
    "'partition', (issueId)",
  ),
  ...['WorklistIssue.formalChildIds', 'WorklistIssue@*.formalChildIds'].flatMap((name) =>
    reader(
      name,
      ['issue.children'],
      ISSUES,
      CHILDREN_WHY,
      'worklist/issue.ts',
      'private get formalChildIds(): readonly string[] {',
    ),
  ),
  ...[
    ['WorklistIssue.unitOwnUnit', "private get unitOwnUnit(): UnitOwn['unit'] {"],
    ['WorklistIssue@*.unitOwnUnit', "private get unitOwnUnit(): UnitOwn['unit'] {"],
    ['WorklistIssue.unitOwnDone', "private get unitOwnDone(): UnitOwn['done'] {"],
    ['WorklistIssue@*.unitOwnDone', "private get unitOwnDone(): UnitOwn['done'] {"],
    ['WorklistIssue@*.unitOwnSolo', "private get unitOwnSolo(): UnitOwn['solo'] {"],
  ].flatMap(([name, declaration]) =>
    reader(name!, ['issue.spinOffs'], EDGES, EDGES_WHY, 'worklist/issue.ts', declaration!),
  ),
  ...['WorklistIssue@*.childIds', 'WorklistIssue.childIds'].flatMap((name) =>
    reader(
      name,
      ['issue.children'],
      ISSUES,
      CHILDREN_WHY,
      'worklist/issue.ts',
      'get childIds(): readonly string[] { return childIdsPartOf(this.host.visibleInputs, this.id) }',
    ),
  ),
  ...['WorklistIssue@*.nestBelow', 'WorklistIssue.nestBelow'].flatMap((name) =>
    reader(
      name,
      ['issue.treeChildren'],
      ISSUES,
      CHILDREN_WHY,
      'worklist/issue.ts',
      '@lazy({ equals: compareShallow }) get nestBelow(): readonly string[] {',
    ),
  ),
  ...['WorklistIssue@*.visibleChildIds', 'WorklistIssue.visibleChildIds'].flatMap((name) =>
    reader(
      name,
      ['issue.treeChildren'],
      ISSUES,
      CHILDREN_WHY,
      'worklist/issue.ts',
      'get visibleChildIds(): readonly string[] { return sidebarBelowOf(this, this.worklist.pool) }',
    ),
  ),
  ...['WorklistIssue@*.spinOffIds', 'WorklistIssue.spinOffIds'].flatMap((name) =>
    reader(
      name,
      ['issue.spinOffs'],
      EDGES,
      EDGES_WHY,
      'worklist/issue.ts',
      'get spinOffIds(): readonly string[] { return spinOffIdsPartOf(this.host.visibleInputs, this.id) }',
    ),
  ),
  // The ⤷ tick names a spin-off's origin when the policy holds it. A lookup
  // per row would load the origin of every spin-off whose origin closed long
  // ago; the issue page reads the origin through its lookup.
  ...['IssueModel@*.originRef', 'IssueModel.originRef'].flatMap((name) =>
    reader(
      name,
      ['issue.discoveredFrom'],
      ISSUES,
      "A row's origin tick names the origin when the policy holds it: open, or changed in the last N days. A spin-off of an origin closed long ago shows no tick; a lookup per row would load every such origin.",
      'models.ts',
      '@lazy get originRef(): string | null { return originRefPartOf(this.host.inputs, this.id) }',
    ),
  ),
  // -------------------------------------------------------------- header
  ...reader(
    'header.foldedMission:*',
    ['issue.children'],
    ISSUES,
    "The header sums up the selected mission's open work: what needs the user. Open issues are all held, and each comes with its parent chain, so the walk down from the root reaches every one of them.",
    'header-views.ts',
    'function foldedMission(rootId: string) {',
  ),
  ...reader(
    'header.foldedMission:*',
    ['issue.spinOffs'],
    EDGES,
    "Whether a task's work moved to a spin-off (vacated): an open spin-off is held with its edge. One closed long ago no longer says the work moved.",
    'header-views.ts',
    'function foldedMission(rootId: string) {',
  ),
  ...reader(
    'Seats.sessions@*.partition',
    ['issue.sessions'],
    SESSIONS,
    SESSIONS_WHY,
    'session-seats.ts',
    "'partition', (issueId)",
  ),
  // ---------------------------------------------------------- navigation
  ...['NavigationActivity@*.subtree', 'NavigationActivity@*.parent'].flatMap((name) =>
    reader(
      name,
      ['issue.treeChildren'],
      ISSUES,
      'The latest activity under an issue orders the sidebar. Everything active or changed in the last N days is held (the recent collections), and every open issue with its parent chain, so the latest stamp is exact whenever it is recent; only an order among old work can differ.',
      'navigation-activity.ts',
      name.endsWith('subtree') ? "'subtree'," : "cachedKey('NavigationActivity', 'parent',",
    ),
  ),
  // --------------------------------------------------------------- board
  ...reader(
    'IssueBoard.row@*',
    ['issue.treeChildren'],
    ISSUES,
    CHILDREN_WHY,
    'issue-board-source.ts',
    'function issue(id: string): Loaded<IssueViewModel> {',
  ),
  ...reader(
    'IssueBoard.row@*',
    ['issue.pageDependents'],
    EDGES,
    EDGES_WHY,
    'issue-board-source.ts',
    'function issue(id: string): Loaded<IssueViewModel> {',
  ),
  ...reader(
    'IssueBoard.row@*',
    ['issue.pageSessions'],
    SESSIONS,
    "A card counts the sessions the policy holds: every unarchived session of an open issue, every live or asking one and every one active in the last N days. A card of work closed long ago counts none of its old sessions; a hold per card would download every card's history.",
    'issue-board-source.ts',
    'function issue(id: string): Loaded<IssueViewModel> {',
  ),
  // ------------------------------------------------------- phone and desktop rows
  ...['BoardTask.mark', 'BoardTask@*.mark'].flatMap((name) =>
    reader(
      name,
      ['issue.missionSessions'],
      SESSIONS,
      SESSIONS_WHY,
      'mobile-tasks.ts',
      '@lazy get mark(): TaskRowMark {',
    ),
  ),
  ...reader(
    'BoardTask.childIds',
    ['issue.treeChildren'],
    ISSUES,
    CHILDREN_WHY,
    'mobile-tasks.ts',
    'get childIds()',
  ),
  ...reader(
    'observerTaskRow',
    ['issue.pageSessions'],
    SESSIONS,
    SESSIONS_WHY,
    'apps/mobile/src/screens/TasksSurface.tsx',
    'const TaskRow = observer(function TaskRow({',
  ),
  ...reader(
    'observerTaskRow',
    ['issue.pageDependents'],
    EDGES,
    EDGES_WHY,
    'apps/mobile/src/screens/TasksSurface.tsx',
    'const TaskRow = observer(function TaskRow({',
  ),
  ...reader(
    'observerBoardPoolRow',
    ['issue.pageSessions'],
    SESSIONS,
    SESSIONS_WHY,
    'apps/web/src/features/issues/board-pool-row.tsx',
    'export const BoardPoolRow = observer(function BoardPoolRow({',
  ),
  ...reader(
    'observerBoardPoolRow',
    ['issue.pageDependents'],
    EDGES,
    EDGES_WHY,
    'apps/web/src/features/issues/board-pool-row.tsx',
    'export const BoardPoolRow = observer(function BoardPoolRow({',
  ),
]

/** Names can carry an instance id; the reader's declared name is stable. */
export function policyRelationReader(
  reader: string,
  relation: string,
): PolicyRelationReader | undefined {
  return POLICY_RELATION_READERS.find(
    (entry) => entry.reader === reader && entry.relation === relation,
  )
}

/** The collections the policy holds on every device (`apps/server/src/sync/policy.ts`). */
// side-state: declaration: the policy's fixed collection ids, built once from the declarations
export const POLICY_COLLECTIONS: ReadonlySet<string> = new Set([
  ...DESIGN_COLLECTIONS.always,
  ...RECORDS.filter((record) => record.group === 'windowed').map(
    (record) => `${record.kind}.window`,
  ),
  ...DESIGN_COLLECTIONS.live,
  ...DESIGN_COLLECTIONS.asking,
  ...DESIGN_COLLECTIONS.recent,
  ...DESIGN_COLLECTIONS.sidebar,
  ...DESIGN_COLLECTIONS.sessionsWithNoIssue,
  ...DESIGN_COLLECTIONS.issueStubs,
])

/** The record kind a bound brings, or the reason it is not a bound. */
function boundKind(bound: string): { kind: string } | { problem: string } {
  const [holder, brought, extra] = bound.split(' > ')
  if (extra !== undefined || holder === undefined || holder === '')
    return { problem: `bound "${bound}" is not "<collection>" or "<holder> > <collection>"` }
  if (brought === undefined) {
    const collection = COLLECTIONS.get(holder)
    if (collection === undefined) return { problem: `bound ${holder} is not a declared collection` }
    if (!POLICY_COLLECTIONS.has(holder))
      return { problem: `bound ${holder} is not a collection the policy holds` }
    return { kind: collection.of }
  }
  const target = COLLECTIONS.get(brought)
  if (target === undefined) return { problem: `bound ${brought} is not a declared collection` }
  const record = RECORDS.find((each) => each.kind === holder)
  if (record !== undefined) {
    if (!record.comesWith.some((entry) => entry.collection === brought))
      return { problem: `a ${holder} record does not come with ${brought}` }
    return { kind: target.of }
  }
  const collection = COLLECTIONS.get(holder)
  if (collection === undefined)
    return { problem: `bound ${holder} is neither a record kind nor a declared collection` }
  if (!POLICY_COLLECTIONS.has(holder))
    return { problem: `bound ${holder} is not a collection the policy holds` }
  if (!(collection.comesWith ?? []).some((entry) => entry.collection === brought))
    return { problem: `${holder} does not come with ${brought}` }
  return { kind: target.of }
}

/**
 * Build check: every declaration names a reader that still exists, a
 * relation a raw read would be warned about, bounds the policy holds and one
 * that brings the relation's target, and says why.
 */
export function policyRelationReaderProblems(
  source: (file: string) => string,
  entries: readonly PolicyRelationReader[] = POLICY_RELATION_READERS,
  raw: readonly { readonly reader: string; readonly relation: string }[] = [],
): string[] {
  const problems: string[] = []
  const rows = new Map(relationReads().map((row) => [row.relation, row]))
  const keys = new Set<string>()
  const rawKeys = new Set(raw.map((entry) => `${entry.reader} -> ${entry.relation}`))
  for (const entry of entries) {
    const key = `${entry.reader} -> ${entry.relation}`
    if (keys.has(key)) problems.push(`${key}: duplicate policy reader declaration`)
    keys.add(key)
    if (rawKeys.has(key))
      problems.push(`${key}: declared both as a policy reader and as a raw reader exception`)
    if (entry.why.trim() === '') problems.push(`${key}: a policy reader needs its reason`)
    const row = rows.get(entry.relation)
    if (row === undefined) problems.push(`${key}: ${entry.relation} is not a declared relation`)
    else if (row.read.kind === 'present' || row.read.kind === 'policy')
      problems.push(
        `${key}: ${entry.relation} is ${row.read.kind}, so a raw read needs no declaration; remove it`,
      )
    const kinds = new Set<string>()
    for (const bound of entry.bound) {
      const answer = boundKind(bound)
      if ('problem' in answer) problems.push(`${key}: ${answer.problem}`)
      else kinds.add(answer.kind)
    }
    if (row?.target !== undefined && !kinds.has(row.target))
      problems.push(`${key}: no bound brings ${row.target}, the records ${entry.relation} reads`)
    let text = ''
    try {
      text = source(entry.file)
    } catch {
      /* A removed source file is a stale entry. */
    }
    if (!text.replace(/\s+/g, '').includes(entry.declaration.replace(/\s+/g, '')))
      problems.push(
        `${key}: reader is gone from ${entry.file}; remove its policy reader declaration`,
      )
  }
  return problems
}
