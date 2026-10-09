import { AutomationOpening } from '@/app/automation-readers'
import { useStoreHandle } from '@podium/client-core/react'
import type { AutomationRunWire, AutomationWire } from '@podium/model/browser'
import { Plus } from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { useAutomation, useAutomationList } from '@/app/automation-readers'
import type { Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { NewAutomationDialog } from './NewAutomationDialog'
import { ScheduledSection } from './ScheduledSection'
import { TriggersSection } from './TriggersSection'

export type Automation = AutomationWire
export type AutomationRun = AutomationRunWire

/** Live, replica-backed automations and honest run history [spec:SP-17db]. */
export function AutomationsView(): JSX.Element {
  return (
    <AutomationOpening>
      <AutomationsViewBody />
    </AutomationOpening>
  )
}

function AutomationsViewBody(): JSX.Element {
  const trpc = useStoreHandle<Trpc>().access.trpc
  const { automations, pending } = useAutomationList()
  const [error, setError] = useState('')
  const [dialogAutomationId, setDialogAutomationId] = useState<string | null | undefined>()
  const dialogAutomation = useAutomation(dialogAutomationId)

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Automations">
      <div className="flex items-center justify-between border-border border-b px-4 py-3 md:px-[22px] md:py-3.5">
        <div className="min-w-0">
          <h2 className="font-medium text-base text-foreground">Automations</h2>
          <p className="truncate text-[12px] text-muted-foreground">
            Notification triggers and recurring agent tasks for your repos.
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => setDialogAutomationId(null)}>
          <Plus size={14} aria-hidden="true" /> New automation
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 md:p-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
          <TriggersSection trpc={trpc} />
          {/* §3.1.6 S5: the steward, expiry jobs and boot reconcile have no human
              behind them. They are not user work and are not listed here. */}
          <ScheduledSection
            trpc={trpc}
            automations={automations}
            loading={pending > 0}
            error={error}
            onEdit={(automation) => setDialogAutomationId(automation.id)}
            onError={setError}
          />
        </div>
      </div>

      {(dialogAutomationId === null || dialogAutomation) && (
        <NewAutomationDialog
          trpc={trpc}
          automation={dialogAutomation ?? null}
          onClose={() => setDialogAutomationId(undefined)}
          onSaved={() => setDialogAutomationId(undefined)}
        />
      )}
    </section>
  )
}
