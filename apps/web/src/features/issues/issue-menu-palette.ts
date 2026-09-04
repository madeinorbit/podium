import { reposToViews } from '@podium/client-core/viewmodels'
import type { MachineWire, SessionMeta, IssueId } from '@podium/model/browser'
import type { IssueViewModel } from '@/app/store'
import { handoffRejectionText } from '@/lib/session-context-menu'
import { issueHandoffAvailability, issueMenuEligibility } from './issue-context-menu'
import { createIssueMenuData, type IssueMenuData } from './issue-menu-config'

export function paletteIssueMenuData(input: {
  issues: readonly IssueViewModel[]
  issueId: IssueId | null | undefined
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
    // ITS OWN SURFACE (POD-1470), no longer borrowing the board's. The palette
    // is not a list of tasks: it acts on the one already in focus, so it keeps
    // the entries the lists dropped.
    eligibility: issueMenuEligibility([issue], 'palette'),
    surface: 'palette',
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
                ? handoffRejectionText(rejection, handoffSession.agentKind, machine)
                : undefined,
          })),
        }
      : undefined,
  })
}
