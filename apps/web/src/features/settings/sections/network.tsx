import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { NetworkStep } from '@/features/setup/SetupView'
import { Row, Section } from './shared'

/**
 * Network — view + change how this server is reached (its `publicUrl`) after first-run setup.
 * The join tokens handed to new machines embed this URL, so it's the thing to change when you
 * switch from a throwaway tunnel to a stable one. Reuses the setup reachability step. Worker
 * (`daemon`) / viewer (`client`) boxes show which server they connect to instead (change = re-run
 * setup). Fills the gap where the CLI's `podium setup → change URL` had no web equivalent.
 */
export function NetworkSection(): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const [info, setInfo] = useState<{
    mode: string | null
    publicUrl: string | null
    serverUrl: string | null
  } | null>(null)
  const [editing, setEditing] = useState(false)

  const load = (): void => {
    trpc.setup.info
      .query()
      .then(setInfo)
      .catch(() => setInfo(null))
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: load is stable enough; trpc is the dep.
  useEffect(() => load(), [trpc])

  const isWorker = info?.mode === 'daemon' || info?.mode === 'client'

  if (isWorker) {
    return (
      <Section
        title="Network"
        hint="This machine connects to a Podium running elsewhere; it isn't reachable on its own."
      >
        <Row label="Connected to">
          <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
            {info?.serverUrl ?? <span className="text-muted-foreground">unknown</span>}
          </span>
        </Row>
        <p className="max-w-[60ch] text-[12px] text-muted-foreground">
          To point this machine at a different server, re-run <code>podium setup</code> on it and
          paste a new join code.
        </p>
      </Section>
    )
  }

  return (
    <Section
      title="Network"
      hint="How this server is reached from your browser and other machines. The join tokens you hand out to new machines embed this URL — change it here when you switch to a different address."
    >
      <Row label="Reachable URL">
        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
          {info?.publicUrl ?? <span className="text-muted-foreground">not set</span>}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="flex-none"
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? 'Cancel' : info?.publicUrl ? 'Change…' : 'Set up…'}
        </Button>
      </Row>
      {editing && (
        <div className="mt-3">
          <NetworkStep
            embedded
            trpc={trpc}
            onSaved={() => {
              setEditing(false)
              load()
            }}
          />
        </div>
      )}
    </Section>
  )
}
