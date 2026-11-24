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
    ['issue.canonicalIssue', 'issue.supersedingIssue', 'issue.spinOffs', 'issue.discoveredFrom'],
    'POD-7580',
    'mission-view.ts',
    'get continuation() { return rootContinuation(this) }',
  ),
  ...reader(
    'MissionDeckModel@*.note',
    ['issue.canonicalIssue', 'issue.supersedingIssue', 'issue.spinOffs', 'issue.discoveredFrom'],
    'POD-7580',
    'mission-view.ts',
    'get note() { return rootNote(this) }',
  ),
  ...reader(
    'MissionDeckModel@*.presence',
    ['issue.canonicalIssue', 'issue.supersedingIssue', 'issue.spinOffs', 'issue.discoveredFrom'],
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
  ...reader(
    'Seats.missionSessions@*.partition',
    ['issue.missionSessions'],
    'POD-7579',
    'session-seats.ts',
    "'partition', (issueId)",
  ),
  ...reader(
    'Seats.pageSessions@*.partition',
    ['issue.pageSessions'],
    'POD-7579',
    'session-seats.ts',
    "'partition', (issueId)",
  ),
  ...reader(
    'IssuePageRow.continuation',
    ['issue.canonicalIssue', 'issue.supersedingIssue', 'issue.spinOffs', 'issue.discoveredFrom'],
    'POD-7579',
    'issue-page.ts',
    'get continuation() { return missionView(this.pool).continuation(this.issue, false) }',
  ),
  ...reader(
    'IssueModel@*.relationGroups',
    ['issue.pageDependents'],
    'POD-7579',
    'models.ts',
    'get relationGroups()',
  ),
  ...reader(
    'IssueModel@*.memberSessionIds',
    ['issue.pageSessions'],
    'POD-7579',
    'models.ts',
    'get memberSessionIds(): ReturnType<typeof asSessionId>[]',
  ),
  ...reader(
    'IssueModel@*.liveSeatId',
    ['issue.pageSessions'],
    'POD-7579',
    'models.ts',
    'get liveSeatId(): string | undefined',
  ),
  ...reader(
    'IssueModel@*.live',
    ['issue.missionSessions'],
    'POD-7579',
    'models.ts',
    'get live(): boolean',
  ),
  ...reader(
    'IssueModel@*.missionWorking',
    ['issue.missionSessions'],
    'POD-7579',
    'models.ts',
    'get missionWorking(): boolean',
  ),
  ...reader(
    'IssueModel@*.missionBucket',
    ['issue.missionSessions'],
    'POD-7579',
    'models.ts',
    'get missionBucket(): MissionTaskBucket | null',
  ),
  ...reader(
    'IssueModel@*.missionBucket',
    ['issue.bornSessions'],
    'POD-7582',
    'models.ts',
    'get missionBucket(): MissionTaskBucket | null',
  ),
  // The new phone app (POD-7578) reached integrate in POD-7592; its board and
  // its task rows still read these relations raw. Moving them onto holding
  // reads is the phone follow-up's job (POD-7555).
  ...reader(
    'observerTaskRow',
    ['issue.pageSessions', 'issue.pageDependents'],
    'POD-7555',
    'apps/mobile/src/screens/TasksSurface.tsx',
    'const TaskRow = observer(function TaskRow({',
  ),
  ...reader(
    'BoardTask.mark',
    ['issue.missionSessions'],
    'POD-7555',
    'mobile-tasks.ts',
    '@lazy get mark(): TaskRowMark {',
  ),
  ...reader(
    'IssueModel.descendantTaskProgress',
    ['issue.treeChildren', 'issue.pageSessions'],
    'POD-7555',
    'models.ts',
    'private get descendantTaskProgress(): TaskProgress | null {',
  ),
  ...reader(
    'WorklistIssue.formalChildIds',
    ['issue.children'],
    'POD-7555',
    'worklist/issue.ts',
    'private get formalChildIds(): readonly string[] {',
  ),
  ...reader(
    'WorklistIssue.unitOwnUnit',
    ['issue.spinOffs'],
    'POD-7555',
    'worklist/issue.ts',
    "private get unitOwnUnit(): UnitOwn['unit'] {",
  ),
  ...reader(
    'WorklistIssue.unitOwnDone',
    ['issue.spinOffs'],
    'POD-7555',
    'worklist/issue.ts',
    "private get unitOwnDone(): UnitOwn['done'] {",
  ),
  ...reader(
    'observerIssueNow',
    ['issue.missionSessions'],
    'POD-7579',
    'apps/web/src/features/issues/issue-page/IssueNow.tsx',
    'export const IssueNow = observer(function IssueNow(',
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
