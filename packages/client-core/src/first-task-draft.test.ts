import { asIssueId, asMutationId, asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type ComposerAttachment,
  EMPTY_FIRST_TASK_DRAFT,
  readFirstTaskDraft,
  serializeFirstTaskDraft,
  updateFirstTaskDraftAttachments,
  withoutCreateReservation,
} from './first-task-draft'

const image: ComposerAttachment = {
  id: 'chip-image',
  name: 'shot.png',
  size: 12,
  previewUri: 'data:image/png;base64,aGVsbG8=',
  ref: { id: 'held-image', filename: 'shot.png', mediaType: 'image/png', kind: 'image' },
  state: 'ready',
}

describe('first-task attachment recovery', () => {
  it('round-trips the uploaded ref and image chip with the reserved launch', () => {
    const draft = {
      ...EMPTY_FIRST_TASK_DRAFT,
      title: 'Review this image',
      launchKind: 'draft' as const,
      createIssueId: asIssueId('iss_retry'),
      createSessionId: asSessionId('retry-session'),
      createMutationId: asMutationId('retry-mutation'),
      attachments: [image],
      launchError: "Couldn't start the agent.",
    }
    expect(readFirstTaskDraft(serializeFirstTaskDraft(draft))).toEqual(draft)
    expect(withoutCreateReservation(draft).attachments).toEqual([image])
  })

  it('keeps legacy draft paths and ignores malformed attachment chips', () => {
    expect(
      readFirstTaskDraft(JSON.stringify({ attachmentPaths: ['/legacy/shot.png'] })),
    ).toMatchObject({
      attachmentPaths: ['/legacy/shot.png'],
      attachments: [],
    })
    expect(
      readFirstTaskDraft(
        JSON.stringify({
          attachments: [
            null,
            {},
            { ...image, ref: { id: 'incomplete' } },
            { ...image, state: 'unknown' },
            image,
          ],
        }),
      ).attachments,
    ).toEqual([image])
  })

  it('applies an upload result to the current prompt and attachment edits release the old launch', () => {
    let raw = serializeFirstTaskDraft({
      ...EMPTY_FIRST_TASK_DRAFT,
      title: 'Edited while upload was running',
      launchKind: 'draft',
      createMutationId: asMutationId('old-launch'),
      attachments: [{ ...image, ref: undefined, state: 'uploading' }],
    })
    const ui = {
      get: () => raw,
      set: (_key: string, value: string | null) => {
        raw = value ?? ''
      },
    }
    updateFirstTaskDraftAttachments(ui, (current) =>
      current.map((chip) => ({ ...chip, ref: image.ref, state: 'ready' })),
    )
    expect(readFirstTaskDraft(raw)).toMatchObject({
      title: 'Edited while upload was running',
      attachments: [image],
      createMutationId: '',
    })
    updateFirstTaskDraftAttachments(ui, () => [])
    expect(readFirstTaskDraft(raw).attachments).toEqual([])
  })

  it('ignores a removed chip upload that settles after a newer launch has reserved its identities', () => {
    const raw = serializeFirstTaskDraft({
      ...EMPTY_FIRST_TASK_DRAFT,
      title: 'Start without the removed image',
      launchKind: 'draft',
      createMutationId: asMutationId('new-launch'),
    })
    let writes = 0
    updateFirstTaskDraftAttachments(
      {
        get: () => raw,
        set: () => {
          writes++
        },
      },
      (current) => current.map((chip) => (chip.id === image.id ? image : chip)),
    )
    expect(writes).toBe(0)
    expect(readFirstTaskDraft(raw).createMutationId).toBe('new-launch')
  })
})
