import type { AgentKind, IssueId, SessionId } from '@podium/model'
import type { AgentInstruction } from '@podium/protocol'

export interface SessionInstructionContext {
  sessionId: SessionId
  cwd: string
  agentKind: AgentKind
  issueId?: IssueId
  workflowRevisionId?: string
  /** Resurrection only rehydrates instructions already attached to the session;
   * it must not adopt a default that appeared after the conversation began. */
  existingOnly?: boolean
}

export interface SessionInstructionContribution {
  content: string
  /** Runs only after the session row and spawn command exist. Providers use this
   * for side effects that must not survive a failed spawn preparation. */
  afterSpawn?(): void | Promise<void>
}

export interface SessionInstructionProvider {
  /** Stable attribution and de-duplication key carried to the daemon. */
  source: string
  prepare(
    context: SessionInstructionContext,
  ): SessionInstructionContribution | null | Promise<SessionInstructionContribution | null>
}

export interface PreparedSessionInstructions {
  instructions: AgentInstruction[]
  commit(): Promise<void>
}

/** Composable preparation seam for non-user agent instructions. Features
 * register providers; session creation resolves them once, sends the attributed
 * fragments through the hidden harness channel, then commits provider side
 * effects after the spawn exists. */
export class SessionInstructionRegistry {
  private readonly providers = new Map<string, SessionInstructionProvider>()

  register(provider: SessionInstructionProvider): void {
    const source = provider.source.trim()
    if (!source) throw new Error('session instruction provider needs a source')
    if (this.providers.has(source))
      throw new Error(`duplicate session instruction provider: ${source}`)
    this.providers.set(source, { ...provider, source })
  }

  async prepare(context: SessionInstructionContext): Promise<PreparedSessionInstructions> {
    const contributions: Array<{
      provider: SessionInstructionProvider
      prepared: SessionInstructionContribution
      content: string
    }> = []
    for (const provider of this.providers.values()) {
      const prepared = await provider.prepare(context)
      const content = prepared?.content.trim()
      if (prepared && content) contributions.push({ provider, prepared, content })
    }
    let committed = false
    return {
      instructions: contributions.map(({ provider, content }) => ({
        source: provider.source,
        content,
      })),
      async commit() {
        if (committed) return
        committed = true
        for (const { prepared } of contributions) await prepared.afterSpawn?.()
      },
    }
  }
}
