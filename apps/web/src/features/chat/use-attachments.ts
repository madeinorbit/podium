import type { MachineId, SessionId } from '@podium/model/browser'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Store } from '@/app/store'
import { hasFileItems } from './transfer-items'

/**
 * FILE PASTE, DROP AND ATTACH (POD-405, extracted from ChatView).
 *
 * One part owning the whole path a file takes into a prompt: picked from the
 * file dialog, dropped on the composer or pasted from the clipboard, read as
 * base64, uploaded to the session's workspace, and finally turned into the path
 * prefix the agent receives. The composer renders the strip; this owns the state
 * machine behind each chip (`uploading` → `ready` | `failed`).
 *
 * IMAGES WERE NEVER THE POINT, only the first case (POD-1203). Everything below
 * the mime check was already format-blind — the harness reads an attachment by
 * absolute path, and a path to a PDF is as readable as a path to a screenshot —
 * so the filter that kept documents out was the one thing standing between the
 * composer and "attach a spec, then ask about it". It is gone; a chip carries a
 * thumbnail when the browser can preview it and a name when it cannot.
 *
 * The upload mutation carries `{ sessionId, filename, mimeType, dataBase64 }` —
 * no actor, no owner, no origin. The uploaded file inherits its session's owner
 * and grants like every other child of a session (doc §3.1.2, inheritance on
 * create); the client does not get to say whose it is. `machineId` rides along
 * only for the home composer, whose session does not exist yet; see the command
 * contract for why a known session ignores it.
 */

export interface Attachment {
  id: string
  name: string
  size?: number
  /** An object URL when the browser can render this file inline, otherwise ''
   *  — a document chip shows its name and nothing else. */
  previewUrl: string
  path?: string
  state: 'uploading' | 'ready' | 'failed'
  /** The picked bytes, kept so the upload can be REDONE against a different
   *  machine (POD-1203). The home composer's target is a dropdown the operator
   *  can still change after attaching, and an uploaded path is only valid on the
   *  disk it was written to — without the file in hand the only honest response
   *  to that change would be to throw their attachment away. Absent on chips
   *  restored from anywhere but a live pick. */
  file?: File
}

