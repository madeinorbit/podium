/**
 * NEW TASK IS AN OVERLAY, NOT A NAVIGATION (POD-2079).
 *
 * `New task` used to clear the selection so the workspace fell through to the
 * cold-start composer. That made the composer reachable, but it threw away the
 * screen behind it: the selected task, its tabs, the dock and every scroll
 * position were gone, and backing out meant finding the task again by hand.
 *
 * The overlay leaves all of that mounted and untouched underneath. Opening it
 * records only what it changes itself (the main view, if it had to switch to
 * the workspace) and where focus was; closing it puts those two back. Nothing
 * else needs restoring because nothing else was changed.
 *
 * It is device-local, in-memory state: a reload lands on the screen that was
 * behind it, and the prompt survives in the composer's own persisted draft.
 */

import { FIRST_TASK_ACTIVATION_DRAFT_KEY, type MainView } from '@podium/client-core/ui-state'
import { useSyncExternalStore } from 'react'
import { readFirstTaskDraft } from '@/features/setup/first-task-draft'
import { usePersistedUiValue } from '@/lib/use-persisted-ui-state'

export interface NewTaskOverlayOrigin {
  /** The main view behind the overlay, restored on cancel. */
  view: MainView
  /** The selection behind the overlay. A different selection means the operator
   *  went somewhere (or a launch did), and the overlay gets out of the way. */
  selectedIssueId: string | null
  /** Where focus was, so cancel hands it back. */
  returnFocus: HTMLElement | null
}

let origin: NewTaskOverlayOrigin | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function openNewTaskOverlay(from: NewTaskOverlayOrigin): void {
  // A second press while open keeps the first origin: that is the screen the
  // operator will want back.
  if (origin) return
  origin = from
  emit()
}

/** Closes the overlay and returns what was behind it, or null if it was shut. */
export function closeNewTaskOverlay(): NewTaskOverlayOrigin | null {
  const from = origin
  if (!from) return null
  origin = null
  emit()
  return from
}

export function newTaskOverlayOrigin(): NewTaskOverlayOrigin | null {
  return origin
}

export function useNewTaskOverlayOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => origin !== null,
    () => false,
  )
}

/**
 * What the sidebar's draft row shows while the overlay is open: the project the
 * task will land in and the prompt so far. Null while the overlay is shut.
 */
export function useNewTaskDraftRow(): { repoPath: string; title: string } | null {
  const open = useNewTaskOverlayOpen()
  const draft = usePersistedUiValue(FIRST_TASK_ACTIVATION_DRAFT_KEY, readFirstTaskDraft)
  if (!open) return null
  return { repoPath: draft.repoPath, title: draft.title }
}
