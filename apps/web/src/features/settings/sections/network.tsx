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
  /**
   * Whether this server has verified it can reach its OWN public URL (PDM-26).
   * `null` = the first check has not completed. Shown here rather than in the
   * app header because an unreachable public URL is not an outage — the operator
   * looking at this page is being served perfectly well — it is a fact that
   * explains why a machine enrolled and never connected.
   */
  publicUrlVerified?: { ok: boolean; checkedAt: string; error?: string } | null
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
      <PublicUrlReachability verified={info.publicUrlVerified ?? null} />
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

/**
 * Whether this server reached its own public URL through the front door.
 *
 * A FAILURE IS NOT AN OUTAGE, and the copy has to say so: the person reading it
 * is being served fine. What it explains is the thing that is otherwise
 * inexplicable — a machine that enrolled and then never connected, because the
 * URL it was handed does not answer.
 */
function PublicUrlReachability({
  verified,
}: {
  verified: { ok: boolean; checkedAt: string; error?: string } | null
}): JSX.Element | null {
  // Nothing to say before the first check completes; a "checking…" line on a
  // settings page is noise the operator cannot act on.
  if (!verified) return null
  if (verified.ok) {
    return (
      <p className="mt-2 settings-prose text-muted-foreground">
        This server reached its own public URL.
      </p>
    )
  }
  return (
    <p role="status" className="mt-2 settings-prose text-warning">
      This server could not reach its own public URL{verified.error ? `: ${verified.error}` : '.'}{' '}
      Podium keeps serving, but new machines and phones cannot be paired until it answers.
    </p>
  )
}
