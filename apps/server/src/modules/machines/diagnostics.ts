import { createHash } from 'node:crypto'
import { asIssueId, type IssueId, type UserId, type MachineId } from '@podium/model'
import type { EventMap } from '../bus'
import type { CreateIssueInput } from '../issues/service'

export type MachineDiagnostic = EventMap['machine.diagnostic']

export interface MachineDiagnosticRouterDeps {
  recipients(machineId: MachineId): UserId[] | Promise<UserId[]>
  repoPath(machineId: MachineId): string | undefined | Promise<string | undefined>
  issueExists(id: IssueId): boolean | Promise<boolean>
  createIssue(input: CreateIssueInput): void | Promise<unknown>
  sendMail(issueId: IssueId, body: string): void | Promise<unknown>
  notify(userId: UserId, notice: { title: string; body: string }): void | Promise<unknown>
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
export async function routeMachineDiagnostic(
  diagnostic: MachineDiagnostic,
  deps: MachineDiagnosticRouterDeps,
): Promise<void> {
  const recipients = [...new Set(await deps.recipients(diagnostic.machineId))]
  const repoPath = await deps.repoPath(diagnostic.machineId)
  for (const recipient of recipients) {
    const issueId = issueIdFor(recipient, diagnostic)
    if (await deps.issueExists(issueId)) continue
    await deps.notify(recipient, { title: diagnostic.title, body: diagnostic.body })
    if (!repoPath) {
      deps.warn(
        `[podium] cannot create diagnostic issue for ${diagnostic.machineId}: no repository is registered`,
      )
      continue
    }
    await deps.createIssue({
      id: issueId,
      repoPath,
      title: diagnostic.title,
      // Only the daemon knows what actually degraded; the fallback is the one
      // diagnostic that predates the field (an unsupported integration version).
      description:
        diagnostic.description ??
        'A host integration was disabled because its installed version is unrecognized.',
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
    await deps.sendMail(issueId, diagnostic.body)
  }
}
