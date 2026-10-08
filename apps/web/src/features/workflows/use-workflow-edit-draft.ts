import { WorkflowStep } from '@podium/protocol'
import { useState } from 'react'

export interface WorkflowEditText {
  instructions: string
  steps: string
}

interface WorkflowEditBase extends WorkflowEditText {
  revisionId: string
}

function sameText(head: WorkflowEditText, text: WorkflowEditText): boolean {
  if (head.instructions !== text.instructions) return false
  try {
    // The write schema supplies defaults for omitted step fields.
    return (
      head.steps === JSON.stringify(WorkflowStep.array().parse(JSON.parse(text.steps)), null, 2)
    )
  } catch {
    return false
  }
}

/** An immutable revision's edit draft. Its base stays still while text is dirty;
 * creating a revision is an explicit save, rather than an edit of that base. */
export function useWorkflowEditDraft(head: WorkflowEditBase) {
  const [draft, setDraft] = useState(() => ({
    base: head,
    instructions: head.instructions,
    steps: head.steps,
    saved: null as WorkflowEditText | null,
  }))
  const dirty = draft.instructions !== draft.base.instructions || draft.steps !== draft.base.steps

  // Adjust during render so a clean editor follows the head before its inputs
  // can receive another keystroke. A dirty editor keeps its base and both texts.
  if (head.revisionId !== draft.base.revisionId) {
    if (!dirty) {
      setDraft({ base: head, instructions: head.instructions, steps: head.steps, saved: null })
    } else if (draft.saved && sameText(head, draft.saved)) {
      // Acknowledgement may arrive before or after the refreshed head. Edits
      // typed during the save remain dirty against the revision just saved.
      setDraft({
        base: head,
        instructions:
          draft.instructions === draft.saved.instructions ? head.instructions : draft.instructions,
        steps: draft.steps === draft.saved.steps ? head.steps : draft.steps,
        saved: null,
      })
    }
  }

  return {
    instructions: draft.instructions,
    steps: draft.steps,
    hasNewVersion: head.revisionId !== draft.base.revisionId && dirty,
    setInstructions(instructions: string) {
      setDraft((current) => ({ ...current, instructions }))
    },
    setSteps(steps: string) {
      setDraft((current) => ({ ...current, steps }))
    },
    discard() {
      setDraft({ base: head, instructions: head.instructions, steps: head.steps, saved: null })
    },
    saved(text: WorkflowEditText) {
      setDraft((current) => ({
        ...current,
        saved:
          current.base.revisionId !== draft.base.revisionId && sameText(current.base, text)
            ? null
            : text,
      }))
    },
  }
}
