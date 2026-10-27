import type { SessionId } from '@podium/model'
import type { RuntimeAttachmentRef } from '@podium/protocol/daemon'
import { useCallback, useRef, useState } from 'react'
import { useTrpc } from '../client/hooks'
import {
  createAttachmentSessionResolver,
  uploadWithResolvedSession,
} from '../lib/attachment-session'
import {
  canPasteMedia,
  canPickFiles,
  type PickedFile,
  pasteMedia,
  pickFiles,
} from '../lib/composer-media'
import { pickedFileReady } from '../lib/composer-media-types'

/**
 * THE PROMPT'S ATTACHMENTS, on the phone.
 *
 * The composer could take words and nothing else: a screenshot of the thing you
 * are asking about — the single most useful thing to hand an agent from a phone,
 * where taking one is a two-button gesture — had no way in at all. This is the
 * state machine behind each chip (`uploading` → `ready` | `failed`), the phone
 * twin of `apps/web/src/features/chat/use-attachments.ts`.
 *
 * A CHIP IS NOT A MESSAGE. Bytes go up as soon as they arrive, so the upload has
 * usually finished by the time the prompt is written; `ready()` then hands the
 * send the absolute paths to prefix. Sending while an upload is still in flight
 * is refused rather than raced — a path that does not exist yet is worse than a
 * moment's wait.
 *
 * The upload payload carries no actor and no owner: an uploaded file inherits
 * its session's owner and grants like every other child of a session
 * (doc §3.1.2, inheritance on create).
 */

export interface ComposerAttachment {
  id: string
  name: string
  /** A local data URI while the bytes are in hand, or '' for a file with no
   *  preview — the chip then shows its name and a document glyph. */
  previewUri: string
  /** The absolute path on the session's machine, when the upload was put
   *  there at once (a shell, or the superagent's headless session). */
  path?: string
  /** The upload as the server holds it (POD-2148): an agent session's file
   *  waits on the server and reaches the agent's machine with the message. */
  ref?: RuntimeAttachmentRef
  state: 'uploading' | 'ready' | 'failed'
  /** A useful per-file refusal, kept until the operator removes the chip. */
  error?: string
}

export interface ComposerAttachmentsApi {
  attachments: ComposerAttachment[]
  /** True while any chip is still uploading — the send control waits for it. */
  uploading: boolean
  /** Present only where the platform has a route for it; the composer hides the
   *  control rather than offering one that does nothing. */
  pick?: () => void
  /** Native's explicit clipboard read, absent on the web (where the paste event
   *  covers the same gesture without a control). */
  paste?: () => void
  /** Wired by the composer to its own text node: a browser paste or drop. */
  accept: (files: PickedFile[]) => void
  remove: (id: string) => void
  clear: () => void
  /** The uploaded files ready to ride into the prompt, in the order attached. */
  ready: () => SentAttachment[]
}

/**
 * One attachment as the SEND sees it: the path the agent will read, and the
 * local preview the operator has already been looking at.
 *
 * The preview travels with the path deliberately. The optimistic bubble could
 * fetch the uploaded file back from the server to show a thumbnail, but that is
 * a round trip (and an auth hop) for bytes this device is already holding — and
 * until it lands the operator sees a grey chip with a UUID on it where their
 * photo should be.
 */
export interface SentAttachment {
  /** Set when the file is already on the agent's machine; its path then rides
   *  the prompt text. Absent for a held upload, which travels as `ref`. */
  path?: string
  ref?: RuntimeAttachmentRef
  /** A local data URI, or '' for a file with no preview. */
  previewUri: string
  name: string
}

let seq = 0

