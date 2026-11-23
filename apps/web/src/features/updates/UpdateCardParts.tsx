// biome-ignore-all lint/a11y/noNoninteractiveTabindex: scroll regions need keyboard focus for arrow and page scrolling
import type { ReleaseProposalCommit } from '@podium/protocol'
import { Check } from 'lucide-react'
import { type JSX, type ReactNode, useLayoutEffect, useRef, useState } from 'react'

export function UpdateCardHeader({
  title,
  subtitle,
  badge,
  dev,
  done,
  children,
}: {
  title: string
  subtitle?: ReactNode
  badge?: ReactNode
  dev?: boolean
  done?: boolean
  children?: ReactNode
}): JSX.Element {
  return (
    <header className="update-card-head">
      <div className="update-card-title-row">
        {done && (
          <span className="update-card-done" aria-hidden="true">
            <Check size={11} />
          </span>
        )}
        <h2>{title}</h2>
        {badge && (
          <span className="update-card-channel" data-dev={dev}>
            {badge}
          </span>
        )}
      </div>
      {subtitle && <div className="update-card-from">{subtitle}</div>}
      {children}
    </header>
  )
}

/** The scroll box owns its fades; fitting content and either end stay crisp. */
export function UpdateScrollArea({
  children,
  className = '',
  onRead,
  labelledBy,
  testId,
}: {
  children: ReactNode
  className?: string
  onRead?: () => void
  labelledBy?: string
  testId?: string
}): JSX.Element {
  const ref = useRef<HTMLElement>(null)
  const [edges, setEdges] = useState({ top: true, end: true })
  // biome-ignore lint/correctness/useExhaustiveDependencies: content changes can overflow without changing the box's dimensions
  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    const measure = () =>
      setEdges({
        top: box.scrollTop <= 1,
        end: box.scrollHeight - box.clientHeight - box.scrollTop <= 1,
      })
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(box)
    if (box.firstElementChild) observer?.observe(box.firstElementChild)
    return () => observer?.disconnect()
  }, [children])
  return (
    <section
      ref={ref}
      className={`update-card-scroll ${className}`}
      data-at-top={edges.top}
      data-at-end={edges.end}
      data-testid={testId}
      tabIndex={0}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : 'Update details'}
      onScroll={(event) => {
        const box = event.currentTarget
        setEdges({
          top: box.scrollTop <= 1,
          end: box.scrollHeight - box.clientHeight - box.scrollTop <= 1,
        })
        if (box.scrollTop > 0) onRead?.()
      }}
    >
      {children}
    </section>
  )
}

/** Both development cards consume the publisher's newest-first, bounded list. */
export function UpdateCommitList({
  commits,
  total,
  testId,
}: {
  commits: ReleaseProposalCommit[]
  total?: number
  testId?: string
}): JSX.Element {
  const remaining = Math.max(0, (total ?? commits.length) - commits.length)
  return (
    <div>
      {commits.length > 0 ? (
        <ul
          className="update-card-commits"
          data-testid={testId}
          aria-label="Commits in this release"
        >
          {commits.map((commit) => (
            <li key={commit.sha} title={`${commit.sha}\n${commit.summary}`}>
              <code>{commit.sha.slice(0, 7)}</code>
              <span>{commit.summary}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="update-card-empty">No changes since what this server is running.</p>
      )}
      {remaining > 0 && <p className="update-card-more">and {remaining} more</p>}
    </div>
  )
}
