/** Existing raw readers remain explicit until their owning follow-up moves them. */
export interface RawRelationReader {
  readonly reader: string
  readonly relation: string
  readonly followUp: `POD-${number}`
  /** Source declaration, checked so an exception cannot outlive its reader. */
  readonly file: string
  readonly declaration: string
}

export const RAW_RELATION_READERS: readonly RawRelationReader[] = []

/** Names can carry an instance id; the reader's declared name is stable. */
export const rawReaderName = (name: string): string =>
  name.replace(/@\d+$/, '').replace(/:[^.]*/g, ':*')

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
