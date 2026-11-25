/** Existing raw readers remain explicit until their owning follow-up moves them. */
export interface RawRelationReader {
  readonly reader: string
  readonly relation: string
  readonly followUp: `POD-${number}`
  /** Source declaration, checked so an exception cannot outlive its reader. */
  readonly file: string
  readonly declaration: string
}

/** Every tuple is a reader and its explicit relations, never a whole screen exemption. */
function reader(
  name: string,
  relations: readonly string[],
  followUp: RawRelationReader['followUp'],
  file: string,
  declaration: string,
): RawRelationReader[] {
  return relations.map((relation) => ({
    reader: name,
    relation,
    followUp,
    file: file.startsWith('apps/') ? file : `packages/client-graph/src/${file}`,
    declaration,
  }))
}

export const RAW_RELATION_READERS: readonly RawRelationReader[] = [
  ...reader(
    'Mission@*.members',
    ['issue.children', 'issue.missionSessions', 'session.missionStartedIssues'],
    'POD-7580',
    'mission.ts',
    "const members = cachedKey('Mission', 'members',",
  ),
  ...reader(
    'MissionDeckModel@*.topology',
    ['issue.children'],
    'POD-7580',
    'mission-view.ts',
    'get topology() { return topology(this) }',
  ),
  ...reader(
    'MissionDeckModel@*.progress',
    ['issue.children'],
    'POD-7580',
    'mission-view.ts',
    'get progress() { return progress(this) }',
  ),
  ...reader(
    'MissionDeckModel@*.continuation',
    ['issue.spinOffs', 'issue.discoveredFrom'],
    'POD-7580',
    'mission-view.ts',
    'get continuation() { return rootContinuation(this) }',
  ),
  ...reader(
    'MissionDeckModel@*.note',
    ['issue.spinOffs', 'issue.discoveredFrom'],
    'POD-7580',
    'mission-view.ts',
    'get note() { return rootNote(this) }',
  ),
  ...reader(
    'MissionDeckModel@*.presence',
    ['issue.spinOffs', 'issue.discoveredFrom'],
    'POD-7580',
    'mission-view.ts',
    'get presence() { return rootPresence(this) }',
  ),
  ...reader(
    'MissionDeckModel@*.departures',
    ['issue.spinOffs'],
    'POD-7580',
    'mission-view.ts',
    'get departures() { return rootDepartures(this) }',
  ),
  ...reader(
    'MissionIssueReader@*.rules',
    ['issue.pageDependents'],
    'POD-7580',
    'mission-view.ts',
    'get rules() { return this.view.readRulesIssue(this.id) }',
  ),
  ...reader(
    'MissionIssueReader@*.earliestChild',
    ['issue.children'],
    'POD-7580',
    'mission-view.ts',
    '@lazy get earliestChild() {',
  ),
  ...reader(
    'MissionIssueReader@*.issue',
    ['issue.treeChildren', 'issue.pageDependents'],
    'POD-7580',
    'mission-view.ts',
    'get issue() { return this.view.readIssue(this.id) }',
  ),
  ...reader(
    'MissionIssueReader@*.progressUnit',
    ['issue.spinOffs', 'issue.discoveredFrom'],
    'POD-7580',
    'mission-view.ts',
    'get progressUnit(): boolean',
  ),
  ...reader(
    'MissionIssueReader@*.spinOffDependent',
    ['issue.pageDependents'],
    'POD-7580',
    'mission-view.ts',
    'get spinOffDependent(): boolean',
  ),
  // Per-row facts over an issue's whole session history, read for every
  // visible row (board cards' session counts, the sidebar rollup, the deck's
  // tasks). A holding read per row would download each row's archived
  // history; per-row counts need a small filtered or aggregate collection,
  // not full history. The issue page reads its own rosters and counts through
  // the holding read (issue-page.ts, POD-7579). The mission bucket also asks
  // whether any session was born here (bornSessions, held per issue by
  // session.bornOf since POD-7582, a whole history again); the whole getter
  // moves with its readers.
  ...reader(
    'Seats.missionSessions@*.partition',
    ['issue.missionSessions'],
    'POD-7580',
    'session-seats.ts',
    "'partition', (issueId)",
  ),
  ...reader(
    'Seats.pageSessions@*.partition',
    ['issue.pageSessions'],
    'POD-7581',
    'session-seats.ts',
    "'partition', (issueId)",
  ),
  ...reader(
    'IssueModel@*.memberSessionIds',
    ['issue.pageSessions'],
    'POD-7581',
    'models.ts',
    'get memberSessionIds(): ReturnType<typeof asSessionId>[]',
  ),
  ...reader(
    'IssueModel@*.missionBucket',
    ['issue.missionSessions', 'issue.bornSessions'],
    'POD-7581',
    'models.ts',
    'get missionBucket(): MissionTaskBucket | null',
  ),
  // Whether a session is open or working: such a session is starting or live,
  // and `session.live` (a policy collection) always holds every one of them,
  // so memory answers it. POD-7581 (sidebar) and POD-7580 (deck) confirm it.
  ...reader(
    'IssueModel@*.live',
    ['issue.missionSessions'],
    'POD-7581',
    'models.ts',
    'get live(): boolean',
  ),
  ...reader(
    'IssueModel@*.missionWorking',
    ['issue.missionSessions'],
    'POD-7580',
    'models.ts',
    'get missionWorking(): boolean',
  ),
  // The live seat (a reference card's "go to session", walked up the parent
  // chain by seatHolderId) reads the unarchived seats behind the issue's tree
  // hold, one instance for the whole chain: the tree comes with every visible
  // seat (DECK_SESSION_WHERE), parked ones included, without the archived
  // history session.ofIssue would bring. POD-7580 audits reads under treeHeld.
  ...reader(
    'IssueModel@*.liveSeatId',
    ['issue.pageSessions'],
    'POD-7580',
    'models.ts',
    'get liveSeatId(): string | undefined',
  ),
  // The continuation walks the spin-off tree (MissionView.readTips): no
  // collection holds the issues whose deps name this one, and each spin-off's
  // origin is read on a member that walk found in memory. POD-7582.
  ...reader(
    'IssuePageRow.continuation',
    ['issue.spinOffs', 'issue.discoveredFrom'],
    'POD-7582',
    'issue-page.ts',
    'get continuation() { return missionView(this.pool).continuation(this.issue, false) }',
  ),
  // List rows must not hold each row's session history, dependency edges or
  // subtree. Keep these resident reads until filtered or aggregate collections
  // can answer the decorations without blanking titles and refs offline.
  // POD-7581 owns the row/board follow-up; deck aggregates remain with POD-7580.
  // MobX reports these same row fields with and without an addressed instance.
  ...reader(
    'BoardTask.mark',
    ['issue.missionSessions'],
    'POD-7581',
    'mobile-tasks.ts',
    '@lazy get mark(): TaskRowMark {',
  ),
  ...reader(
    'WorklistIssue.formalChildIds',
    ['issue.children'],
    'POD-7581',
    'worklist/issue.ts',
    'private get formalChildIds(): readonly string[] {',
  ),
  ...reader(
    'WorklistIssue.unitOwnUnit',
    ['issue.spinOffs'],
    'POD-7581',
    'worklist/issue.ts',
    "private get unitOwnUnit(): UnitOwn['unit'] {",
  ),
  ...reader(
    'WorklistIssue.unitOwnDone',
    ['issue.spinOffs'],
    'POD-7581',
    'worklist/issue.ts',
    "private get unitOwnDone(): UnitOwn['done'] {",
  ),
  ...reader(
    'observerTaskRow',
    ['issue.pageSessions', 'issue.pageDependents'],
    'POD-7581',
    'apps/mobile/src/screens/TasksSurface.tsx',
    'const TaskRow = observer(function TaskRow({',
  ),
  ...reader(
    'BoardTask@*.mark',
    ['issue.missionSessions'],
    'POD-7581',
    'mobile-tasks.ts',
    '@lazy get mark(): TaskRowMark {',
  ),
  ...reader(
    'IssueModel.descendantTaskProgress',
    ['issue.treeChildren', 'issue.pageSessions'],
    'POD-7581',
    'models.ts',
    'private get descendantTaskProgress(): TaskProgress | null {',
  ),
  ...reader(
    'WorklistIssue@*.formalChildIds',
    ['issue.children'],
    'POD-7581',
    'worklist/issue.ts',
    'private get formalChildIds(): readonly string[] {',
  ),
  ...reader(
    'WorklistIssue@*.unitOwnUnit',
    ['issue.spinOffs'],
    'POD-7581',
    'worklist/issue.ts',
    "private get unitOwnUnit(): UnitOwn['unit'] {",
  ),
  ...reader(
    'WorklistIssue@*.unitOwnDone',
    ['issue.spinOffs'],
    'POD-7581',
    'worklist/issue.ts',
    "private get unitOwnDone(): UnitOwn['done'] {",
  ),
  ...reader(
    'WorklistIssue@*.unitOwnSolo',
    ['issue.spinOffs'],
    'POD-7581',
    'worklist/issue.ts',
    "private get unitOwnSolo(): UnitOwn['solo'] {",
  ),
  ...reader(
    'BoardTask.childIds',
    ['issue.treeChildren'],
    'POD-7581',
    'mobile-tasks.ts',
    'get childIds()',
  ),
  ...reader(
    'IssueModel.missionBucket',
    ['issue.bornSessions', 'issue.missionSessions'],
    'POD-7581',
    'models.ts',
    'get missionBucket(): MissionTaskBucket | null',
  ),
  ...reader(
    'IssueModel.missionWorking',
    ['issue.missionSessions'],
    'POD-7581',
    'models.ts',
    'get missionWorking(): boolean',
  ),
  ...reader(
    'observerBoardPoolRow',
    ['issue.pageSessions', 'issue.pageDependents'],
    'POD-7581',
    'apps/web/src/features/issues/board-pool-row.tsx',
    'export const BoardPoolRow = observer(function BoardPoolRow({',
  ),
]

