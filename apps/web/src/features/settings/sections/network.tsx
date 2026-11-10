import { observer } from '@podium/client-graph/react'
import { type JSX, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useSettingsTrpc } from '@/features/settings/stable-access'
import { type NetworkCheck, NetworkStep, reachabilityHintFor } from '@/features/setup/network-step'
import type { NetworkSettingsView } from '../network-view'
import { useSettingsFrame } from '../settings-frame'
import { forcedNotice, useForcedSetting } from '../use-forced-setting'
import { Row, Section } from './shared'

const EXPOSURE: Record<string, string> = {
  'tailscale-serve': 'Tailscale Serve — reachable from your tailnet only.',
  'tailscale-funnel': 'Tailscale Funnel — reachable from anywhere.',
  'cloudflare-tunnel': 'Cloudflare quick tunnel — changes on every restart.',
  manual: 'Your own reverse proxy.',
}

/** Address and its explicit change flow; Access owns the request's lifetime. */
export const NetworkSection = observer(function NetworkSection({
  view,
}: {
  view: NetworkSettingsView
}): JSX.Element | null {
  const trpc = useSettingsTrpc()
  const frame = useSettingsFrame()
  const forced = useForcedSetting('publicUrl')
  const [lastCheck, setLastCheck] = useState<NetworkCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const info = view.answer
  if (!info) return null
  if (info.mode === 'daemon' || info.mode === 'client') {
    return (
      <Section title="Address">
        <Row label="Connected to" readOnly readOnlyValue={info.serverUrl ?? 'Unknown'} />
        <p className="settings-prose mt-3">
          To connect this machine to a different Podium, run <code>podium setup</code> on it and
          paste a new join code.
        </p>
      </Section>
    )
  }
  const check = async () => {
    if (!info.publicUrl || checking) return
    const url = info.publicUrl
    setChecking(true)
    try {
      const verdict = await trpc.connect.check.query({ url })
      setLastCheck({ url, checkedAt: new Date().toISOString(), verdict })
    } catch {
      setLastCheck({ url, checkedAt: new Date().toISOString(), verdict: undefined })
    } finally {
      setChecking(false)
    }
  }
  const currentCheck = lastCheck?.url === info.publicUrl ? lastCheck : null
  const checked = currentCheck ? new Date(currentCheck.checkedAt).toLocaleString() : null
  const checkLabel = currentCheck
    ? currentCheck.verdict?.ok
      ? `Reachable · Checked ${checked}`
      : currentCheck.verdict === undefined || currentCheck.verdict.error === 'CONNECT_UNAVAILABLE'
        ? `Check unavailable · Attempted ${checked}`
        : `Not reachable from outside · Checked ${checked}`
    : 'Not checked yet'
  // A file-backed bootstrap URL is the address setup itself saved; only env owns it.
  const source =
    forced.source === 'env'
      ? forcedNotice(forced)
      : info.publicUrlSource === 'env'
        ? forcedNotice('PODIUM_PUBLIC_URL')
        : null
  return (
    <Section title="Address">
      <Row
        label="Podium address"
        description={
          <>
            {EXPOSURE[info.networkOption ?? ''] ??
              'How phones, browsers and machines reach this workspace.'}
            {source && <span className="mt-1 block">{source}</span>}
          </>
        }
        readOnly={source !== null}
        readOnlyValue={<span className="break-all font-mono">{info.publicUrl ?? 'Not set'}</span>}
      >
        <span
          className="settings-label min-w-0 flex-1 truncate font-mono"
          title={info.publicUrl ?? undefined}
        >
          {info.publicUrl ?? 'Not set'}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            frame.openTakeover({
              title: 'Change address',
              description: (
                <>
                  Choose how this Podium is reached.{' '}
                  <strong>Paired machines and phones must rejoin with the new address.</strong>
                </>
              ),
              content: (
                <NetworkStep
                  embedded
                  addressOnly
                  trpc={trpc}
                  onBack={frame.closeTakeover}
                  onChecked={setLastCheck}
                  onSaved={() => {
                    void view.refresh()
                    frame.closeTakeover()
                    toast.success('Address saved. Paired machines and phones must rejoin.')
                  }}
                />
              ),
            })
          }
        >
          Change
        </Button>
      </Row>
      <Row
        label="Reachable from outside"
        description={
          <>
            {info.networkOption === 'cloudflare-tunnel' && (
              <span className="block">Tunnel: {view.tunnelHealthLabel}</span>
            )}
            <span>{checking ? 'Checking the address from outside…' : checkLabel}</span>
            {currentCheck && reachabilityHintFor(currentCheck.verdict) && (
              <span className="mt-1 block">{reachabilityHintFor(currentCheck.verdict)}</span>
            )}
          </>
        }
        pending={checking}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!info.publicUrl || checking}
          onClick={() => void check()}
        >
          {checking ? 'Checking…' : 'Check now'}
        </Button>
      </Row>
    </Section>
  )
})

/** Configuration facts live in Advanced, after the everyday sign-ins. */
export const AdvancedNetworkRows = observer(function AdvancedNetworkRows({
  view,
}: {
  view: NetworkSettingsView
}) {
  const app = useForcedSetting('appUrl')
  const origins = useForcedSetting('allowedOrigins')
  const info = view.answer
  if (!info) return null
  return (
    <>
      <Row
        label="Web app address"
        description={app.forced ? forcedNotice(app) : undefined}
        readOnly
        readOnlyValue={<span className="break-all">{info.appUrl ?? 'Same as Podium address'}</span>}
      />
      <Row
        label="Other sites allowed to sign in"
        description={origins.forced ? forcedNotice(origins) : undefined}
        readOnly
        readOnlyValue={
          <span className="break-all">{info.allowedOrigins?.join(', ') || 'None'}</span>
        }
      />
      {info.stableLink && (
        <Row
          label="Stable link"
          description="Always opens this server, even after its address changes."
          readOnly
          readOnlyValue={
            <a
              href={info.stableLink}
              target="_blank"
              rel="noreferrer"
              className="break-all underline-offset-2 hover:underline"
            >
              {info.stableLink}
            </a>
          }
        />
      )}
    </>
  )
})
