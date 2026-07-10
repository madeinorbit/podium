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
      hint="The orchestrator that starts, stops, and reasons across all your agents."
    >
      <RoleBackendEditor
        role="superagent"
        backend={settings.roles.superagent}
        accounts={accounts}
        onChange={(superagent) => patch({ roles: { ...settings.roles, superagent } })}
      />
      <RestartSuperagentButton />
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
      <p className="mt-1.5 mb-0.5 max-w-[60ch] text-[12px] text-muted-foreground">
        Starts a fresh harness session on your next message (keeps the conversation history). Use if
        the orchestrator seems stuck on a stale session.
        {done ? ' Done — your next message starts fresh.' : ''}
        {error ? <span className="text-warning"> {error}</span> : null}
      </p>
    </div>
  )
}
