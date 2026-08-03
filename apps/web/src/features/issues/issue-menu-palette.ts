import { reposToViews } from '@podium/client-core/viewmodels'
import type { MachineWire, SessionMeta } from '@podium/model'
import type { IssueViewModel } from '@/app/store'
import { handoffRejectionText } from '@/lib/SessionContextMenu'
import { issueHandoffAvailability, issueMenuEligibility } from './issue-context-menu'
import { createIssueMenuData, type IssueMenuData } from './issue-menu-config'

export function paletteIssueMenuData(input: {
  issues: readonly IssueViewModel[]
  issueId: string | null | undefined
  sessions: readonly SessionMeta[]
  repos: Parameters<typeof reposToViews>[0]
  machines: readonly MachineWire[]
  handoffEnabled: boolean
}): IssueMenuData | null {
  const issue = input.issues.find((candidate) => candidate.id === input.issueId)
  if (!issue) return null

  const handoff = input.handoffEnabled
    ? issueHandoffAvailability(issue, input.sessions, reposToViews(input.repos), [
        ...input.machines,
      ])
    : null
  const handoffSession = handoff && 'session' in handoff ? handoff.session : null
  const candidates =
    handoff && 'availability' in handoff && !handoff.availability.blocker
      ? handoff.availability.candidates
      : []

  return createIssueMenuData({
    issues: [issue],
    allIssues: input.issues,
    eligibility: issueMenuEligibility([issue], 'board'),
    surface: 'board',
    handoffEnabled: input.handoffEnabled && handoff !== null,
    handoff: handoff
      ? {
          sessionId: handoffSession?.sessionId,
          options: candidates.map(({ machine, rejection }) => ({
            id: machine.id,
            value: machine.id,
            label: machine.name,
            disabled: rejection !== undefined,
            hint:
              rejection && handoffSession
                ? handoffRejectionText(rejection, handoffSession.agentKind)
                : undefined,
          })),
        }
      : undefined,
  })
}
