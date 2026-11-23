/**
 * SAVING A DESCRIPTION OR BRIEF ON A SHARED TASK (POD-6295; design §2.2).
 *
 * Every member edits a task's text, so an edit names the revision its draft
 * was cut from (`expectedRevision`), and a task that moved on since refuses
 * it (CONFLICT) instead of losing the other member's words.
 *
 * The revision is the whole task's, so it also moves when somebody changes a
 * label or the stage, or when this reader's own earlier edit lands. Those do
 * not touch the text, so on a conflict the current task is read once: if the
 * field still holds the text the draft started from, the edit is sent again on
 * top of the current revision. Only a real text conflict reaches the reader,
 * as a {@link TextConflict} carrying the current revision and text; the draft
 * stays theirs to keep or drop.
 */

export type IssueTextField = 'description' | 'brief'

/** What the editor opened on: the field's text and the task's revision. */
export interface TextBase {
  readonly text: string
  readonly revision: number | undefined
}

/** The two calls a save needs, as the web client's tRPC proxy has them. */
export interface TextSaveApi {
  issues: {
    update: {
      mutate(input: {
        id: string
        patch: Partial<Record<IssueTextField, string>>
        expectedRevision?: number
      }): Promise<unknown>
    }
    get: {
      query(input: { id: string }): Promise<unknown>
    }
  }
}

/** Another member changed the text since the draft was cut. */
export class TextConflict extends Error {
  constructor(
    readonly field: IssueTextField,
    readonly currentRevision: number | null,
    readonly currentText: string,
  ) {
    super(
      `Someone else changed the ${field} while you were editing` +
        (currentRevision !== null ? ` (the task is now at revision ${currentRevision})` : '') +
        '. Your text was not saved.',
    )
    this.name = 'TextConflict'
  }
}

/** The server's stale-revision refusal. */
export function isRevisionConflict(err: unknown): boolean {
  const data = (err as { data?: { code?: string; httpStatus?: number } } | null)?.data
  return data?.code === 'CONFLICT' || data?.httpStatus === 409
}

export async function saveIssueText(
  api: TextSaveApi,
  id: string,
  field: IssueTextField,
  value: string,
  base: TextBase,
): Promise<void> {
  const send = (expectedRevision: number | undefined) =>
    api.issues.update.mutate({
      id,
      patch: { [field]: value },
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    })
  try {
    await send(base.revision)
    return
  } catch (err) {
    if (!isRevisionConflict(err)) throw err
  }
  const current = (await api.issues.get.query({ id })) as {
    revision?: number
    description?: string
    brief?: string
  } | null
  const text = current?.[field] ?? ''
  if (text === base.text) {
    await send(current?.revision)
    return
  }
  throw new TextConflict(field, current?.revision ?? null, text)
}
