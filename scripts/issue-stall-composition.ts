/** Aggregate the SQL composition of journal stall records, grouped by build.
 * Usage: journalctl --user --since ... -o cat | bun scripts/issue-stall-composition.ts [--top=N]
 * Counts are executions named in stall records, not total database traffic.
 * `--top=N` instead lists the N statements named most often, per build (POD-6146).
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
/** The statements named most often in stall records, per build. A stall record names only its
 * top few statements, with the SQL text truncated, so these are executions named in stalls,
 * grouped by the truncated text — not total database traffic. */
export function topStallStatements(input: string, limit: number) {
  const builds = new Map<string, Map<string, { count: number; wallMs: number; stalls: number }>>()
  for (const line of input.split('\n')) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record.msg !== 'server event-loop stall' || typeof record.sql !== 'string') continue
    const build = String(record.v ?? 'unknown')
    const statements = builds.get(build) ?? new Map()
    for (const statement of record.sql.split(' | ')) {
      const match = /^(\d+)x\/(\d+(?:\.\d+)?)ms\/[^ ]+ (.*)$/.exec(statement)
      if (!match) continue
      const entry = statements.get(match[3]!) ?? { count: 0, wallMs: 0, stalls: 0 }
      entry.count += Number(match[1])
      entry.wallMs += Number(match[2])
      entry.stalls++
      statements.set(match[3]!, entry)
    }
    builds.set(build, statements)
  }
  return Object.fromEntries([...builds].map(([build, statements]) => [build,
    [...statements].map(([sql, entry]) => ({ sql, ...entry }))
      .sort((a, b) => b.count - a.count || a.sql.localeCompare(b.sql)).slice(0, limit)]))
}
if (import.meta.main) {
  const top = process.argv.find(argument => argument.startsWith('--top='))
  const input = await Bun.stdin.text()
  console.log(JSON.stringify(top ? topStallStatements(input, Number(top.slice('--top='.length))) : issueStallComposition(input), null, 2))
}
