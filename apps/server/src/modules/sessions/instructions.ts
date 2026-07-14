import type { AgentInstruction, AgentKind } from '@podium/protocol'

export interface SessionInstructionContext {
  sessionId: string
  cwd: string
  agentKind: AgentKind
  issueId?: string
  workflowRevisionId?: string
  /** Resurrection only rehydrates instructions already attached to the session;
   * it must not adopt a default that appeared after the conversation began. */
  existingOnly?: boolean
}

export interface SessionInstructionContribution {
  content: string
  /** Runs only after the session row and spawn command exist. Providers use this
   * for side effects that must not survive a failed spawn preparation. */
  afterSpawn?(): void
}

export interface SessionInstructionProvider {
  /** Stable attribution and de-duplication key carried to the daemon. */
  source: string
  prepare(context: SessionInstructionContext): SessionInstructionContribution | null
}

export interface PreparedSessionInstructions {
  instructions: AgentInstruction[]
  commit(): void
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

  prepare(context: SessionInstructionContext): PreparedSessionInstructions {
    const contributions = [...this.providers.values()].flatMap((provider) => {
      const prepared = provider.prepare(context)
      const content = prepared?.content.trim()
      return prepared && content ? [{ provider, prepared, content }] : []
    })
    let committed = false
    return {
      instructions: contributions.map(({ provider, content }) => ({
        source: provider.source,
        content,
      })),
      commit() {
        if (committed) return
        committed = true
        for (const { prepared } of contributions) prepared.afterSpawn?.()
      },
    }
  }
}
