import { recordChipWork } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import type { IssueReferenceModel as IssueReferenceView } from '@podium/client-core/values'
import type { MobxPool } from '@podium/client-graph'
import type { JSX } from 'react'
import { memo, useCallback, useLayoutEffect } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { StageGlyph, UnknownRefGlyph } from '@/features/issues/issue-glyphs'
import { cn } from '@/lib/utils'

function unavailable(ref: string, loading = false): IssueReferenceView {
  return {
    ref,
    issueId: null,
    title: null,
    stage: null,
    availability: 'unavailable',
    accessibleLabel: `Task ${ref} is ${loading ? 'loading' : 'unavailable'}`,
  }
}

type ChipProps = Omit<Parameters<typeof IssueReference>[0], 'model'> & { token: string }

/** The same UI with a leaf subscription to its one issue. Startup dispatch
 * keeps the legacy list hook completely outside the switched render path. */
export const LiveIssueReference = memo(function LiveIssueReference(props: ChipProps): JSX.Element {
  return <PoolIssueReference {...props} />
})

function PoolIssueReference({ token, ...props }: ChipProps): JSX.Element {
  const owner = useStoreHandle()
  const read = useCallback(
    (pool: MobxPool) => {
      recordChipWork(owner, 'reads')
      return pool.references.read(token)
    },
    [owner, token],
  )
  const model = useWorklistPoolProjection(read, undefined)
  // biome-ignore lint/correctness/useExhaustiveDependencies: Count committed changes to the reference model.
  useLayoutEffect(() => {
    recordChipWork(owner, 'redraws')
  }, [owner, model])
  return (
    <IssueReference
      {...props}
      model={
        typeof model === 'symbol' || model === undefined
          ? unavailable(token, true)
          : (model ?? unavailable(token))
      }
    />
  )
}

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
          <UnknownRefGlyph size={size} />
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
