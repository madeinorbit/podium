import type { IssueProjection } from '@podium/model'
import { type CommandPrincipal, onBehalfOfUser } from '../command-principal'
import type { IssueCaller } from '../modules/issues/command-ctx'
import type { IssueAttentionCapability } from '../modules/issues/service'
import type { IssueWriter, WriterRest } from '../modules/issues/service/types'

export type IssueAttachInput = WriterRest<IssueAttentionCapability['attachSession']>[0]

export interface IssueAttachOrchestratorPorts {
  transact<T>(work: () => Promise<T>): Promise<T>
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

  async execute(caller: IssueCaller, input: IssueAttachInput): Promise<IssueProjection> {
    const principal = this.transportPrincipal(caller)
    return await this.ports.transact(
      async () =>
        await this.ports.attention.attachSession(this.commandWriter(caller), {
          ...input,
          principal,
        }),
    )
  }

  /** The attach's own writer: `issues.attachSession` runs on `sync.submit`, whose
   *  handler hands it the command's writer (POD-6603). There is no other. */
  private commandWriter(caller: IssueCaller): IssueWriter {
    if (caller.writer === undefined) {
      throw new Error('issue attach runs on sync.submit; it has no writer outside a command')
    }
    return caller.writer
  }

  private transportPrincipal(caller: IssueCaller): Exclude<CommandPrincipal, { kind: 'system' }> {
    const principal = caller.principal
    if (!principal || principal.kind === 'system' || onBehalfOfUser(principal) === null) {
      throw new Error('issue attach requires a transport-derived human or delegated principal')
    }
    return principal
  }
}
