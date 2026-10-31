import type { MessageRecordAttachment } from '@podium/model'
import type { SessionId, TranscriptTag } from '@podium/model/browser'
import { FileText, Image as ImageIcon } from 'lucide-react'
import type { JSX } from 'react'
import { SentImageThumb } from './SendUserFileBlock'
import { useChatUploadSrc } from './use-chat-context'

// Shared with the phone app (POD-2148).
export { stagedAttachmentId } from '@podium/client-core/values'

/** A chat message's attached image. The issue's stored copy wins (POD-2148):
 *  the daemon's staged file is swept after 24h, the copy is not. Without a copy
 *  (no issue, copy not landed or failed) it shows `fallbackUrl` as before. */
export function ChatUploadThumb({
  sessionId,
  attachmentId,
  fallbackUrl,
  name,
  httpOrigin,
  onOpenImage,
  fallback,
}: {
  sessionId: SessionId
  attachmentId: string | undefined
  /** Where the image is read when the issue holds no copy (the daemon file). */
  fallbackUrl: string | null
  name: string
  httpOrigin: string
  onOpenImage: (src: string) => void
  fallback: JSX.Element
}): JSX.Element {
  const stored = useChatUploadSrc(sessionId, attachmentId, httpOrigin)
  const url = stored ?? fallbackUrl
  if (!url) return fallback
  return (
    // Keyed by the URL: a copy landing after a failed daemon load gets a fresh
    // thumbnail rather than the failed one's fallback.
    <SentImageThumb
      key={url}
      url={url}
      name={name}
      onOpen={() => onOpenImage(url)}
      fallback={fallback}
    />
  )
}

function TagChip({ kind, label }: { kind: string; label: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-input px-[7px] py-0.5 text-[11px] text-muted-foreground">
      {kind === 'image' ? (
        <ImageIcon size={12} aria-hidden="true" />
      ) : (
        <FileText size={12} aria-hidden="true" />
      )}
      {label}
    </span>
  )
}

/** Saved message attachments render even when the provider records only text.
 * Unresolved provider tags retain their labelled chips. */
export function ItemAttachments({
  sessionId,
  attachments,
  tags,
  httpOrigin,
  onOpenImage,
}: {
  sessionId: SessionId
  attachments: readonly MessageRecordAttachment[]
  tags: readonly TranscriptTag[]
  httpOrigin: string
  onOpenImage: (src: string) => void
}): JSX.Element {
  const images = attachments.filter((a) => a.kind === 'image' && a.id)
  const remaining = { image: 0, file: 0 }
  for (const attachment of attachments) remaining[attachment.kind]++
  const rest = tags.filter((tag) => {
    if (remaining[tag.kind] === 0) return true
    remaining[tag.kind]--
    return false
  })
  return (
    <>
      {images.map((a) => (
        <ChatUploadThumb
          key={a.id}
          sessionId={sessionId}
          attachmentId={a.id}
          fallbackUrl={null}
          name={a.filename}
          httpOrigin={httpOrigin}
          onOpenImage={onOpenImage}
          fallback={<TagChip kind="image" label={a.filename} />}
        />
      ))}
      {attachments
        .filter((a) => a.kind !== 'image' || !a.id)
        .map((a, i) => (
          <TagChip key={a.id ?? `${a.filename}-${i}`} kind={a.kind} label={a.filename} />
        ))}
      {rest.map((tag, i) => (
        <TagChip key={`${tag.kind}-${i}`} kind={tag.kind} label={tag.label ?? tag.kind} />
      ))}
    </>
  )
}
