/**
 * WORKFLOWS (POD-647) — the SHELL, and nothing else.
 *
 * What used to be 872 lines of fetching, deriving, mutating and rendering is now
 * four parts with one job each:
 *
 *  - `packages/client-core/src/viewmodels/slices/workflows.ts` — the derivations,
 *    platform-neutral and unit-testable without a DOM;
 *  - `use-workflows.ts` — the source: fetching, dispatch, denial and eviction;
 *  - `workflow-commands.ts` — every write as DATA, with its POD-641 contract and
 *    its rights predicate;
 *  - `WorkflowLibrary` / `RunProgress` / `ExecutionProfiles` — the three tabs.
 *
 * This file holds the tab, the header and the ONE feedback region — the pieces
 * that genuinely belong to the surface as a whole.
 *
 * WHY THE RIGHTS COME FROM A CONSTANT TODAY. The workflow READ wires carry no
 * per-row grant, and POD-1127 has not settled whether workflows become
 * replicated entities that would carry one. Rather than synthesize a decision in
 * a component — the exact "component default" the brief forbids — the surface
 * grants what a single-user instance already grants and consumes the predicate
 * seam for real. When the wire carries a decision, one constant is replaced and
 * nothing else moves.
 */
import { RefreshCw, Workflow } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ExecutionProfiles } from './ExecutionProfiles'
import { RunProgress } from './RunProgress'
import { useWorkflows } from './use-workflows'
import { OPERATOR_WORKFLOW_RIGHTS } from './workflow-commands'
import { WorkflowLibrary } from './WorkflowLibrary'

type Tab = 'library' | 'progress' | 'profiles'

const TABS: readonly (readonly [Tab, string])[] = [
  ['library', 'Library'],
  ['progress', 'Progress'],
  ['profiles', 'Execution profiles'],
]

export function WorkflowsView(): JSX.Element {
  const [tab, setTab] = useState<Tab>('library')
  const source = useWorkflows()
  const rights = OPERATOR_WORKFLOW_RIGHTS

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex flex-none items-center justify-between border-b px-5 py-3">
        <div>
          <h1 className="flex items-center gap-2 text-base font-semibold">
            <Workflow size={18} aria-hidden="true" />
            Workflows
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Versioned instructions, optional linear steps, and explicit execution profiles.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          pending={source.refreshing}
          pendingLabel="Refreshing…"
          onClick={() => void source.refresh()}
        >
          <RefreshCw size={13} aria-hidden="true" />
          Refresh
        </Button>
      </header>

      <nav className="flex flex-none gap-1 border-b px-5 pt-2" aria-label="Workflow sections">
        {TABS.map(([id, label]) => (
          <button
            data-pressable
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              'border-b-2 px-3 py-2 text-xs font-medium',
              tab === id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      {/*
        ONE feedback region for the whole surface, and it is where a DENIED write
        lands. The success sentence is written only after the authority applied
        the command — never optimistically — so a refusal never has to take one
        back, and nothing here retries.
      */}
      {(source.error || source.notice) && (
        <div
          id="workflow-action-feedback"
          role={source.error ? 'alert' : 'status'}
          className={cn(
            'mx-5 mt-3 rounded-md border px-3 py-2 text-xs',
            source.error
              ? 'border-destructive/30 bg-destructive/5 text-destructive'
              : 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400',
          )}
        >
          {source.error ?? source.notice}
        </div>
      )}

      {source.loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading workflows…
        </div>
      ) : tab === 'library' ? (
        <WorkflowLibrary source={source} rights={rights} />
      ) : tab === 'progress' ? (
        <RunProgress source={source} rights={rights} />
      ) : (
        <ExecutionProfiles source={source} rights={rights} />
      )}
    </main>
  )
}
