/** Test-only S1 upgrade for an older-server corpus. No writes or export. */
import type { MachineProjection, SessionMeta, SessionUserStateWire } from '@podium/model'
import { asUserId } from '@podium/model'
import { parseSessionRef } from '@podium/protocol'
import type { FixtureCorpus } from './corpus'

export const SESSION_LEGACY_FIELDS = [
  'unread',
  'readAt',
  'snoozedUntil',
  'displayRef',
  'machineName',
  'condition',
  'handoffTarget',
] as const
export function stripSessionLegacy(row: SessionMeta): SessionMeta {
  const stripped = { ...row }
  for (const field of SESSION_LEGACY_FIELDS) Reflect.deleteProperty(stripped, field)
  return stripped
}

export function fixtureSessionHomes(corpus: FixtureCorpus, userId = 'operator') {
  const byPrefix = new Map(
    corpus.repoProjections.filter((repo) => repo.prefix).map((repo) => [repo.prefix!, repo]),
  )
  const userStates: SessionUserStateWire[] = []
  const machines = new Map<string, MachineProjection>(
    corpus.machines.map((machine) => [
      machine.id,
      {
        id: machine.id,
        name: machine.name,
        loggedOutHarnesses: (machine.inventory?.agents ?? [])
          .filter((agent) => agent.installed === true && agent.login.state === 'out')
          .map((agent) => agent.kind),
      },
    ]),
  )
  const issues = new Map(corpus.issues.map((row) => [row.id, row]))
  const sessions = corpus.sessions.map((row) => {
    userStates.push({
      userId: asUserId(userId),
      sessionId: row.sessionId,
      readAt: row.readAt ?? null,
      ...(row.snoozedUntil !== undefined ? { snoozedUntil: row.snoozedUntil } : {}),
    })
    if (row.machineId) {
      let machine = machines.get(row.machineId)
      if (!machine) {
        machine = { id: row.machineId, name: row.machineName ?? '', loggedOutHarnesses: [] }
        machines.set(row.machineId, machine)
      }
      if (row.condition === 'logged-out' && !machine.loggedOutHarnesses.includes(row.agentKind))
        machine.loggedOutHarnesses.push(row.agentKind)
    }
    const ref = row.displayRef ? parseSessionRef(row.displayRef) : null
    const repo = ref ? byPrefix.get(ref.prefix) : undefined
    const birth = row.refIssueId ? issues.get(row.refIssueId) : undefined
    const target = row.handoffTarget
      ? corpus.machines.find((machine) => machine.name === row.handoffTarget)
      : undefined
    return {
      ...row,
      ...(row.handoffTargetMachineId || target
        ? { handoffTargetMachineId: row.handoffTargetMachineId ?? target?.id }
        : {}),
      ...(row.refRepoId || repo?.id || birth?.repoId
        ? { refRepoId: row.refRepoId ?? repo?.id ?? birth?.repoId }
        : {}),
      ...(ref && 'seq' in ref
        ? { refSeq: row.refSeq ?? ref.seq, refLetter: row.refLetter ?? ref.letter }
        : {}),
      ...(ref && 'draft' in ref ? { refDraft: row.refDraft ?? ref.draft } : {}),
    }
  })
  return {
    sessions,
    userId,
    userStates,
    machines: [...machines.values()],
    repos: corpus.repoProjections,
  }
}
