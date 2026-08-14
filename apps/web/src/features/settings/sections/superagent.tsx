import type { PodiumSettings } from '@podium/runtime'
import type { JSX } from 'react'
import { useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { type AccountView, RoleBackendEditor, Section } from './shared'

/** The orchestrator's backend (account/model/effort) + the restart escape hatch. */
export function SuperagentSection({
  settings,
  accounts,
  patch,
}: {
  settings: PodiumSettings
  accounts: AccountView[]
  patch: (p: Partial<PodiumSettings>) => void
}): JSX.Element {
  return (
    <Section
      title="Superagent"
      hint="Default connector, model, and effort. The prompt box can pick any other agent for a thread — Auto follows this default."
    >
      <RoleBackendEditor
        role="superagent"
        backend={settings.roles.superagent}
        accounts={accounts}
        onChange={(superagent) => patch({ roles: { ...settings.roles, superagent } })}
      />
      <RestartSuperagentButton />
      <div className="mt-6 border-t border-border pt-5">
        <h3 className="mb-1 text-sm font-medium">Shipwright</h3>
        <p className="settings-prose mb-3">
          Personal account preference for bounded conflict and gate repair. Live model availability
          and quota still decide the model used for each safe-fix attempt.
        </p>
        <RoleBackendEditor
          role="shipwright"
          backend={settings.roles.shipwright}
          accounts={accounts}
          onChange={(shipwright) => patch({ roles: { ...settings.roles, shipwright } })}
        />
      </div>
    </Section>
  )
}

/** Reset the global superagent's harness session — the next message starts a
 *  fresh one (#199). Escape hatch for a wedged/stale orchestrator harness. */
function RestartSuperagentButton(): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="mt-4">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setDone(false)
          setError(null)
          try {
            await trpc.superagent.restart.mutate({ threadId: 'global' })
            setDone(true)
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'Restarting…' : 'Restart superagent'}
      </Button>
      <p className="settings-prose mt-2">
        Starts a fresh harness session on your next message (keeps the conversation history). Use if
        the orchestrator seems stuck on a stale session.
        {done ? ' Done — your next message starts fresh.' : ''}
        {error ? <span className="text-warning"> {error}</span> : null}
      </p>
    </div>
  )
}
