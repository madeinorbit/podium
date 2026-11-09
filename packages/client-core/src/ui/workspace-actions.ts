import type { TabId, WorkspaceLayout } from '../values'
import { closeTab } from '../values'
import {
  NAVIGATION_LOADING,
  overlayState,
  resolvedWorkspaceKey,
  type ScreenState,
  type WorkspacePatch,
  type WorkspaceSelection,
  workspaceFor,
  workspacesPatch,
  workspaceWritePatch,
} from './state'

/** The slice of action state a workspace write reads. */
type WorkspaceStateSlice = Pick<
  ScreenState,
  'selectedIssueId' | 'selectedWorktree' | 'workspaces' | 'navigation'
>

/** Reduce the current workspace and re-derive the pane mirrors — the pure core
 *  of every workspace action. */
export function workspaceEdit(
  st: WorkspaceStateSlice,
  reduce: (ws: WorkspaceLayout) => WorkspaceLayout,
  selection?: Partial<WorkspaceSelection>,
): WorkspacePatch {
  const key = resolvedWorkspaceKey(selection ? overlayState(st, selection) : st)
  if (key === NAVIGATION_LOADING) return {}
  return workspaceWritePatch(st, key, reduce(workspaceFor(st, key)))
}

/**
 * Drop a tab from EVERY workspace, not just the one on screen.
 *
 * Used where the thing behind the tab is gone (a killed session, a closed file),
 * which is the only reason a tab may disappear from a workspace the operator is
 * not looking at. Closing a tab by hand goes through `closeWorkspaceTab` and
 * touches the current workspace alone.
 */
export function forgetTab(st: WorkspaceStateSlice, tabId: TabId): WorkspacePatch {
  return workspacesPatch(st, (ws) => closeTab(ws, tabId))
}

/**
 * The pane scalars after a tab is forgotten.
 *
 * `patch` carries the mirror whenever the layout moved, and the mirror is the
 * ONLY thing allowed to write these — spread it whole. The fallbacks cover the
 * case where no layout held the tab (nothing to mirror) but a pane scalar still
 * names it, which is the pre-POD-710 restore path. `=== undefined` rather than
 * `??`, because `null` is a value the mirror legitimately computes: a `??` here
 * discarded "this pane is now empty" and kept the dead id.
 */
export function forgottenPanes(
  patch: WorkspacePatch,
  st: Pick<ScreenState, 'paneA' | 'paneB'>,
  tabId: TabId,
): WorkspacePatch {
  return {
    ...patch,
    ...(patch.paneA === undefined && st.paneA === tabId ? { paneA: null } : {}),
    ...(patch.paneB === undefined && st.paneB === tabId ? { paneB: null } : {}),
  }
}

/**
 * How long {@link Store.focusIssueSession} waits for a started issue's session
 * to reach this client before giving up.
 *
 * The server has already spawned the session by the time `issues.start`
 * resolves, so what is being waited on is the replica delta — milliseconds on a
 * live socket. The window is long enough to cover a reconnect and short enough
 * that a launch which genuinely produced nothing stops holding a navigation
 * that would land on a session the operator never asked for.
 */
export const ISSUE_SESSION_WAIT_MS = 15_000

/**
 * Read state until it answers, or give up.
 *
 * `read` returns `undefined` for "not yet"; anything else resolves the wait.
 * The re-read after subscribing closes the gap between the first read and the
 * subscription — a delta landing in that window would otherwise be missed and
 * the wait would sit out its whole timeout with the answer already in state.
 */
export function waitForState<T>(
  subscribe: (listener: () => void) => () => void,
  read: () => T | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  const first = read()
  if (first !== undefined) return Promise.resolve(first)
  return new Promise<T | undefined>((resolve) => {
    let settled = false
    let off: () => void = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: T | undefined): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      off()
      resolve(value)
    }
    const attempt = (): void => {
      const value = read()
      if (value !== undefined) finish(value)
    }
    timer = setTimeout(() => finish(undefined), timeoutMs)
    off = subscribe(attempt)
    attempt()
  })
}
