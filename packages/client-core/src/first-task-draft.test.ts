import { asIssueId, asMutationId, asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import {
  type ComposerAttachment,
  EMPTY_FIRST_TASK_DRAFT,
  persistFirstTaskDraft,
  readFirstTaskDraft,
  serializeFirstTaskDraft,
  updateFirstTaskDraftAttachments,
  withoutCreateReservation,
} from './first-task-draft'
import { memoryStorage } from './replica/contract'
import { createSideCache } from './replica/kernel/side-cache'
import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from './ui-state'

const image: ComposerAttachment = {
  id: 'chip-image',
  name: 'shot.png',
  size: 12,
  previewUri: 'data:image/png;base64,aGVsbG8=',
  ref: { id: 'held-image', filename: 'shot.png', mediaType: 'image/png', kind: 'image' },
  state: 'ready',
}

describe('first-task attachment recovery', () => {
  it('marks orphan uploads as removable failures on cold hydration and retains ready refs', () => {
    const storage = memoryStorage()
    const uploading: ComposerAttachment = {
      id: 'interrupted-chip',
      name: 'unfinished.pdf',
      previewUri: '',
      state: 'uploading',
    }
    const before = createSideCache({ storage, enumerateKeys: () => [] })
    persistFirstTaskDraft(before.uiState(), {
      ...EMPTY_FIRST_TASK_DRAFT,
      title: 'Keep this prompt and the completed image',
      attachments: [uploading, image],
    })
    // Ordinary reads during a live upload must keep waiting for its promise.
    expect(
      readFirstTaskDraft(before.uiState().get(FIRST_TASK_ACTIVATION_DRAFT_KEY)).attachments,
    ).toEqual([uploading, image])
    before.dispose()

    const reopened = createSideCache({ storage, enumerateKeys: () => [] })
    try {
      const ui = reopened.uiState()
      const recovered = readFirstTaskDraft(ui.get(FIRST_TASK_ACTIVATION_DRAFT_KEY))
      expect(recovered).toMatchObject({
        title: 'Keep this prompt and the completed image',
        attachments: [
          {
            ...uploading,
            state: 'failed',
            error: 'Upload interrupted. Remove and attach the file again.',
          },
          image,
        ],
      })
      updateFirstTaskDraftAttachments(ui, (current) =>
        current.filter((chip) => chip.id !== uploading.id),
      )
      expect(readFirstTaskDraft(ui.get(FIRST_TASK_ACTIVATION_DRAFT_KEY))).toEqual({
        ...recovered,
        attachments: [image],
      })
    } finally {
      reopened.dispose()
    }
  })

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

  it('keeps a large pasted image attached without writing its multi-megabyte preview', () => {
    const draft = {
      ...EMPTY_FIRST_TASK_DRAFT,
      title: 'Review the large screenshot',
      attachments: [
        { ...image, previewUri: `data:image/png;base64,${'a'.repeat(3 * 1024 * 1024)}` },
      ],
    }
    const raw = serializeFirstTaskDraft(draft)
    expect(raw.length).toBeLessThan(1024)
    const expected = {
      title: draft.title,
      attachments: [{ ...image, previewUri: '' }],
    }
    expect(readFirstTaskDraft(raw)).toMatchObject(expected)
    // Installed drafts written before the cap get the same fallback on read.
    expect(readFirstTaskDraft(JSON.stringify(draft))).toMatchObject(expected)
  })

  it('bounds the total inline previews while retaining every attached ref', () => {
    const previewUri = `data:image/png;base64,${'a'.repeat(150 * 1024)}`
    const attachments = ['one', 'two', 'three'].map((id) => ({ ...image, id, previewUri }))
    const raw = serializeFirstTaskDraft({ ...EMPTY_FIRST_TASK_DRAFT, attachments })
    expect(raw.length).toBeLessThan(201 * 1024)
    expect(readFirstTaskDraft(raw).attachments).toEqual([
      attachments[0],
      { ...attachments[1], previewUri: '' },
      { ...attachments[2], previewUri: '' },
    ])
  })

  it('keeps the prompt and uploaded ref available when device storage refuses a write', () => {
    const storage = {
      getItem: () => null,
      setItem: vi.fn(() => {
        throw new DOMException('Storage is full', 'QuotaExceededError')
      }),
      removeItem: () => {},
    }
    const side = createSideCache({ storage, enumerateKeys: () => [] })
    const ui = side.uiState()
    const changed = vi.fn()
    const stop = ui.subscribe(changed)
    try {
      persistFirstTaskDraft(ui, { ...EMPTY_FIRST_TASK_DRAFT, title: 'Keep my exact prompt' })
      expect(() => updateFirstTaskDraftAttachments(ui, () => [image])).not.toThrow()
      expect(storage.setItem).toHaveBeenCalled()
      expect(changed).toHaveBeenCalledWith(new Set([FIRST_TASK_ACTIVATION_DRAFT_KEY]))
      expect(readFirstTaskDraft(ui.get(FIRST_TASK_ACTIVATION_DRAFT_KEY))).toMatchObject({
        title: 'Keep my exact prompt',
        attachments: [image],
      })
    } finally {
      stop()
      side.dispose()
    }
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
    expect(readFirstTaskDraft(raw).attachments[0]?.state).toBe('uploading')
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
