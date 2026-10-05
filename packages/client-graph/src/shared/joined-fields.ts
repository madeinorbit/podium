import { formatSessionRef } from '@podium/protocol'

type Row = Readonly<Record<string, unknown>>
export type CompanionRead = (kind: 'machine' | 'repo', id: string) => Row | undefined
const SESSION_JOINS: Readonly<Record<string, readonly string[]>> = {
  machineName: ['machineId'],
  condition: ['machineId', 'agentKind'],
  handoffTarget: ['handoffTargetMachineId'],
  displayRef: ['refRepoId', 'refSeq', 'refLetter', 'refDraft'],
}
const ISSUE_JOINS: Readonly<Record<string, readonly string[]>> = { repoPath: ['repoId'] }
export function joinInputs(entity: string, field: string): readonly string[] | undefined {
  return (entity === 'session' ? SESSION_JOINS : entity === 'issue' ? ISSUE_JOINS : {})[field]
}

/** A read facade, never a stored composite. Every derived getter follows just
 * its own companion address; changing the companion leaves all source rows alone. */
export function joinedFields(entity: string, row: Row, fields: readonly string[], read: CompanionRead): Row {
  const out = { ...row }
  for (const field of fields) {
    const inputs = joinInputs(entity, field)
    if (!inputs || !inputs.some(key => Object.hasOwn(row, key))) continue
    Object.defineProperty(out, field, {
      enumerable: true,
      get() {
        // Directly-fed fixtures can already carry a display value without ids.
        // Production feed rows contain normalized join keys only.
        if (entity === 'issue')
          return typeof row.repoId === 'string' ? read('repo', row.repoId)?.repoPath ?? '' : row[field] ?? ''
        if (field === 'machineName')
          return typeof row.machineId === 'string' ? read('machine', row.machineId)?.name ?? '' : row[field] ?? ''
        if (field === 'condition') {
          if (typeof row.machineId !== 'string') return row[field]
          const machine = read('machine', row.machineId)
          return (machine?.loggedOutHarnesses as readonly string[] | undefined)?.includes(String(row.agentKind ?? '')) ? 'logged-out' : undefined
        }
        if (field === 'handoffTarget')
          return typeof row.handoffTargetMachineId === 'string' ? read('machine', row.handoffTargetMachineId)?.name : row[field]
        if (typeof row.refRepoId !== 'string') return row[field]
        const prefix = read('repo', row.refRepoId)?.prefix
        if (typeof prefix !== 'string' || !prefix) return undefined
        if (typeof row.refSeq === 'number' && typeof row.refLetter === 'string' && row.refLetter)
          return formatSessionRef({ prefix, seq: row.refSeq, letter: row.refLetter })
        if (typeof row.refDraft === 'number') return formatSessionRef({ prefix, draft: row.refDraft })
        return undefined
      },
    })
  }
  return out
}

/** Expand declarations to stored source keys. Joined results never enter extras. */
export function storedFields(entity: string, fields: readonly string[]): string[] {
  return [...new Set(fields.flatMap(field => joinInputs(entity, field) ?? [field]))]
}
export const SESSION_JOIN_FIELDS = Object.keys(SESSION_JOINS)
