import type { SessionId } from '@podium/model'
import { useCallback, useRef, useState } from 'react'
import { useTrpc } from '../client/hooks'
import {
  canPasteMedia,
  canPickFiles,
  type PickedFile,
  pasteMedia,
  pickFiles,
} from '../lib/composer-media'

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
  /** The absolute path on the session's machine, once uploaded. */
  path?: string
  state: 'uploading' | 'ready' | 'failed'
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
  path: string
  /** A local data URI, or '' for a file with no preview. */
  previewUri: string
  name: string
}

let seq = 0

export function useComposerAttachments(sessionId: SessionId | undefined): ComposerAttachmentsApi {
  const trpc = useTrpc()
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  // The send reads paths at the instant of the press, and `ready()` must not be
  // a stale closure over the render that created the callback.
  const latest = useRef(attachments)
  latest.current = attachments

  const upload = useCallback(
    async (id: string, file: PickedFile) => {
      if (!sessionId) {
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, state: 'failed' } : a)))
        return
      }
      try {
        const result = await trpc.sessions.uploadImage.mutate({
          sessionId,
          filename: file.name,
          mimeType: file.mimeType,
          dataBase64: file.dataBase64,
        })
        // An empty path is a refusal wearing a success shape — the daemon
        // answers `{ path: '' }` when nothing answered in time.
        if (!result?.path) throw new Error(result?.error ?? 'upload refused')
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, path: result.path, state: 'ready' } : a)),
        )
      } catch {
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, state: 'failed' } : a)))
      }
    },
    [sessionId, trpc],
  )

  const accept = useCallback(
    (files: PickedFile[]) => {
      if (files.length === 0) return
      const added = files.map((file) => ({
        chip: {
          id: `att-${++seq}`,
          name: file.name,
          previewUri: file.previewUri,
          state: 'uploading' as const,
        },
        file,
      }))
      setAttachments((prev) => [...prev, ...added.map((entry) => entry.chip)])
      for (const entry of added) void upload(entry.chip.id, entry.file)
    },
    [upload],
  )

  const fromSource = useCallback(
    (source: () => Promise<PickedFile[]>) => {
      void source()
        .then(accept)
        .catch(() => {})
    },
    [accept],
  )

  return {
    attachments,
    uploading: attachments.some((a) => a.state === 'uploading'),
    ...(canPickFiles ? { pick: () => fromSource(pickFiles) } : {}),
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
          .filter((a) => a.state === 'ready' && a.path)
          .map((a) => ({ path: a.path as string, previewUri: a.previewUri, name: a.name })),
      [],
    ),
  }
}
