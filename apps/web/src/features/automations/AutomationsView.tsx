import { Plus } from 'lucide-react'
import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import type { Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { NewAutomationDialog } from './NewAutomationDialog'
import { ScheduledSection } from './ScheduledSection'
import { TriggersSection } from './TriggersSection'

/** A scheduled automation row, inferred from the tRPC contract so the UI tracks the
 *  server's `AutomationRow` shape without re-declaring it (#470) [spec:SP-17db]. */
export type Automation = Awaited<ReturnType<Trpc['automations']['list']['query']>>[number]

/** One fire of an automation — the real run history that replaced MOCK_RUNS. */
export type AutomationRun = Awaited<ReturnType<Trpc['automations']['runs']['query']>>[number]

/**
 * The Automations surface — two real halves (#470) [spec:SP-17db]:
 *  - Notification triggers (TriggersSection): the durable event subscriptions the
 *    steward dispatches, unchanged apart from the `notify` switch now actually
 *    pushing.
 *  - Scheduled (ScheduledSection): cron automations that persist, fire, spawn a
 *    session, and keep an honest run history. The seeded mock cards are gone.
 *
 * The reactive (event-triggered) half survives only inside the composer, with
 * Create disabled and an explicit "not yet wired to a runner" note — the design
 * intent stays visible without pretending to work.
 */
export function AutomationsView(): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const [automations, setAutomations] = useState<Automation[] | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)

  const reload = useCallback((): void => {
    trpc.automations.list
      .query()
      .then((rows) => {
        setAutomations(rows)
        setError('')
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [trpc])

  useEffect(() => {
    reload()
  }, [reload])

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden" aria-label="Automations">
      <div className="flex items-center justify-between border-border border-b px-4 py-3 md:px-[22px] md:py-3.5">
        <div className="min-w-0">
          <h2 className="font-medium text-base text-foreground">Automations</h2>
          <p className="truncate text-[12px] text-muted-foreground">
            Notification triggers and recurring agent tasks for your repos.
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => setCreating(true)}>
          <Plus size={14} aria-hidden="true" /> New automation
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 md:p-4">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
          <TriggersSection trpc={trpc} />
          <ScheduledSection
            trpc={trpc}
            automations={automations}
            error={error}
            onChanged={reload}
            onError={setError}
          />
        </div>
      </div>

      {creating && (
        <NewAutomationDialog
          trpc={trpc}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            reload()
          }}
        />
      )}
    </section>
  )
}
