/**
 * The presence seam, stubbed for suites that render `AgentPanel` for reasons
 * other than presence (POD-1535).
 *
 * `usePresenceRoom` reads the hub off the client-core StoreProvider, which
 * these focused renders do not mount. Stubbing it here rather than degrading
 * the hook keeps a missing provider LOUD in the app: a component that cannot
 * reach a hub has no presence, and silently rendering "unknown" forever is the
 * shape of bug this deliverable exists to remove.
 *
 * Use as:
 *   vi.mock('@podium/client-core/react', async () =>
 *     (await import('./test-support/presence-mock')).presenceSeamStub())
 */

export function presenceSeamStub(): Record<string, unknown> {
  return {
    usePresenceRoom: () => ({ status: 'unknown' as const }),
    useCurrentPrincipal: () => null,
  }
}