/** Names can carry an instance id; the reader's declared name is stable. */
export const rawReaderName = (name: string): string =>
  name.replace(/@[^.]+/g, '@*').replace(/:[^.]*/g, ':*')

export function rawRelationReader(reader: string, relation: string): RawRelationReader | undefined {
  return RAW_RELATION_READERS.find(
    (entry) => entry.reader === reader && entry.relation === relation,
  )
}

/** Build check: do not retain exceptions after their source reader disappears. */
export function rawRelationReaderProblems(
  source: (file: string) => string,
  entries: readonly RawRelationReader[] = RAW_RELATION_READERS,
): string[] {
  const problems: string[] = []
  const keys = new Set<string>()
  for (const entry of entries) {
    const key = `${entry.reader} -> ${entry.relation}`
    if (keys.has(key)) problems.push(`${key}: duplicate raw reader exception`)
    keys.add(key)
    if (!/^POD-\d+$/.test(entry.followUp))
      problems.push(`${key}: a follow-up POD issue is required`)
    let text = ''
    try {
      text = source(entry.file)
    } catch {
      /* A removed source file is a stale entry. */
    }
    if (!text.replace(/\s+/g, '').includes(entry.declaration.replace(/\s+/g, '')))
      problems.push(`${key}: reader is gone from ${entry.file}; remove its raw reader exception`)
  }
  return problems
}
