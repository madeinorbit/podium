import { shallowEqual } from '@podium/client-core/store'
import type { AutomationRunWire, AutomationWire } from '@podium/protocol'
import { Plus } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { NewAutomationDialog } from './NewAutomationDialog'
import { ScheduledSection } from './ScheduledSection'
import { TriggersSection } from './TriggersSection'

export type Automation = AutomationWire
export type AutomationRun = AutomationRunWire

/** Live, replica-backed automations and honest run history [spec:SP-17db]. */
export function AutomationsView(): JSX.Element {
  const { trpc, automations, automationRuns } = useStoreSelector(
    (s) => ({
      trpc: s.trpc,
      automations: s.automations,
      automationRuns: s.automationRuns,
    }),
    shallowEqual,
  )
  const [error, setError] = useState('')
  const [dialogAutomation, setDialogAutomation] = useState<Automation | null | undefined>()

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Automations">
      <div className="flex items-center justify-between border-border border-b px-4 py-3 md:px-[22px] md:py-3.5">
        <div className="min-w-0">
          <h2 className="font-medium text-base text-foreground">Automations</h2>
          <p className="truncate text-[12px] text-muted-foreground">
            Notification triggers and recurring agent tasks for your repos.
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => setDialogAutomation(null)}>
          <Plus size={14} aria-hidden="true" /> New automation
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 md:p-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
          <TriggersSection trpc={trpc} />
          <ScheduledSection
            trpc={trpc}
            automations={automations}
            automationRuns={automationRuns}
            error={error}
            onEdit={setDialogAutomation}
            onError={setError}
          />
        </div>
      </div>

      {dialogAutomation !== undefined && (
        <NewAutomationDialog
          trpc={trpc}
          automation={dialogAutomation}
          onClose={() => setDialogAutomation(undefined)}
          onSaved={() => setDialogAutomation(undefined)}
        />
      )}
    </section>
  )
}
