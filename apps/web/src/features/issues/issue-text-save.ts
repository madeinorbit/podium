/**
 * SAVING AN ISSUE'S TITLE OR DESCRIPTION (POD-6295, POD-7556; design §2.2).
 *
 * Every member edits a task's text, and one person edits it from several
 * devices, so an edit names the revision its draft was cut from
 * (`expectedRevision`), and a task that moved on since refuses it (CONFLICT)
 * instead of losing the other writer's words. The revision rides the device's
 * issue row; a client that sends none (an older one) still replaces the text.
 *
 * The revision is the whole task's, so it also moves when somebody changes a
 * label or the stage, or when this reader's own earlier edit lands. Those do
 * not touch the text, so on a conflict the current task is read once: if the
 * field still holds the text the draft started from, the edit is sent again on
 * top of the current revision. Only a real text conflict reaches the reader,
 * as a {@link TextConflict} carrying the current revision and text; the draft
 * stays theirs to keep or drop.
 *
 * When the server cannot be reached, the edit is queued instead (the outbox
 * paints it and sends it later), naming the revision the device holds now,
 * when the device's text is still what the draft started from. When the
 * device already holds another writer's text, that is the conflict, told at
 * once. A later refusal parks the queued edit, the author's text with it, in
 * the outbox's recovery.
 */

export type IssueTextField = 'title' | 'description'

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

/** The queued edit and the device's own copy, for a save the server did not answer. */
export interface TextSaveFallback {
  /** The field's text and the task's revision as the device holds them now. */
  now(): TextBase
  /** Queue the edit through the outbox, held to `expectedRevision`. */
  queue(
    patch: Partial<Record<IssueTextField, string>>,
    expectedRevision: number | undefined,
  ): Promise<unknown>
}

/** How a save ended when it did not throw. */
export type TextSaveOutcome = 'saved' | 'queued'

/** Another writer changed the text since the draft was cut. */
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

/** The server answered the call (with any error); otherwise it was never reached. */
function serverAnswered(err: unknown): boolean {
  const data = (err as { data?: { code?: unknown; httpStatus?: unknown } } | null)?.data
  return typeof data?.code === 'string' || typeof data?.httpStatus === 'number'
}

/** How many times an edit is sent on top of a revision only other fields moved. */
const REBASES = 3

export async function saveIssueText(
  api: TextSaveApi,
  id: string,
  field: IssueTextField,
  value: string,
  base: TextBase,
  fallback?: TextSaveFallback,
): Promise<TextSaveOutcome> {
  const send = (expectedRevision: number | undefined) =>
    api.issues.update.mutate({
      id,
      patch: { [field]: value },
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    })
  let against = base.revision
  for (let attempt = 0; ; attempt++) {
    try {
      await send(against)
      return 'saved'
    } catch (err) {
      if (!isRevisionConflict(err)) {
        if (fallback === undefined || serverAnswered(err)) throw err
        return await queued(field, value, base, fallback)
      }
    }
    const current = (await api.issues.get.query({ id })) as {
      revision?: number
      title?: string
      description?: string
    } | null
    const text = current?.[field] ?? ''
    if (text !== base.text || attempt + 1 >= REBASES) {
      throw new TextConflict(field, current?.revision ?? null, text)
    }
    against = current?.revision
  }
}

/** The save the server did not answer, queued against what the device holds. */
async function queued(
  field: IssueTextField,
  value: string,
  base: TextBase,
  fallback: TextSaveFallback,
): Promise<TextSaveOutcome> {
  const now = fallback.now()
  // The device already shows this text: the call landed and only its answer
  // was lost.
  if (now.text === value && now.revision !== base.revision) return 'saved'
  // The device already holds another writer's text: a conflict, told now.
  if (now.text !== base.text) throw new TextConflict(field, now.revision ?? null, now.text)
  await fallback.queue({ [field]: value }, now.revision)
  return 'queued'
}

/**
 * The revision a QUEUED edit of one field names (POD-7556): the device's
 * current one when the field still holds the text the edit was opened on
 * (only other fields moved since), else the one it was opened on, which the
 * server then refuses and the outbox keeps, with the author's text, for
 * recovery. Nothing opened (no snapshot): the device's current one.
 */
export function queuedRevision(opened: TextBase | undefined, now: TextBase): number | undefined {
  if (opened === undefined || now.text === opened.text) return now.revision
  return opened.revision
}

/** A queued rename's options: {@link queuedRevision} over the issue row the
 *  device holds now (`undefined` while it is not here). */
export function queuedTitleEdit(
  opened: TextBase | undefined,
  row: { readonly title?: unknown; readonly revision?: unknown } | undefined,
): { expectedRevision?: number } {
  const now =
    row === undefined
      ? undefined
      : {
          text: typeof row.title === 'string' ? row.title : '',
          revision: typeof row.revision === 'number' ? row.revision : undefined,
        }
  const revision = now === undefined ? opened?.revision : queuedRevision(opened, now)
  return revision === undefined ? {} : { expectedRevision: revision }
}
