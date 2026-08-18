import { ONBOARDING_VPS_SERVER_DRAFT_KEY, type UiState } from '@podium/client-core/ui-state'
import { isServerReadiness } from '@podium/model'
import {
  buildVpsBootstrapCommand,
  type VpsReleaseChannel,
  vpsInstallerChannel,
} from '@podium/runtime/vps-bootstrap'
import { ArrowRight, Check, Copy, RefreshCw, Server, ShieldCheck, Terminal } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { parseServerOrigin, type Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ActivationBack, ActivationShell } from './ActivationShell'
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

/**
 * The channel the SERVER resolved, mapped onto the two release trains a VPS can
 * install from. An unfamiliar or missing answer stays UNREAD (POD-1288): the
 * installer URL differs per channel, so guessing one publishes a 404 to paste.
 */
export function vpsChannelOf(result: unknown): VpsReleaseChannel | undefined {
  const selected =
    typeof result === 'string' ? result : (result as { channel?: unknown } | undefined)?.channel
  if (selected === 'dev' || selected === 'edge') return 'edge'
  if (selected === 'stable') return 'stable'
  return undefined
}

/** Reading the channel is a step of its own: there is no command before it lands. */
type ChannelRead =
  | { status: 'reading' }
  | { status: 'known'; channel: VpsReleaseChannel }
  | { status: 'unread' }

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
  onConfigured,
}: {
  trpc: Trpc
  vps: ConfirmedVpsActivation
  onRouteChange: (route: ActivationRoute) => void
  onConfigured: () => Promise<void>
}): JSX.Element {
  const uiState = useStoreSelector((store) => store.uiState) as Pick<UiState, 'get' | 'set'>
  const [read, setRead] = useState<ChannelRead>({ status: 'reading' })
  const [attempt, setAttempt] = useState(0)
  const [serverUrl, setServerUrl] = useState(
    () => uiState.get(ONBOARDING_VPS_SERVER_DRAFT_KEY) ?? '',
  )
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const command = useMemo(
    () => (read.status === 'known' ? buildVpsBootstrapCommand(read.channel) : null),
    [read],
  )
  // The instance updates on a channel the VPS cannot install from yet; the command
  // says the other train, and so must the page. Never a silent substitution.
  const substituted = read.status === 'known' && vpsInstallerChannel(read.channel) !== read.channel

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is the deliberate re-read trigger
  useEffect(() => {
    let alive = true
    setRead({ status: 'reading' })
    void trpc.setup.channel.query().then(
      (result) => {
        if (!alive) return
        const channel = vpsChannelOf(result)
        setRead(channel ? { status: 'known', channel } : { status: 'unread' })
      },
      () => {
        // The transport already replays this idempotent read across a server restart.
        // A rejection that survives it is a genuine failure, and no permission to pick
        // a channel: the step says so and offers the read again.
        if (alive) setRead({ status: 'unread' })
      },
    )
    return () => {
      alive = false
    }
  }, [trpc, attempt])

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    [],
  )

  const copyCommand = (): void => {
    if (!command) return
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
    const returnRoute = vps.state?.returnRoute ?? 'vps-choice'
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
      eyebrow="Set up Podium · New VPS"
      title="Put Podium on your VPS."
      description="Install a new always-on Podium on the VPS, then connect this app to it. Nothing on this computer is exposed, paired, or transferred."
      icon={<Server aria-hidden="true" />}
      contentClassName="mt-[34px]"
      frameClassName="pb-16 sm:pb-[72px] lg:pb-[72px]"
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
                Sign in to a fresh Linux VPS and paste this one command. It safely downloads the
                installer first, installs Podium and the supported agents, then guides you through
                its reachable URL, login password, and whether it should survive reboots.
              </p>
            </div>
          </div>
          <div className="mt-5 overflow-hidden rounded-[10px] bg-[#15171b] shadow-[inset_0_0_0_1px_#2f343d]">
            <div className="flex items-center justify-between border-b border-[#2b2f37] px-3.5 py-2.5">
              <span className="flex items-center gap-2 font-mono text-[10px] font-semibold tracking-[0.14em] text-[#8a9099] uppercase">
                <Terminal size={14} aria-hidden="true" /> VPS terminal
              </span>
              {command !== null && (
                <button
                  type="button"
                  data-pressable
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
              )}
            </div>
            {command !== null ? (
              <code className="block max-h-[132px] overflow-auto whitespace-pre-wrap break-all px-4 py-3.5 font-mono text-[12px] leading-[1.6] text-[#d7dae0] [scrollbar-width:thin]">
                {command}
              </code>
            ) : read.status === 'reading' ? (
              <p
                role="status"
                className="px-4 py-3.5 text-[12.5px] leading-[1.6] text-[#8a9099] italic"
              >
                Reading which release train this Podium installs from…
              </p>
            ) : (
              <div role="alert" className="px-4 py-3.5 text-[12.5px] leading-[1.6] text-[#e7a3a8]">
                Could not read which release train this Podium installs from, so there is no command
                yet. The installer lives at a different address per channel, and the wrong address
                downloads nothing at all.
                <button
                  type="button"
                  data-pressable
                  onClick={() => setAttempt((previous) => previous + 1)}
                  className="mt-2 -ml-2.5 flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-[12px] font-semibold text-[#e3ba52] hover:bg-[#e3ba52]/10"
                >
                  <RefreshCw size={14} aria-hidden="true" /> Try again
                </button>
              </div>
            )}
          </div>
          {substituted && (
            <p className="mt-3 text-[12.5px] leading-[1.55] text-[#9ba1ab]">
              This Podium updates on <code className="font-mono text-[#a8adb6]">stable</code>, but
              no stable release is published yet — so the VPS installs the{' '}
              <code className="font-mono text-[#a8adb6]">edge</code> build, the only train that
              exists, and keeps updating on it.
            </p>
          )}
          {command !== null && (
            <p className="mt-3 text-[12.5px] leading-[1.55] text-[#7f858f]">
              The shorter <code className="font-mono text-[#a8adb6]">curl … | sh</code> command only
              installs Podium and exits. This complete command also installs the supported agents
              and starts the interactive VPS setup while your SSH terminal is still attached.
            </p>
          )}
        </section>

        <section className="rounded-[13px] bg-[#1b1e24] p-5 shadow-[inset_0_0_0_1px_#2f343d] sm:p-6">
          <div className="flex items-start gap-3.5">
            <span className="flex size-8 flex-none items-center justify-center rounded-[9px] bg-[#2b2f37] font-mono text-[10px] font-semibold text-[#e3ba52] shadow-[inset_0_0_0_1px_#3a4049]">
              02
            </span>
            <div>
              <h2 className="text-[15px] font-semibold text-[#f2f3f5]">Connect this app</h2>
              <p className="mt-1.5 text-[13.5px] leading-[1.55] text-[#9ba1ab]">
                When setup finishes, paste the Podium URL it printed. No pairing number is needed:
                we verify that the URL is a ready Podium server before changing anything, then this
                app restarts and asks for the login you created.
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

        <ActivationBack disabled={busy || vps.saving} onBack={() => void goBack()} />
        {vps.error && <ConnectionError error={vps.error} />}
      </div>
    </ActivationShell>
  )
}