export function useComposerAttachments(
  sessionId: SessionId | undefined,
  options: {
    prepareSession?: () => Promise<SessionId>
    /** Testable platform seam; production uses the native/web picker module. */
    pickMedia?: () => Promise<PickedFile[]>
  } = {},
): ComposerAttachmentsApi {
  const trpc = useTrpc()
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  // The send reads paths at the instant of the press, and `ready()` must not be
  // a stale closure over the render that created the callback.
  const latest = useRef(attachments)
  latest.current = attachments
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  const prepareRef = useRef(options.prepareSession)
  prepareRef.current = options.prepareSession
  const pickMediaRef = useRef(options.pickMedia ?? pickFiles)
  pickMediaRef.current = options.pickMedia ?? pickFiles
  // Every picker result joins one composer-owned queue. Serializing within a
  // single selection is insufficient: a second Photos/Files choice can arrive
  // while the first upload still owns a full base64 payload.
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve())
  // Native pickers perform their filesystem/base64 read before `accept`. Keep
  // the whole pick → read → upload lifecycle serial too, otherwise two rapid
  // taps could build two full encoded batches before either reached the upload
  // queue above.
  const intakeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const resolverRef = useRef<(() => Promise<SessionId>) | null>(null)
  const resolverBindingRef = useRef<SessionId | undefined>(sessionId)
  if (!resolverRef.current || resolverBindingRef.current !== sessionId) {
    // A Superagent clear kills its old headless session. Binding identity is
    // therefore the resolver generation: promise/cache sharing is correct only
    // until the screen publishes a cleared or replacement binding.
    resolverBindingRef.current = sessionId
    resolverRef.current = createAttachmentSessionResolver(
      () => sessionRef.current,
      () => {
        const prepare = prepareRef.current
        if (!prepare)
          return Promise.reject(new Error('No session is available for this attachment.'))
        return prepare()
      },
    )
  }

  const upload = useCallback(
    async (id: string, file: PickedFile & { dataBase64: string }, targetSessionId: SessionId) => {
      try {
        const result = await trpc.sessions.uploadImage.mutate({
          sessionId: targetSessionId,
          filename: file.name,
          mimeType: file.mimeType,
          dataBase64: file.dataBase64,
        })
        if (!result || !('path' in result)) throw new Error('upload refused')
        // A held upload answers its ref with no path (POD-2148). Otherwise an
        // empty path is a refusal wearing a success shape — the daemon answers
        // `{ path: '' }` when nothing answered in time.
        const ref = 'attachment' in result ? result.attachment : undefined
        if (!result.path && !ref) {
          throw new Error(('error' in result ? result.error : undefined) ?? 'upload refused')
        }
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === id ? { ...a, path: result.path || undefined, ref, state: 'ready' } : a,
          ),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, state: 'failed', error: message } : a)),
        )
      }
    },
    [trpc],
  )

  const accept = useCallback(
    (files: PickedFile[]) => {
      if (files.length === 0) return
      const added = files.map((file) => ({
        chip: {
          id: `att-${++seq}`,
          name: file.name,
          previewUri: file.previewUri,
          state: pickedFileReady(file) ? ('uploading' as const) : ('failed' as const),
          ...(file.error ? { error: file.error } : {}),
        },
        file,
      }))
      setAttachments((prev) => [...prev, ...added.map((entry) => entry.chip)])
      const ready = added.flatMap((entry) =>
        pickedFileReady(entry.file) ? [{ chip: entry.chip, file: entry.file }] : [],
      )
      if (ready.length === 0) return
      const resolveSession = resolverRef.current as () => Promise<SessionId>
      uploadQueueRef.current = uploadQueueRef.current
        .then(() =>
          uploadWithResolvedSession(ready, resolveSession, (entry, targetSessionId) =>
            upload(entry.chip.id, entry.file, targetSessionId),
          ),
        )
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          const ids = new Set(ready.map((entry) => entry.chip.id))
          setAttachments((prev) =>
            prev.map((attachment) =>
              ids.has(attachment.id)
                ? { ...attachment, state: 'failed', error: message }
                : attachment,
            ),
          )
        })
    },
    [upload],
  )

  const fromSource = useCallback(
    (source: () => Promise<PickedFile[]>) => {
      intakeQueueRef.current = intakeQueueRef.current.then(async () => {
        try {
          accept(await source())
        } catch (error) {
          accept([
            {
              name: 'Attachment',
              mimeType: 'application/octet-stream',
              previewUri: '',
              error: error instanceof Error ? error.message : String(error),
            },
          ])
        }
        // `accept` updates the ref synchronously. Waiting here keeps the next
        // picker read behind this batch's upload and its retained base64 bytes.
        await uploadQueueRef.current
      })
    },
    [accept],
  )

  return {
    attachments,
    uploading: attachments.some((a) => a.state === 'uploading'),
    ...(canPickFiles ? { pick: () => fromSource(pickMediaRef.current) } : {}),
    ...(canPasteMedia ? { paste: () => fromSource(pasteMedia) } : {}),
    accept,
    remove: useCallback(
      (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id)),
      [],
    ),
    clear: useCallback(() => setAttachments([]), []),
    ready: useCallback(
      () =>
        latest.current
          .filter((a) => a.state === 'ready' && (a.path || a.ref))
          .map((a) => ({
            ...(a.path ? { path: a.path } : {}),
            ...(a.ref ? { ref: a.ref } : {}),
            previewUri: a.previewUri,
            name: a.name,
          })),
      [],
    ),
  }
}
