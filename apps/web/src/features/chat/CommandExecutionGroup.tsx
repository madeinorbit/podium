import { type ToolExecutionSection, toolBatchTitles } from '@podium/client-core/values'
import type { ReactNode } from 'react'
import './command-execution.css'

/** A native boundary is a labelled group inside the quiet stretch. Keeping the
 * same wrapper for a singleton prevents an arriving second call losing focus
 * or resetting the first command's disclosure. */
export function CommandExecutionGroup({
  section,
  children,
}: {
  section: ToolExecutionSection
  children: ReactNode
}) {
  const grouped = !!section.summary || (!!section.batchKind && section.blocks.length > 1)
  const counts = grouped ? toolBatchTitles([...section.blocks]).summary : undefined
  return (
    <section
      className={grouped ? 'execution-batch' : 'execution-ungrouped'}
      aria-label={grouped ? (section.summary ?? counts) : undefined}
    >
      {grouped && (
        <div className="execution-batch-heading">
          <span>{section.summary ?? counts}</span>
          {section.summary && <span className="execution-batch-count">{counts}</span>}
        </div>
      )}
      <div className={grouped ? 'execution-batch-members' : 'execution-section-members'}>
        {children}
      </div>
    </section>
  )
}
