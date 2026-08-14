import { ONBOARDING_VPS_SERVER_DRAFT_KEY, type UiState } from '@podium/client-core/ui-state'
import { isServerReadiness } from '@podium/model'
import { buildVpsBootstrapCommand, type VpsReleaseChannel } from '@podium/runtime/vps-bootstrap'
import { ArrowLeft, ArrowRight, Check, Copy, Server, ShieldCheck, Terminal } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { parseServerOrigin, type Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ActivationShell } from './ActivationShell'
import type { ActivationRoute } from './activation-route'
import type { ConfirmedVpsActivation } from './use-vps-activation'

export function normalizeNewVpsUrl(
  value: string,
): { serverUrl: string; httpOrigin: string } | null {
  const parsed = parseServerOrigin(value.trim())
  if (!parsed) return null
  return {
    serverUrl: parsed.wsClientUrl.replace(/\/client\?.*$/, ''),
    httpOrigin: parsed.httpOrigin,
  }
}

/** Refuse to strand the desktop in client mode until the entered origin proves it is Podium. */
export async function probeNewVps(
  httpOrigin: string,
  request: typeof fetch = fetch,
): Promise<void> {
  let response: Response
  try {
    response = await request(`${httpOrigin}/readiness`)
  } catch {
    throw new Error('Could not reach Podium at this URL. Check the URL and the VPS network setup.')
  }
  if (!response.ok)
    throw new Error(`The VPS answered, but its readiness check returned ${response.status}.`)
  let status: unknown
  try {
    status = await response.json()
  } catch {
    throw new Error('This URL answered, but it does not look like a current Podium server.')
  }
  if (!isServerReadiness(status)) {
    throw new Error('This URL answered, but it did not return a valid Podium readiness state.')
  }
  if (status.state === 'unconfigured') {
    throw new Error('Podium is installed on the VPS, but its terminal setup is not finished yet.')
  }
  if (status.state === 'activation_pending') {
    throw new Error(
      'The VPS saved its setup but still needs to restart. Wait a moment and try again.',
    )
  }
  if (status.state === 'degraded' && status.reason === 'configuration_invalid') {
    throw new Error('Podium is running on the VPS, but its configuration needs repair first.')
  }
}

function ConnectionError({ error }: { error: string | null }): JSX.Element | null {
  if (!error) return null
  return (
    <div
      role="alert"
      className="rounded-[11px] bg-[#2a1c1d] px-4 py-3 text-[12.5px] leading-[1.5] text-[#e7a3a8] shadow-[inset_0_0_0_1px_#633236]"
    >
      <strong className="mb-0.5 block text-[#f0c0c4]">Could not connect yet</strong>
      {error}
    </div>
  )
}

