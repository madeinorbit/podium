import { isImagePath, stagedAttachmentId } from '@podium/client-core/values'
import {
  type MessageRecordAttachment,
  machinePathBasename,
  resolveMachinePath,
} from '@podium/model'
import type { SessionId, TranscriptTag } from '@podium/model/browser'
import { FileText, Image as ImageIcon } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import type { JSX } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import { assetUrl } from '@/lib/asset-url'
import { type ChatGalleryImage, ChatImageGallery } from './ChatImageGallery'
import { chatUploadSrc } from './chat-upload-src'
import type { OpenChatImage } from './ImageLightbox'

export { stagedAttachmentId } from '@podium/client-core/values'

function TagChip({ kind, label }: { kind: string; label: string }): JSX.Element {
  return (
    <span className="chat-attachment-file">
      {kind === 'image' ? (
        <ImageIcon size={13} aria-hidden="true" />
      ) : (
        <FileText size={13} aria-hidden="true" />
      )}
      <span>{label}</span>
    </span>
  )
}

/** One gallery for all image sources in a message. Saved copies win over
 * staged paths, including after a history remount. Unresolved tags and files
 * keep their labels and file-opening behavior outside the image row. */
export const ItemAttachments = observer(function ItemAttachments({
  sessionId,
  attachments,
  tags,
  paths = [],
  cwd = '',
  httpOrigin,
  onOpenImage,
  openFile,
}: {
  sessionId: SessionId
  attachments: readonly Pick<MessageRecordAttachment, 'id' | 'filename' | 'kind'>[]
  tags: readonly TranscriptTag[]
  paths?: readonly string[]
  cwd?: string
  httpOrigin: string
  onOpenImage: OpenChatImage
  openFile?: (sessionId: SessionId, path: string) => void
}): JSX.Element | null {
  const pool = useWorklistPool()
  const images: ChatGalleryImage[] = []
  const chips: JSX.Element[] = []
  const pathIds = new Set<string>()
  for (const path of paths) {
    const absolute = resolveMachinePath(cwd, path)
    const id = stagedAttachmentId(absolute)
    if (id) pathIds.add(id)
    const name =
      attachments.find((a) => id && a.id === id)?.filename ?? machinePathBasename(path, cwd)
    const src = isImagePath(path)
      ? (chatUploadSrc(pool, sessionId, id, httpOrigin) ??
        assetUrl({ httpOrigin, sessionId, fileDir: cwd, src: absolute }))
      : null
    if (src) images.push({ kind: 'image', src, label: name, path: absolute })
    else
      chips.push(
        <button
          data-pressable
          key={`path:${path}`}
          type="button"
          className="chat-attachment-file"
          title={`Open ${path}`}
          onClick={(e) => {
            e.stopPropagation()
            openFile?.(sessionId, absolute)
          }}
        >
          <FileText size={13} aria-hidden="true" />
          <span>{name}</span>
        </button>,
      )
  }
  const remaining = { image: 0, file: 0 }
  for (const [attachmentIndex, attachment] of attachments.entries()) {
    remaining[attachment.kind]++
    if (attachment.id && pathIds.has(attachment.id)) continue
    const src =
      attachment.kind === 'image' ? chatUploadSrc(pool, sessionId, attachment.id, httpOrigin) : null
    if (src) images.push({ kind: 'image', src, label: attachment.filename })
    else
      chips.push(
        <TagChip
          key={`attachment:${attachment.id ?? ''}:${attachmentIndex}`}
          kind={attachment.kind}
          label={attachment.filename}
        />,
      )
  }
  // Providers may repeat saved attachments as anonymous tags. Consume those
  // occurrences once, but retain additional unresolved references.
  for (const [i, tag] of tags.entries()) {
    if (remaining[tag.kind] > 0) {
      remaining[tag.kind]--
      continue
    }
    chips.push(<TagChip key={`tag:${i}`} kind={tag.kind} label={tag.label ?? tag.kind} />)
  }
  if (!images.length && !chips.length) return null
  return (
    <div className="chat-message-attachments">
      {images.length > 0 && (
        <ChatImageGallery
          items={images}
          onOpenImage={onOpenImage}
          onOpenFile={openFile ? (path) => openFile(sessionId, path) : undefined}
        />
      )}
      {chips.length > 0 && <div className="chat-attachment-files">{chips}</div>}
    </div>
  )
})
