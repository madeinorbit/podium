import type { SessionId } from '@podium/model'
import { useCallback, useRef, useState } from 'react'
import type { Store } from '@/app/store'
import { hasImageItems } from './image-items'

/**
 * IMAGE PASTE, DROP AND ATTACH (POD-405, extracted from ChatView).
 *
 * One part owning the whole path an image takes into a prompt: picked from the
 * file dialog, dropped on the composer or pasted from the clipboard, read as
 * base64, uploaded to the session's workspace, and finally turned into the path
 * prefix the agent receives. The composer renders the strip; this owns the state
 * machine behind each chip (`uploading` → `ready` | `failed`).
 *
 * The upload mutation carries `{ sessionId, filename, mimeType, dataBase64 }` —
 * no actor, no owner, no origin. The uploaded file inherits its session's owner
 * and grants like every other child of a session (doc §3.1.2, inheritance on
 * create); the client does not get to say whose it is.
 */

export interface Attachment {
  id: string
  name: string
  previewUrl: string
  path?: string
  state: 'uploading' | 'ready' | 'failed'
}

export interface UseAttachmentsResult {
  attachments: Attachment[]
  /** True while a drag carrying images is over the composer. */
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
  ready: () => { paths: string[]; tags: { kind: 'image'; label: string }[] }
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
}): UseAttachmentsResult {
  const { sessionId, trpc } = opts
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const processFiles = useCallback(
    async (files: File[]) => {
      const imageFiles = files.filter((f) => f.type.startsWith('image/'))
      if (imageFiles.length === 0) return
      const newAttachments: Attachment[] = imageFiles.map((f) => ({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: f.name,
        previewUrl: URL.createObjectURL(f),
        state: 'uploading' as const,
      }))
      setAttachments((prev) => [...prev, ...newAttachments])
      await Promise.all(
        imageFiles.map(async (file, i) => {
          // newAttachments is built from imageFiles with the same length, so index is always valid
          const att = newAttachments[i] as Attachment
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
            })
            setAttachments((prev) =>
              prev.map((a) => (a.id === att.id ? { ...a, path: res.path, state: 'ready' } : a)),
            )
          } catch {
            setAttachments((prev) =>
              prev.map((a) => (a.id === att.id ? { ...a, state: 'failed' } : a)),
            )
          }
        }),
      )
    },
    [sessionId, trpc],
  )

  const ready = useCallback(() => {
    const readyOnes = attachments.filter((a) => a.state === 'ready' && a.path)
    return {
      paths: readyOnes.map((a) => a.path as string),
      tags: readyOnes.map((a) => ({ kind: 'image' as const, label: a.name })),
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
        if (e.dataTransfer.items && hasImageItems(e.dataTransfer.items)) setDragOver(true)
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
        if (!hasImageItems(items)) return
        e.preventDefault()
        const files: File[] = []
        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          if (item?.type.startsWith('image/')) {
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
