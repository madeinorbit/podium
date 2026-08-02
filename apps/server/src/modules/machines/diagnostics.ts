import { createHash } from 'node:crypto'
import { asIssueId, type IssueId, type UserId } from '@podium/model'
import type { EventMap } from '../bus'
import type { CreateIssueInput } from '../issues/service'

export type MachineDiagnostic = EventMap['machine.diagnostic']

export interface MachineDiagnosticRouterDeps {
  recipients(machineId: string): UserId[]
  repoPath(machineId: string): string | undefined
  issueExists(id: IssueId): boolean
  createIssue(input: CreateIssueInput): void
  sendMail(issueId: IssueId, body: string): void
  notify(userId: UserId, notice: { title: string; body: string }): void
  warn(message: string): void
}

const issueIdFor = (recipient: UserId, diagnostic: MachineDiagnostic): IssueId => {
  const key = [
    recipient,
    diagnostic.machineId,
    diagnostic.code,
    diagnostic.observedVersion ?? 'none',
  ].join('\0')
  return asIssueId(
    `iss_machine_diag_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
  )
}

/**
 * Turn a transport-scoped machine warning into one durable, personal attention
 * item per owner/admin. Deterministic ids make daemon restarts idempotent.
 */
export function routeMachineDiagnostic(
  diagnostic: MachineDiagnostic,
  deps: MachineDiagnosticRouterDeps,
): void {
  const recipients = [...new Set(deps.recipients(diagnostic.machineId))]
  const repoPath = deps.repoPath(diagnostic.machineId)
  for (const recipient of recipients) {
    const issueId = issueIdFor(recipient, diagnostic)
    if (deps.issueExists(issueId)) continue
    deps.notify(recipient, { title: diagnostic.title, body: diagnostic.body })
    if (!repoPath) {
      deps.warn(
        `[podium] cannot create diagnostic issue for ${diagnostic.machineId}: no repository is registered`,
      )
      continue
    }
    deps.createIssue({
      id: issueId,
      repoPath,
      title: diagnostic.title,
      description: 'A host integration was disabled because its installed version is unrecognized.',
      brief: [
        diagnostic.body,
        `Machine: ${diagnostic.machineId}`,
        ...(diagnostic.observedVersion ? [`Observed version: ${diagnostic.observedVersion}`] : []),
      ].join('\n'),
      startNow: false,
      ownerUserId: recipient,
      visibility: 'personal',
      origin: 'agent',
      audience: 'human',
      createdByActor: 'system:machine-diagnostic',
      createdByOnBehalfOf: null,
    })
    deps.sendMail(issueId, diagnostic.body)
  }
}
