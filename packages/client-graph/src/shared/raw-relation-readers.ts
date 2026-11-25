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
  // The deck's per-task facts over an issue's whole session history. The
  // sidebar's and the board's rows read what the policy holds instead
  // (policy-relation-readers.ts, POD-7581); the issue page holds its own
  // rosters (issue-page.ts, POD-7579).
  ...reader(
    'Seats.missionSessions@*.partition',
    ['issue.missionSessions'],
    'POD-7580',
    'session-seats.ts',
    "'partition', (issueId)",
  ),
  // Whether a session is open or working: such a session is starting or live,
  // and `session.live` (a policy collection) always holds every one of them,
  // so memory answers it. The sidebar's read is a declared policy read
  // (POD-7581); POD-7580 confirms the deck's.
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
