import type { IssueReferenceModel as IssueReferenceView } from '@podium/client-core/viewmodels'
import { CircleDashed } from 'lucide-react'
import type { JSX } from 'react'
import { StageGlyph } from '@/features/issues/issue-glyphs'
import { cn } from '@/lib/utils'

/**
 * The canonical compact issue reference: workflow state lives in the leading
 * Linear-style glyph, followed by the stable ref and (where space permits) the
 * current title. The caller supplies a model projected from its live issue
 * slice; this component owns presentation only.
 */
export function IssueReference({
  model,
  showTitle = true,
  size = 13,
  className,
  refClassName,
  titleClassName,
  titleTestId,
}: {
  model: IssueReferenceView
  showTitle?: boolean
  size?: number
  className?: string
  refClassName?: string
  titleClassName?: string
  titleTestId?: string
}): JSX.Element {
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-1.5', className)}
      data-issue-reference={model.ref}
      data-issue-stage={model.stage ?? undefined}
      data-issue-availability={model.availability}
      role="img"
      aria-label={model.accessibleLabel}
    >
      <span className="flex-none" aria-hidden="true">
        {model.stage ? (
          <StageGlyph stage={model.stage} size={size} />
        ) : (
          <CircleDashed size={size} className="text-muted-foreground/60" />
        )}
      </span>
      <span
        className={cn('flex-none font-mono text-[0.88em] text-muted-foreground', refClassName)}
        aria-hidden="true"
      >
        {model.ref}
      </span>
      {showTitle && model.title && (
        <span
          className={cn('min-w-0 truncate', titleClassName)}
          data-testid={titleTestId}
          aria-hidden="true"
        >
          {model.title}
        </span>
      )}
    </span>
  )
}