export function VpsFirstActivation({
  trpc,
  vps,
  onRouteChange,
  onExplore,
  onConfigured,
}: {
  trpc: Trpc
  vps: ConfirmedVpsActivation
  onRouteChange: (route: ActivationRoute) => void
  onExplore: () => void
  onConfigured: () => Promise<void>
}): JSX.Element {
  const uiState = useStoreSelector((store) => store.uiState) as Pick<UiState, 'get' | 'set'>
  const [channel, setChannel] = useState<VpsReleaseChannel>('stable')
  const [serverUrl, setServerUrl] = useState(
    () => uiState.get(ONBOARDING_VPS_SERVER_DRAFT_KEY) ?? '',
  )
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const command = useMemo(() => buildVpsBootstrapCommand(channel), [channel])

  useEffect(() => {
    let alive = true
    void trpc.setup.channel.query().then(
      (result) => {
        if (alive) setChannel(result.channel === 'stable' ? 'stable' : 'edge')
      },
      () => {},
    )
    return () => {
      alive = false
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [trpc])

  const copyCommand = (): void => {
    if (copyTimer.current) clearTimeout(copyTimer.current)
    setCopyState('idle')
    const clipboard = navigator.clipboard
    if (!clipboard) {
      setCopyState('failed')
      return
    }
    void clipboard.writeText(command).then(
      () => {
        setCopyState('copied')
        copyTimer.current = setTimeout(() => setCopyState('idle'), 2_000)
      },
      () => setCopyState('failed'),
    )
  }

  const connect = async (): Promise<void> => {
    const normalized = normalizeNewVpsUrl(serverUrl)
    if (!normalized) {
      setError('Enter the http:// or https:// Podium URL printed by the VPS setup.')
      return
    }
    setBusy(true)
    setError(null)
    let saved = false
    try {
      await probeNewVps(normalized.httpOrigin)
      await trpc.setup.connect.mutate({ mode: 'client', serverUrl: normalized.serverUrl })
      saved = true
      uiState.set(ONBOARDING_VPS_SERVER_DRAFT_KEY, null)
      await vps.clear()
      await onConfigured()
    } catch (cause) {
      setBusy(false)
      setError(
        saved
          ? 'The VPS connection is saved. Quit and reopen Podium to finish connecting.'
          : cause instanceof Error
            ? cause.message
            : String(cause),
      )
    }
  }

  const goBack = async (): Promise<void> => {
    const returnRoute = vps.state?.returnRoute ?? 'welcome'
    try {
      await vps.clear()
      onRouteChange(returnRoute)
    } catch {
      // The controller exposes the authoritative error beside the footer; do not navigate away
      // and pretend a durable checkpoint was cleared when it was not.
    }
  }

  return (
    <ActivationShell
      eyebrow="Activate Podium · VPS"
      title="Put Podium on your VPS."
      description="Create a new always-on Podium on the VPS, then connect this app to it. Nothing on this computer is exposed, paired, or transferred."
      icon={<Server aria-hidden="true" />}
      contentClassName="mt-[34px]"
      onExplore={onExplore}
    >
      <div className="max-w-[760px] space-y-4">
        <section className="rounded-[13px] bg-[#1b1e24] p-5 shadow-[inset_0_0_0_1px_#2f343d] sm:p-6">
          <div className="flex items-start gap-3.5">
            <span className="flex size-8 flex-none items-center justify-center rounded-[9px] bg-[#2b2f37] font-mono text-[10px] font-semibold text-[#e3ba52] shadow-[inset_0_0_0_1px_#3a4049]">
              01
            </span>
            <div>
              <h2 className="text-[15px] font-semibold text-[#f2f3f5]">Run this over SSH</h2>
              <p className="mt-1.5 text-[13.5px] leading-[1.55] text-[#9ba1ab]">
                Sign in to a fresh Linux VPS and paste the command. It installs Podium and the
                supported agents, asks how the VPS should be reached, protects it with your login,
                and starts it automatically after reboot.
              </p>
            </div>
          </div>
          <div className="mt-5 overflow-hidden rounded-[10px] bg-[#15171b] shadow-[inset_0_0_0_1px_#2f343d]">
            <div className="flex items-center justify-between border-b border-[#2b2f37] px-3.5 py-2.5">
              <span className="flex items-center gap-2 font-mono text-[10px] font-semibold tracking-[0.14em] text-[#8a9099] uppercase">
                <Terminal size={14} aria-hidden="true" /> VPS terminal
              </span>
              <button
                type="button"
                onClick={copyCommand}
                className="inline-flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-[12px] font-semibold text-[#e3ba52] hover:bg-[#e3ba52]/10"
              >
                {copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
                {copyState === 'copied'
                  ? 'Copied'
                  : copyState === 'failed'
                    ? 'Copy failed'
                    : 'Copy'}
              </button>
            </div>
            <code className="block max-h-[132px] overflow-auto whitespace-pre-wrap break-all px-4 py-3.5 font-mono text-[12px] leading-[1.6] text-[#d7dae0] [scrollbar-width:thin]">
              {command}
            </code>
          </div>
        </section>

        <section className="rounded-[13px] bg-[#1b1e24] p-5 shadow-[inset_0_0_0_1px_#2f343d] sm:p-6">
          <div className="flex items-start gap-3.5">
            <span className="flex size-8 flex-none items-center justify-center rounded-[9px] bg-[#2b2f37] font-mono text-[10px] font-semibold text-[#e3ba52] shadow-[inset_0_0_0_1px_#3a4049]">
              02
            </span>
            <div>
              <h2 className="text-[15px] font-semibold text-[#f2f3f5]">Connect this app</h2>
              <p className="mt-1.5 text-[13.5px] leading-[1.55] text-[#9ba1ab]">
                When setup finishes, paste the Podium URL it printed. We verify the VPS before
                changing anything, then this app restarts and asks for the login you created.
              </p>
            </div>
          </div>
          <div className="mt-5 flex gap-3 max-sm:flex-col">
            <Input
              aria-label="New VPS Podium URL"
              type="url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              placeholder="https://your-vps.example.com"
              value={serverUrl}
              disabled={busy}
              className="h-[42px] flex-1 rounded-[10px] border-0 bg-[#15171b] px-3.5 font-mono text-[14px] text-[#e6e8ec] shadow-[inset_0_0_0_1px_#2f343d] placeholder:text-[#6f757f]"
              onChange={(event) => {
                const value = event.currentTarget.value
                setServerUrl(value)
                uiState.set(ONBOARDING_VPS_SERVER_DRAFT_KEY, value || null)
                if (error) setError(null)
              }}
            />
            <Button
              type="button"
              pending={busy}
              pendingLabel="Checking VPS…"
              disabled={!serverUrl.trim()}
              className="h-[42px] rounded-[10px] border-0 bg-[#e3ba52] px-4 text-[13.5px] font-semibold text-[#1a1408] hover:bg-[#efc95f]"
              onClick={() => void connect()}
            >
              Connect to VPS
              <ArrowRight size={17} aria-hidden="true" />
            </Button>
          </div>
          <div className="mt-3">
            <ConnectionError error={error} />
          </div>
          <p className="mt-4 flex items-start gap-2 border-t border-[#2b2f37] pt-4 text-[12.5px] leading-[1.5] text-[#7f858f]">
            <ShieldCheck size={16} className="mt-0.5 flex-none text-[#6fbc8c]" aria-hidden="true" />
            Your VPS becomes the only Podium server. This computer starts in client-only mode; you
            can let it run agents later from Settings.
          </p>
        </section>

        <button
          type="button"
          disabled={busy || vps.saving}
          onClick={() => void goBack()}
          className="inline-flex items-center gap-2 text-[13px] leading-none text-[#a8adb6] hover:text-[#f2f3f5] disabled:opacity-50"
        >
          <ArrowLeft size={16} className="text-[#6f757f]" aria-hidden="true" />
          Back to activation choices
        </button>
        {vps.error && <ConnectionError error={vps.error} />}
      </div>
    </ActivationShell>
  )
}
