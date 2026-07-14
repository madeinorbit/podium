import type { AgentInstruction } from '@podium/protocol'
import { ISSUE_SYSTEM_POINTER, SPEC_SYSTEM_POINTER } from './issue-system-pointer.js'

/** Built-in Podium guidance is just another attributed instruction source. The
 * launch adapters compose it with feature-provided fragments in one hidden
 * harness-native channel. */
export const CORE_AGENT_INSTRUCTIONS: AgentInstruction[] = [
  { source: 'podium:issues', content: ISSUE_SYSTEM_POINTER },
  { source: 'podium:specs', content: SPEC_SYSTEM_POINTER },
]

export function composeAgentInstructions(additional: AgentInstruction[] = []): string {
  const seen = new Set<string>()
  return [...CORE_AGENT_INSTRUCTIONS, ...additional]
    .flatMap((instruction) => {
      const source = instruction.source.trim()
      const content = instruction.content.trim()
      if (!source || !content) return []
      if (seen.has(source)) throw new Error(`duplicate agent instruction source: ${source}`)
      seen.add(source)
      return [content]
    })
    .join('\n\n')
}
