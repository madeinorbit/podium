import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { NetworkStep } from '@/features/setup/network-step'
import { Row, Section } from './shared'

interface NetworkInfo {
  mode: string | null
  publicUrl: string | null
  serverUrl: string | null
}

/**
 * Network — view + change how this server is reached (its `publicUrl`) after first-run setup.
 * The join tokens handed to new machines embed this URL, so it's the thing to change when you
 * switch from a throwaway tunnel to a stable one. Reuses the setup reachability step. Worker
 * (`daemon`) / viewer (`client`) boxes show which server they connect to instead (change = re-run
 * setup). Fills the gap where the CLI's `podium setup → change URL` had no web equivalent.
 */
export function NetworkSection(): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  // undefined = loading, null = failed. Do not guess that this is a host until mode is known:
  // the host form can change topology, so briefly showing it on a worker is unsafe.
  const [info, setInfo] = useState<NetworkInfo | null | undefined>(undefined)

  const load = (showLoading = false): void => {
    if (showLoading) setInfo(undefined)
    trpc.setup.info
      .query()
      .then(setInfo)
      .catch(() => setInfo(null))
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: load is stable enough; trpc is the dep.
  useEffect(() => load(true), [trpc])

  if (info === undefined) {
    return (
      <Section title="Network" hint="Loading the network configuration for this machine.">
        <p role="status" className="settings-prose">
          Loading network settings…
        </p>
      </Section>
    )
  }

  if (info === null) {
    return (
      <Section title="Network" hint="Choose how this machine connects to Podium.">
        <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <p role="alert" className="settings-prose text-destructive">
            Couldn’t load network settings.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => load(true)}>
            Try again
          </Button>
        </div>
      </Section>
    )
  }

  const isWorker = info.mode === 'daemon' || info.mode === 'client'

  if (isWorker) {
    return (
      <Section
        title="Network"
        hint="This machine connects to a Podium running elsewhere; it isn't reachable on its own."
      >
        <Row label="Connected to">
          <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">
            {info.serverUrl ?? <span className="text-muted-foreground">unknown</span>}
          </span>
        </Row>
        <p className="settings-prose mt-1">
          To point this machine at a different server, re-run <code>podium setup</code> on it and
          paste a new join code.
        </p>
      </Section>
    )
  }

  return (
    <Section
      title="Network"
      hint="Choose how phones, browsers, and other machines reach this Podium server."
    >
      <NetworkStep embedded trpc={trpc} onSaved={load} />
    </Section>
  )
}
