import type { JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { type NetworkSaveController, NetworkStep } from '@/features/setup/network-step'
import { forcedNotice, useForcedSetting } from '../use-forced-setting'
import { Row, Section } from './shared'

interface NetworkInfo {
  mode: string | null
  publicUrl: string | null
  serverUrl: string | null
  /** Where the web UI is served from, when it is not this server (PDM-26). */
  appUrl?: string | null
  /** Credentialed cross-site origins this deployment allows. */
  allowedOrigins?: string[]
}

/**
 * Network — view + change how this server is reached (its `publicUrl`) after first-run setup.
 * The join tokens handed to new machines embed this URL, so it's the thing to change when you
 * switch from a throwaway tunnel to a stable one. Reuses the setup reachability step. Worker
 * (`daemon`) / viewer (`client`) boxes show which server they connect to instead (change = re-run
 * setup). Fills the gap where the CLI's `podium setup → change URL` had no web equivalent.
 */
export function NetworkSection({
  onSaveStateChange,
}: {
  onSaveStateChange?: (state: NetworkSaveController | null) => void
} = {}): JSX.Element {
  const trpc = useStoreSelector((s) => s.trpc)
  const forcedPublicUrl = useForcedSetting('publicUrl')
  const forcedAppUrl = useForcedSetting('appUrl')
  const forcedOrigins = useForcedSetting('allowedOrigins')
  // undefined = loading, null = failed. Do not guess that this is a host until mode is known:
  // the host form can change topology, so briefly showing it on a worker is unsafe.
  const [info, setInfo] = useState<NetworkInfo | null | undefined>(undefined)

  const load = useCallback(
    (showLoading = false): void => {
      if (showLoading) setInfo(undefined)
      trpc.setup.info
        .query()
        .then(setInfo)
        .catch(() => setInfo(null))
    },
    [trpc],
  )
  useEffect(() => load(true), [load])

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
      {forcedPublicUrl.forced ? (
        <>
          <Row label="Public URL">
            <span className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-foreground">
              {info.publicUrl ?? <span className="text-muted-foreground">not set</span>}
            </span>
          </Row>
          <p className="mt-2 settings-prose text-warning">{forcedNotice(forcedPublicUrl.env)}</p>
        </>
      ) : (
        <NetworkStep embedded trpc={trpc} onSaved={load} onSaveStateChange={onSaveStateChange} />
      )}
      {/*
        WHERE THE UI IS, when it is not here. Read-only and shown only when set:
        an operator who never split their hosting has no such thing, and a row
        saying "not set" would invite them to look for a setting that would only
        break their install. Split hosting is configured by the deployment, so
        the value arrives through the environment and there is nothing to edit
        here — the provenance notice says which variable holds it.
      */}
      {info.appUrl && (
        <>
          <Row
            label="Web app URL"
            description="Browsers and desktop apps are sent here for the interface; this server answers the API."
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-foreground">
              {info.appUrl}
            </span>
          </Row>
          {forcedAppUrl.forced && (
            <p className="mt-2 settings-prose text-muted-foreground">
              {forcedNotice(forcedAppUrl.env)}
            </p>
          )}
        </>
      )}
      {(info.allowedOrigins?.length ?? 0) > 0 && (
        <>
          <Row
            label="Allowed browser origins"
            description="Sites allowed to sign in to this server from another origin."
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-foreground">
              {info.allowedOrigins?.join(', ')}
            </span>
          </Row>
          {forcedOrigins.forced && (
            <p className="mt-2 settings-prose text-muted-foreground">
              {forcedNotice(forcedOrigins.env)}
            </p>
          )}
        </>
      )}
    </Section>
  )
}
