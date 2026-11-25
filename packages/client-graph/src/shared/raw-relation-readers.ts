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
  // Mission provenance: an issue a member's session started joins the
  // mission. The deck's tree brings its issues and their roster seats, not
  // the archived senders nor the issues they started outside the tree.
  // Holding session.ofIssue per member and issueProjection.startedBy per
  // session is the per-row history POD-7555 reverted; the walk reads memory
  // until one tree-wide read answers provenance, which belongs with POD-7602
  // (the loader widens per-row demand).
  ...reader(
    'Mission@*.members',
    ['issue.missionSessions', 'session.missionStartedIssues'],
    'POD-7580',
    'mission.ts',
    "const members = cachedKey('Mission', 'members',",
  ),
  // The per-task facts over an issue's whole session history. The deck reads
  // them only behind its open archive's hold (POD-7580); the header's mission
  // fold and navigation activity still read them raw. The sidebar's and the
  // board's rows read what the policy holds instead
  // (policy-relation-readers.ts, POD-7581); the issue page holds its own
  // rosters (issue-page.ts, POD-7579).
  ...reader(
    'Seats.missionSessions@*.partition',
    ['issue.missionSessions'],
    'POD-7580',
    'session-seats.ts',
    "'partition', (issueId)",
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
