/** Decides whether a Claude hook event should carry injected `prime` context, and builds the
 *  additionalContext response. Primes once per (re)start; a PreCompact re-arms it so the next
 *  prompt re-injects after compaction. Relay fetches the session's capability-scoped prime. */
export function createPrimeInjector(
  relay: (sessionId: string) => Promise<{ ok: boolean; result?: unknown }>,
): { respondTo(sessionId: string, payload: unknown): Promise<string | null>; reset(sessionId: string): void } {
  const primed = new Set<string>()
  return {
    reset(sessionId) {
      primed.delete(sessionId)
    },
    async respondTo(sessionId, payload) {
      const event = (payload as { hook_event_name?: unknown })?.hook_event_name
      if (event === 'PreCompact') {
        primed.delete(sessionId)
        return null
      }
      if (event !== 'SessionStart' && event !== 'UserPromptSubmit') return null
      if (primed.has(sessionId)) return null
      const r = await relay(sessionId)
      if (!r.ok || typeof r.result !== 'string' || r.result.length === 0) return null
      primed.add(sessionId)
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: r.result },
      })
    },
  }
}
