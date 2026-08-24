import { lazy } from 'react'

/**
 * THE PANEL BODY IS NOT THE FIRST PAINT (POD-2730).
 *
 * `AgentPanel` is the largest single surface in this app — the session terminal,
 * the chat view and everything they render — and both of its call sites
 * (`PanelDeck` for deck tabs, `Workspace` for an orphaned session) imported it
 * statically. That made the whole of it eager: xterm and its WebGL addon
 * (390,297 bytes), the chat block vocabulary, `marked` and `dompurify`. None of
 * it can paint until the replica has synced far enough to name a session, which
 * is a round trip; the chunk read that replaces it is not.
 *
 * ONE module for both call sites on purpose. Two `lazy()` calls over the same
 * specifier would still share a chunk, but they would be two component
 * identities, and a deck tab that moved between the two would remount its
 * terminal. This way `<AgentPanel>` is the same component wherever it renders.
 *
 * scripts/web-bundle-budget.ts fails the build by name if AgentPanel is eager
 * again — see PANEL_BODY_MODULES there.
 */
export const AgentPanel = lazy(() =>
  import('./AgentPanel').then((module) => ({ default: module.AgentPanel })),
)

/** Warm the panel chunk once the shell is up; see prefetchAfterFirstPaint. */
export function loadAgentPanel(): Promise<unknown> {
  return import('./AgentPanel')
}
