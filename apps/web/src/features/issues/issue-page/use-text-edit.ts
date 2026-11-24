/**
 * ONE INLINE TEXT EDITOR OF THE ISSUE PAGE: the title or the description
 * (POD-6295, POD-7556).
 *
 * Opening the editor takes its base: the field's text and the task's revision
 * as the device holds them. The save names that revision, so a newer text
 * from another member, or from this reader on another device, is refused
 * instead of replaced. Then:
 *
 * - a real conflict reopens the editor on the reader's own text, with the
 *   other text beside it, cut from the current revision: saving again is a
 *   deliberate overwrite, Escape keeps theirs;
 * - any other failure reopens the editor on the reader's text, so nothing
 *   typed is lost;
 * - while a save is on its way, the field shows the saved text, until the
 *   device's row moves past the base (its own write, or a newer one, arrived).
 *
 * The editor's text and these states belong to this one field, so they stay
 * in the page as component state (frontend-data.md, "A single inline field
 * keeps its text in its component").
 */
import { useEffect, useRef, useState } from 'react'
import type { IssueWithBodies } from '@/app/store'
import type { IssuePageCommands } from '../issue-page-commands'
import { type IssueTextField, type TextBase, TextConflict } from '../issue-text-save'

export interface TextEdit {
  readonly editing: boolean
  /** Another writer's text beat this edit: what the field holds now. */
  readonly conflict: TextConflict | null
  /** The text the editor reopens on, after a conflict or a failed save. */
  readonly draft: string | undefined
  /** A save on its way: the text the field shows until the row catches up. */
  readonly pending: string | undefined
  /** Open the editor, or close it without saving (Escape: keep theirs). */
  setEditing(editing: boolean): void
  commit(value: string): void
}

export function useTextEdit(
  issue: IssueWithBodies,
  field: IssueTextField,
  commands: Pick<IssuePageCommands, 'commitText'>,
): TextEdit {
  const [editing, setEditingState] = useState(false)
  const [base, setBase] = useState<TextBase | null>(null)
  const [conflict, setConflict] = useState<TextConflict | null>(null)
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [pending, setPending] = useState<{ text: string; revision: number | undefined } | null>(
    null,
  )
  // A save answers after the page may have moved to another issue; its
  // answer belongs to the issue it was made on.
  const shownId = useRef(issue.id)
  shownId.current = issue.id

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on issue switch
  useEffect(() => {
    setEditingState(false)
    setBase(null)
    setConflict(null)
    setDraft(undefined)
    setPending(null)
  }, [issue.id])

  const shown =
    pending !== null && issue.revision === pending.revision && issue[field] !== pending.text
      ? pending.text
      : undefined

  const setEditing = (next: boolean): void => {
    // Reopened while the device still shows the text before my own save: the
    // base is my saved text, and the save's rebase finds the field holding it.
    if (next && conflict === null && draft === undefined)
      setBase(
        shown !== undefined && pending !== null
          ? { text: shown, revision: pending.revision }
          : { text: issue[field], revision: issue.revision },
      )
    if (!next) {
      setConflict(null)
      setDraft(undefined)
    }
    setEditingState(next)
  }

  const commit = (value: string): void => {
    const from = base ?? { text: issue[field], revision: issue.revision }
    const text = field === 'title' ? value.trim() : value
    const madeOn = issue.id
    setEditingState(false)
    setConflict(null)
    setDraft(undefined)
    if (text && text !== from.text) setPending({ text, revision: from.revision })
    commands.commitText(field, value, from, (outcome) => {
      if (shownId.current !== madeOn) return
      if (outcome === 'saved') return
      setPending(null)
      if (outcome === 'queued') return
      if (outcome instanceof TextConflict) {
        setBase({ text: outcome.currentText, revision: outcome.currentRevision ?? undefined })
        setConflict(outcome)
        setDraft(text)
      } else {
        setDraft(outcome.failed)
      }
      setEditingState(true)
    })
  }

  return {
    editing,
    conflict,
    draft,
    pending: shown,
    setEditing,
    commit,
  }
}
