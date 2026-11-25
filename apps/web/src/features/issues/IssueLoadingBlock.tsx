import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
} from 'react'

const PendingContext = createContext<((id: string) => () => void) | null>(null)

/** Keep every section mounted so its holding reads still load together. Pending
 * bodies register before paint; only the shared placeholder appears, after 300ms. */
export function IssueLoadingBlock({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [showPlaceholder, setShowPlaceholder] = useState(false)
  const waiting = pending.size > 0
  const register = useCallback((id: string) => {
    setPending((previous) => new Set(previous).add(id))
    return () => {
      setPending((previous) => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
    }
  }, [])

  useEffect(() => {
    if (!waiting) {
      setShowPlaceholder(false)
      return
    }
    const timer = setTimeout(() => setShowPlaceholder(true), 300)
    return () => clearTimeout(timer)
  }, [waiting])

  return (
    <PendingContext.Provider value={register}>
      <div className="grid" aria-busy={waiting} data-testid="issue-loading-block">
        <div
          className={`col-start-1 row-start-1 flex min-w-0 flex-col gap-5 ${waiting ? 'invisible' : 'issue-sections-enter'}`}
          aria-hidden={waiting || undefined}
          inert={waiting}
          data-testid="issue-section-content"
        >
          {children}
        </div>
        {waiting && (
          <div className="col-start-1 row-start-1 min-h-36" data-testid="issue-section-placeholder">
            {showPlaceholder && (
              <p
                role="status"
                aria-label="Loading issue details"
                className="text-[12.5px] text-muted-foreground/60"
              >
                Loading…
              </p>
            )}
          </div>
        )}
      </div>
    </PendingContext.Provider>
  )
}

/** An unavailable/offline body has settled and keeps its own short line. */
export function useGroupedIssuePending(pending: boolean): boolean {
  const register = useContext(PendingContext)
  const id = useId()
  useLayoutEffect(() => {
    if (register && pending) return register(id)
  }, [register, pending, id])
  return register !== null && pending
}
