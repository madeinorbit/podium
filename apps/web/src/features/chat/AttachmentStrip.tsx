import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import type { Attachment } from './use-attachments'

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
    <div className="flex flex-wrap gap-1.5 px-0.5 pt-1">
      {attachments.map((att) => (
        <div
          key={att.id}
          className={cn(
            'relative flex items-center gap-1 rounded-lg border border-input bg-muted/50 px-2 py-1 text-[11px]',
            att.state === 'failed' && 'border-destructive/50 text-destructive',
          )}
        >
          {att.previewUrl && att.state !== 'failed' && (
            <img src={att.previewUrl} alt={att.name} className="size-5 rounded object-cover" />
          )}
          <span className="max-w-[80px] truncate text-muted-foreground">{att.name}</span>
          {att.state === 'uploading' && (
            <span className="size-2.5 animate-spin rounded-full border border-muted-foreground/30 border-t-muted-foreground" />
          )}
          {att.state === 'failed' && <span className="text-destructive">!</span>}
          <button
            data-pressable
            type="button"
            className="ml-0.5 text-muted-foreground/70 hover:text-foreground"
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
