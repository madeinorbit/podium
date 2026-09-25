import { deckDependencyNote, type IssueNavigationModel } from '@podium/client-core/viewmodels'
import { issueDisplayRef } from '@podium/protocol'
import type { JSX } from 'react'

/** Names every recorded blocker and keeps authored prose visibly separate. */
export function FlightDeckDependencyDetails({
  issue,
  byId,
  members,
  onOpen,
  className = '',
}: {
  issue: IssueNavigationModel
  byId: ReadonlyMap<string, IssueNavigationModel>
  members: ReadonlySet<string>
  onOpen: (issue: IssueNavigationModel) => void
  className?: string
}): JSX.Element | null {
  const { label, dependencies, authoredNotes } = deckDependencyNote(issue, byId, members)
  if (dependencies.length === 0 && authoredNotes.length === 0) return null
  return (
    <div className={`shell-type-micro flex flex-wrap gap-x-1 gap-y-1 break-words text-text-dim ${className}`} aria-label={`Dependencies for ${issueDisplayRef(issue)}`} data-testid="flight-dependency-details">
      {dependencies.length > 0 && <span>{label ?? 'Recorded dependencies'}:</span>}
      {dependencies.map((dependency) => dependency.target ? (
        <button key={dependency.id} data-pressable type="button" className="min-h-6 break-words text-left underline decoration-hairline-soft hover:text-text-strong" onClick={(event) => { event.stopPropagation(); onOpen(dependency.target as IssueNavigationModel) }}>
          {issueDisplayRef(dependency.target)} · {dependency.target.title} · {dependency.lifecycle}{dependency.outsideMission ? ' · Outside this epic' : ''}
        </button>
      ) : <span key={dependency.id}>Dependency unavailable · {dependency.id}</span>)}
      {authoredNotes.map((note, index) => <span key={`${index}:${note}`}>Dependency note · {note}</span>)}
    </div>
  )
}
