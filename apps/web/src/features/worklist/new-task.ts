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
 * `New task` makes none of those choices. It clears the selection, which is the
 * one state the shell already reads as "no mission on screen": the flight deck
 * goes to its empty tree and the workspace to the cold-start composer, which is
 * where agent, model, machine, repo AND prompt are all one instrument. Nothing
 * is created until the operator launches — an abandoned new task leaves no
 * empty vessel in the column behind it.
 *
 * SEEDING THE PROJECT IS THE WHOLE REASON THIS TAKES AN ARGUMENT. An empty
 * project's `Start first task` names a repo, and arriving at a composer pointed
 * at a different one would make that button a lie. The seed is written into the
 * composer's own persisted draft, so there is exactly one place that decides
 * which project the composer opens on.
 */

import { shallowEqual } from '@podium/client-core/store'
import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import { useEffect, useRef } from 'react'
import { installDesktopCommandHook } from '@/app/desktop-commands'
import { useStoreSelector } from '@/app/store'
import {
  EMPTY_FIRST_TASK_DRAFT,
  persistFirstTaskDraft,
  readFirstTaskDraft,
} from '@/features/setup/first-task-draft'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'

export interface NewTask {
  /** Take the shell to a blank mission. `repoPath` preselects the project. */
  startNewTask: (repoPath?: string) => void
}

export function useNewTask(
  /**
   * Whether this caller owns the new-task chord. Exactly ONE mounted caller may
   * (POD-1058, inherited from the spawn row it replaces): the binding is the
   * single `new-agent` hook the shell's keyboard and menu both dispatch to, so
   * two live owners would leave one of them holding a slot nothing calls. The
   * wide column's button takes it; the empty-project rows and the composer do not.
   */
  { bindChord = false }: { bindChord?: boolean } = {},
): NewTask {
  const { uiState, setSelectedIssueId, setSelectedWorktree, setView } = useStoreSelector(
    (store) => ({
      uiState: store.uiState,
      setSelectedIssueId: store.setSelectedIssueId,
      setSelectedWorktree: store.setSelectedWorktree,
      setView: store.setView,
    }),
    shallowEqual,
  )

  const startNewTask = (repoPath?: string): void => {
    // THE PROMPT IS CLEARED, THE INSTRUMENTS ARE NOT. A half-written prompt from
    // a task the operator walked away from has no business being the first thing
    // they read on the next one — but the agent, model, effort and machine they
    // chose are settings, not content, and re-picking them every time is the
    // friction this whole flow exists to remove. The retry ids go with the
    // prompt: they belong to a specific create that is now abandoned.
    const previous = readFirstTaskDraft(uiState.get(FIRST_TASK_ACTIVATION_DRAFT_KEY))
    persistFirstTaskDraft(uiState, {
      ...EMPTY_FIRST_TASK_DRAFT,
      repoPath: repoPath ?? previous.repoPath,
      // A named project brings its own machine with it; keeping the last one
      // would point the composer at a host that may not hold this repo at all.
      machineId: repoPath && repoPath !== previous.repoPath ? '' : previous.machineId,
      agent: previous.agent,
      model: previous.model,
      effort: previous.effort,
    })
    setSelectedIssueId(null)
    setSelectedWorktree(null)
    setView('workspace')
  }

  // ⌘N / Ctrl+N — the chord the spawn row used to answer with a spawn
  // (POD-790). This publishes the HOOK and nothing else: a rebuilt macOS shell
  // owns the accelerator (an unclaimed one never reaches the webview) and evals
  // it, and off macOS `DesktopMenuHost`'s keydown calls the same global for
  // every command at once. Owning a second listener here is how the ⌘N path
  // drifted from the rest of the shell's keyboard in the first place.
  //
  // Browser tabs are left alone — ⌘N / Ctrl+N open a window there — which is
  // what the `nativeDesktopBridge()` gate says.
  const ref = useRef<() => void>(() => {})
  ref.current = () => startNewTask()
  useEffect(() => {
    if (!bindChord) return
    if (!nativeDesktopBridge()) return
    const handler = (): void => ref.current()
    return installDesktopCommandHook('new-agent', handler)
  }, [bindChord])

  return { startNewTask }
}

/** Whether the new-task chord is actually bound on this build. The hint is only
 *  rendered where the chord exists — a made-up shortcut on a button is worse
 *  than none, and in a browser tab the OS owns ⌘N. */
export function newTaskChordBound(): boolean {
  return nativeDesktopBridge() !== undefined
}