export interface UseAttachmentsResult {
  attachments: Attachment[]
  /** True while a drag carrying files is over the composer. */
  dragOver: boolean
  /** The hidden <input type=file> the attach button clicks. */
  fileInputRef: React.RefObject<HTMLInputElement | null>
  openFilePicker: () => void
  processFiles: (files: File[]) => Promise<void>
  remove: (id: string) => void
  clear: () => void
  /** True while any chip is still uploading — the send button waits for it. */
  uploading: boolean
  /** The uploaded paths ready to ride into the prompt, with their chip labels. */
  ready: () => { paths: string[]; tags: { kind: 'image' | 'file'; label: string }[] }
  /** DOM handlers for the composer box. Grouped so the shell spreads them
   *  rather than re-deriving four closures. */
  dropHandlers: {
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
  onPaste: (e: React.ClipboardEvent) => void
  onFileInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}

export function useAttachments(opts: {
  sessionId: SessionId
  trpc: Store['trpc']
  /** Where the bytes go when `sessionId` names no live session yet — the home
   *  composer's case. Omitted by the session chat composer, whose session
   *  decides for itself. */
  machineId?: MachineId
}): UseAttachmentsResult {
  const { sessionId, trpc, machineId } = opts
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  /** One chip's trip to disk. `target` is passed rather than closed over so a
   *  re-upload can name the machine it was scheduled for, never a newer one. */
  const upload = useCallback(
    async (id: string, file: File, target: MachineId | undefined) => {
      try {
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const result = reader.result as string
            resolve(result.split(',')[1] ?? result)
          }
          reader.onerror = () => reject(new Error('FileReader error'))
          reader.readAsDataURL(file)
        })
        const res = await trpc.sessions.uploadImage.mutate({
          sessionId,
          filename: file.name,
          mimeType: file.type,
          dataBase64,
          ...(target ? { machineId: target } : {}),
        })
        setAttachments((prev) =>
          prev.map((a) => (a.id === id ? { ...a, path: res.path, state: 'ready' } : a)),
        )
      } catch {
        setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, state: 'failed' } : a)))
      }
    },
    [sessionId, trpc],
  )

  const processFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      const newAttachments: Attachment[] = files.map((f) => ({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: f.name,
        size: f.size,
        previewUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : '',
        state: 'uploading' as const,
        file: f,
      }))
      setAttachments((prev) => [...prev, ...newAttachments])
      await Promise.all(newAttachments.map((att) => upload(att.id, att.file as File, machineId)))
    },
    [machineId, upload],
  )

  /**
   * THE TARGET MOVED, SO THE BYTES MOVE WITH IT (POD-1203).
   *
   * An uploaded path is an absolute path on ONE machine. The home composer sits
   * next to a machine dropdown, so "attach a screenshot, then notice the wrong
   * machine is selected and fix it" is an ordinary thing to do — and it used to
   * leave a chip reading `ready` over a path that does not exist where the
   * session is about to run. Re-uploading is the only outcome that keeps both
   * halves of what the operator asked for; dropping the chip would silently undo
   * the attachment, and leaving it would hand the agent a dead path.
   *
   * Inert for the session chat composer, which passes no machine at all.
   */
  const latest = useRef(attachments)
  latest.current = attachments
  const lastTarget = useRef(machineId)
  useEffect(() => {
    if (lastTarget.current === machineId) return
    lastTarget.current = machineId
    const again = latest.current.filter((a) => a.file)
    if (again.length === 0) return
    setAttachments((prev) =>
      prev.map((a) => (a.file ? { ...a, state: 'uploading' as const, path: undefined } : a)),
    )
    for (const a of again) void upload(a.id, a.file as File, machineId)
  }, [machineId, upload])

  const ready = useCallback(() => {
    const readyOnes = attachments.filter((a) => a.state === 'ready' && a.path)
    return {
      paths: readyOnes.map((a) => a.path as string),
      // The tag kind is what the transcript renders the chip as, and `previewUrl`
      // is already the answer to "can this be shown as a picture?" — reuse it
      // rather than testing the mime a second time and getting a different answer.
      tags: readyOnes.map((a) => ({
        kind: a.previewUrl ? ('image' as const) : ('file' as const),
        label: a.name,
      })),
    }
  }, [attachments])

  return {
    attachments,
    dragOver,
    fileInputRef,
    openFilePicker: useCallback(() => fileInputRef.current?.click(), []),
    processFiles,
    remove: useCallback(
      (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id)),
      [],
    ),
    clear: useCallback(() => setAttachments([]), []),
    uploading: attachments.some((a) => a.state === 'uploading'),
    ready,
    dropHandlers: {
      onDragOver: useCallback((e: React.DragEvent) => {
        e.preventDefault()
        if (e.dataTransfer.items && hasFileItems(e.dataTransfer.items)) setDragOver(true)
      }, []),
      onDragLeave: useCallback((e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false)
      }, []),
      onDrop: useCallback(
        (e: React.DragEvent) => {
          e.preventDefault()
          setDragOver(false)
          void processFiles(Array.from(e.dataTransfer.files))
        },
        [processFiles],
      ),
    },
    onPaste: useCallback(
      (e: React.ClipboardEvent) => {
        const { items } = e.clipboardData
        // A PASTE OF PROSE MUST STILL BE A PASTE OF PROSE. `kind === 'file'` is
        // the line: copied text arrives as `'string'` items and falls straight
        // through to the textarea untouched, so widening past images did not
        // widen what this swallows.
        if (!hasFileItems(items)) return
        e.preventDefault()
        const files: File[] = []
        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          if (item?.kind === 'file') {
            const f = item.getAsFile()
            if (f) files.push(f)
          }
        }
        void processFiles(files)
      },
      [processFiles],
    ),
    onFileInputChange: useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) void processFiles(Array.from(e.target.files))
        e.target.value = ''
      },
      [processFiles],
    ),
  }
}
