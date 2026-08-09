import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import type { Attachment } from './use-attachments'

function fileSize(bytes: number | undefined): string | null {
  if (bytes === undefined) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * THE ATTACHMENT STRIP (POD-405) — one chip per image on its way into the
 * prompt, showing where it is: uploading, ready, or failed.
 *
 * Purely a rendering of {@link Attachment}. The upload state machine lives in
 * `use-attachments.ts`, which is also where paste, drop and the file picker all
 * converge, so the three entry points can never disagree about what an
 * attachment is.
 */
export function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: readonly Attachment[]
  onRemove: (id: string) => void
}): JSX.Element | null {
  if (attachments.length === 0) return null
  return (
    <div className="attachment-strip" data-testid="attachment-strip">
      {attachments.map((att) => (
        <div
          key={att.id}
          className={cn('attachment-chip', att.state === 'failed' && 'attachment-chip--failed')}
        >
          {att.previewUrl && att.state !== 'failed' && (
            <img src={att.previewUrl} alt={att.name} className="size-5 rounded object-cover" />
          )}
          <span className="attachment-chip-name">{att.name}</span>
          {fileSize(att.size) && (
            <span className="attachment-chip-size">· {fileSize(att.size)}</span>
          )}
          {att.state === 'uploading' && <span className="attachment-chip-state">Uploading</span>}
          {att.state === 'failed' && <span className="text-destructive">!</span>}
          <button
            data-pressable
            type="button"
            className="attachment-chip-remove"
            onClick={() => onRemove(att.id)}
            aria-label={`Remove ${att.name}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
