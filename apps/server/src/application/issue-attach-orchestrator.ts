import type { IssueWire } from '@podium/model'
import { onBehalfOfUser, type CommandPrincipal } from '../command-principal'
import type { IssueCaller } from '../modules/issues/registry'
import type { IssueAttentionCapability } from '../modules/issues/service'

export type IssueAttachInput = Parameters<IssueAttentionCapability['attachSession']>[0]

export interface IssueAttachOrchestratorPorts {
  transact<T>(work: () => T): T
  attention: Pick<IssueAttentionCapability, 'attachSession'>
}

/**
 * L3 application workflow for the issue/session aggregate boundary.
 *
 * The caller is accepted once from the authenticated transport and is carried
 * unchanged through the whole workflow. The shared SQLite transaction encloses
 * issue creation/dependency writes, the session attachment, abandoned-draft
 * cleanup, and their change-log rows.
 */
export class IssueAttachOrchestrator {
  constructor(private readonly ports: IssueAttachOrchestratorPorts) {}

  execute(caller: IssueCaller, input: IssueAttachInput): IssueWire {
    const principal = this.transportPrincipal(caller)
    return this.ports.transact(() =>
      this.ports.attention.attachSession({
        ...input,
        principal,
      }),
    )
  }

  private transportPrincipal(caller: IssueCaller): Exclude<CommandPrincipal, { kind: 'system' }> {
    const principal = caller.principal
    if (!principal || principal.kind === 'system' || onBehalfOfUser(principal) === null) {
      throw new Error('issue attach requires a transport-derived human or delegated principal')
    }
    return principal
  }
}
