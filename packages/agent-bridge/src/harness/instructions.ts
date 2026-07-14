import type { AgentInstruction } from '@podium/protocol'
export function composeAgentInstructions(additional: AgentInstruction[] = []): string {
  const seen = new Set<string>()
  return additional
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
