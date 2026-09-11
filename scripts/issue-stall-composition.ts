/** Aggregate the SQL composition of journal stall records, grouped by build.
 * Usage: journalctl --user --since ... -o cat | bun scripts/issue-stall-composition.ts
 * Counts are executions named in stall records, not total database traffic.
 */
export function issueStallComposition(input: string) {
  const builds = new Map<string, { first: string; last: string; stalls: number; total: number; issues: number; grants: number; messages: number }>()
  for (const line of input.split('\n')) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record.msg !== 'server event-loop stall' || typeof record.sql !== 'string') continue
    const build = String(record.v ?? 'unknown')
    const result = builds.get(build) ?? { first: record.ts, last: record.ts, stalls: 0, total: 0, issues: 0, grants: 0, messages: 0 }
    result.last = record.ts
    result.stalls++
    for (const statement of record.sql.split(' | ')) {
      const match = /^(\d+)x\/[^ ]+ (.*)$/.exec(statement)
      if (!match) continue
      const count = Number(match[1])
      const sql = match[2]!.replaceAll('"', '').toLowerCase()
      result.total += count
      // Full issue rows are truncated before FROM in the journal. Match their
      // distinctive SELECT prefix, exactly as in the original live analysis.
      if (sql.startsWith('select id, owner_user_id, visibility, created_by_actor, created_by_on_behalf_of, repo_path')) result.issues += count
      if (sql.startsWith('select resource_kind, resource_id, grantee, verb, owner, visibility')) result.grants += count
      if (sql.startsWith('select id, text, attempts, input_origin, principal_kind') || /\bfrom messages\b/.test(sql)) result.messages += count
    }
    builds.set(build, result)
  }
  return Object.fromEntries([...builds].map(([build, counts]) => [build, {
    ...counts,
    issuePercent: counts.total ? 100 * counts.issues / counts.total : null,
    issuePercentExcludingGrantsAndMessages: counts.total - counts.grants - counts.messages > 0
      ? 100 * counts.issues / (counts.total - counts.grants - counts.messages) : null,
  }]))
}
if (import.meta.main) console.log(JSON.stringify(issueStallComposition(await Bun.stdin.text()), null, 2))
