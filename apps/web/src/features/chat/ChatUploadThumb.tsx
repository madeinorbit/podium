import type { SessionId, TranscriptTag } from '@podium/model/browser'
import { FileText, Image as ImageIcon } from 'lucide-react'
import type { JSX } from 'react'
import { SentImageThumb } from './SendUserFileBlock'
import { useChatItemAttachments, useChatUploadSrc } from './use-chat-context'

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

/** A user entry's attachment tags when the entry names no file paths. Claude
 *  Code can record an image turn without its source path (a prompt queued
 *  while it was busy, a bare `[Image #N]`), so the images are resolved from the
 *  chat message the server matched to this entry, by attachment id (POD-2148).
 *  Without a match, or for a tag with no attachment behind it, the labelled
 *  chip it always was. */
export function ItemAttachmentTags({
  sessionId,
  itemId,
  tags,
  httpOrigin,
  onOpenImage,
}: {
  sessionId: SessionId
  itemId: string
  tags: readonly TranscriptTag[]
  httpOrigin: string
  onOpenImage: (src: string) => void
}): JSX.Element {
  const attachments = useChatItemAttachments(sessionId, itemId)
  const images = attachments.filter((a) => a.kind === 'image' && a.id)
  const imageTags = tags.filter((tag) => tag.kind === 'image')
  // The record's images stand for the entry's image tags; any other tag, and
  // any image tag past the record's count, keeps its chip.
  const rest = [...imageTags.slice(images.length), ...tags.filter((tag) => tag.kind !== 'image')]
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
      {rest.map((tag, i) => (
        <TagChip key={`${tag.kind}-${i}`} kind={tag.kind} label={tag.label ?? tag.kind} />
      ))}
    </>
  )
}
