import { useDeviceState, useUiValue } from '@podium/client-core/react'
/**
 * STARTING A TASK IS ONE ACTION, AND IT IS NOT A SPAWN (POD-1469).
 *
 * The sidebar used to open work with `New <Agent> in <Repo>`: a chip that
 * spawned a harness into a repo the moment it was clicked, with a chevron
 * beside it holding the only way to say WHICH harness and WHERE. Two problems,
 * one shape. The agent was chosen before the work was described — so the
 * decision the operator actually had in mind ("fix the flaky test") was made
 * after the two decisions they had no opinion about — and the chevron hid a
 * whole menu of placement inside a control that read as a single button.
 *
 * `New task` makes none of those choices. It opens the cold-start composer,
 * where agent, model, machine, repo AND prompt are all one instrument, as an
 * OVERLAY over whatever is on screen (POD-2079; see `new-task-overlay.ts`). It
 * used to clear the selection instead, which reached the same composer by
 * throwing the screen behind it away; now Cancel or Esc hands that screen back
 * exactly as it was. Nothing is created until the operator launches — an
 * abandoned new task leaves no empty vessel in the column behind it.
 *
 * SEEDING THE PROJECT IS THE WHOLE REASON THIS TAKES AN ARGUMENT. An empty
 * project's `Start first task` names a repo, and arriving at a composer pointed
 * at a different one would make that button a lie. The seed is written into the
 * composer's own persisted draft, so there is exactly one place that decides
 * which project the composer opens on.
 */

import { shallowEqual } from '@podium/client-core/shallow-equal'
import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import { machinePathsEqual } from '@podium/model/browser'
import { useEffect, useRef } from 'react'
import { useRuntimeSelector } from '@/app/store'
import {
  EMPTY_FIRST_TASK_DRAFT,
  persistFirstTaskDraft,
  readFirstTaskDraft,
} from '@/features/setup/first-task-draft'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { newTaskOverlayOrigin, openNewTaskOverlay } from './new-task-overlay'

export interface NewTask {
  /** Take the shell to a blank mission. `repoPath` preselects the project. */
  startNewTask: (repoPath?: string) => void
}

export function useNewTask(
  /**
   * Whether this caller owns the ⌘N chord. Exactly ONE mounted caller may
   * (POD-1058, inherited from the spawn row it replaces): the binding is a
   * window keydown listener plus a global `__PODIUM_NEW_AGENT__` slot the macOS
   * shell evals, so two live owners answer one press twice. The wide column's
   * button takes it; the empty-project rows and the composer do not.
   */
  { bindChord = false }: { bindChord?: boolean } = {},
): NewTask {
  const { uiState, view, selectedIssueId, setView } = {
    uiState: useDeviceState(),
    view: useUiValue('view'),
    selectedIssueId: useUiValue('selectedIssueId'),
    setView: useUiValue('setView'),
  }

  const startNewTask = (repoPath?: string): void => {
    // THE PROMPT SURVIVES A CANCEL (POD-2082). Esc and Cancel close the overlay
    // and nothing else, so reopening New task shows the half-written prompt
    // again; only a Start clears it (the composer does, once the launch
    // settles). The agent, model, effort and machine are settings and always
    // carry over. The retry ids do not: they belong to a create that was
    // abandoned. A launch still in flight keeps its prompt to itself — showing
    // it again would invite a second Start of the same words.
    const previous = readFirstTaskDraft(uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY))
    // Already open: the prompt on screen is the one being written, so it stays.
    // A project's + only re-points it at that project.
    if (newTaskOverlayOrigin()) {
      if (repoPath && !machinePathsEqual(repoPath, previous.repoPath))
        persistFirstTaskDraft(uiState, {
          ...EMPTY_FIRST_TASK_DRAFT,
          ...previous,
          repoPath,
          machineId: '',
          // A reserved create belongs to the project it was reserved for.
          launchKind: '',
          pendingIssueId: '',
          createIssueId: '',
          createSessionId: '',
          createMutationId: '',
          startMutationId: '',
          attachmentPaths: [],
          launchError: '',
        })
      return
    }
    persistFirstTaskDraft(uiState, {
      ...EMPTY_FIRST_TASK_DRAFT,
      repoPath: repoPath ?? previous.repoPath,
      // A named project brings its own machine with it; keeping the last one
      // would point the composer at a host that may not hold this repo at all.
      machineId:
        repoPath && !machinePathsEqual(repoPath, previous.repoPath) ? '' : previous.machineId,
      agent: previous.agent,
      model: previous.model,
      effort: previous.effort,
      title: previous.launchKind && !previous.launchError ? '' : previous.title,
    })
    // Opened over the current screen, which stays mounted and selected
    // underneath; only the view is switched, and only if it has to be.
    const active = document.activeElement
    openNewTaskOverlay({
      view,
      selectedIssueId,
      returnFocus: active instanceof HTMLElement && active !== document.body ? active : null,
    })
    if (view !== 'workspace') setView('workspace')
  }

  // ⌘N — the chord the spawn row used to answer with a spawn (POD-790). Two
  // deliveries, one action: a rebuilt macOS shell owns the accelerator (an
  // unclaimed one never reaches the webview) and evals `__PODIUM_NEW_AGENT__`;
  // a keydown covers every other native shell. Browser tabs are left alone —
  // ⌘N / Ctrl+N open a window there.
  const ref = useRef<() => void>(() => {})
  ref.current = () => startNewTask()
  useEffect(() => {
    if (!bindChord) return
    if (!nativeDesktopBridge()) return
    const g = globalThis as { __PODIUM_NEW_AGENT__?: () => void }
    const handler = (): void => ref.current()
    g.__PODIUM_NEW_AGENT__ = handler
    const onKey = (event: KeyboardEvent): void => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'n'
      ) {
        event.preventDefault()
        handler()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      // Only ours: an expand/collapse swaps rail and row, and React mounts the
      // arriving one before unmounting the leaving one.
      if (g.__PODIUM_NEW_AGENT__ === handler) delete g.__PODIUM_NEW_AGENT__
      window.removeEventListener('keydown', onKey)
    }
  }, [bindChord])

  return { startNewTask }
}

/** Whether ⌘N is actually bound on this build. The hint is only rendered where
 *  the chord exists — a made-up shortcut on a button is worse than none, and in
 *  a browser tab the OS owns ⌘N. */
export function newTaskChordBound(): boolean {
  return nativeDesktopBridge() !== undefined
}
