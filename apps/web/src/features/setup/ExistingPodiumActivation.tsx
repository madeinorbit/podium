import {
  EXISTING_PODIUM_CLIENT_DRAFT_KEY,
  EXISTING_PODIUM_MACHINE_DRAFT_KEY,
  type UiState,
} from '@podium/client-core/ui-state'
import {
  ArrowLeft,
  ArrowRight,
  Ban,
  History,
  KeyRound,
  Laptop,
  LockKeyhole,
  MonitorUp,
  Network,
  Repeat2,
  Shield,
  Timer,
} from 'lucide-react'
import type { JSX } from 'react'
import { useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { parseServerOrigin, type Trpc } from '@/app/trpc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ActivationShell } from './ActivationShell'
import type { ActivationRoute } from './activation-route'

export const EXISTING_PODIUM_ROUTES = [
  'existing-podium',
  'existing-client',
  'existing-machine',
] as const

export type ExistingPodiumRoute = (typeof EXISTING_PODIUM_ROUTES)[number]

export function isExistingPodiumRoute(route: ActivationRoute): route is ExistingPodiumRoute {
  return (EXISTING_PODIUM_ROUTES as readonly string[]).includes(route)
}

/** Validate with the transport parser and persist the base WebSocket origin it resolved. */
export function normalizeExistingPodiumUrl(value: string): string | null {
  const parsed = parseServerOrigin(value.trim())
  if (!parsed) return null
  return parsed.wsClientUrl.replace(/\/client\?.*$/, '')
}

/**
 * Accept either the raw token consumed by setup.join or the ready-to-paste
 * shell command emitted by MachinePairing. This only reads an argument: the
 * pasted command is never evaluated or interpolated.
 */
export function existingPodiumJoinToken(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!/\s/u.test(trimmed) && !trimmed.startsWith('--join')) return trimmed

  const matches = [
    ...trimmed.matchAll(/(?:^|\s)--join(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s'";]+))/gu),
  ]
  if (matches.length !== 1) return null
  return matches[0]?.[1] ?? matches[0]?.[2] ?? matches[0]?.[3] ?? null
}

function ConnectionError({ error }: { error: string | null }): JSX.Element | null {
  if (!error) return null
  return (
    <p
      role="alert"
      className="rounded-[10px] bg-destructive/[0.08] px-3.5 py-3 text-[12.5px] leading-5 text-destructive shadow-[inset_0_0_0_1px_rgba(210,80,80,.3)]"
    >
      {error}
    </p>
  )
}

function Consequence({ icon, children }: { icon: JSX.Element; children: string }): JSX.Element {
  return (
    <li className="flex gap-[11px] text-[13.5px] leading-[1.5] text-[#b9bec6]">
      <span className="mt-0.5 flex-none text-[#8a9099] [&_svg]:size-[17px]" aria-hidden="true">
        {icon}
      </span>
      <span>{children}</span>
    </li>
  )
}

export function ExistingPodiumActivation({
  route,
  trpc,
  onRouteChange,
  onExplore,
  onConfigured,
}: {
  route: ExistingPodiumRoute
  trpc: Trpc
  onRouteChange: (route: ActivationRoute) => void
  onExplore: () => void
  onConfigured: () => Promise<void>
}): JSX.Element {
  const uiState = useStoreSelector((store) => store.uiState)

  if (route === 'existing-client') {
    return (
      <ExistingClientStep
        trpc={trpc}
        uiState={uiState}
        onBack={() => onRouteChange('existing-podium')}
        onLocalSetup={() => onRouteChange('welcome')}
        onExplore={onExplore}
        onConfigured={onConfigured}
      />
    )
  }

  if (route === 'existing-machine') {
    return (
      <ExistingMachineStep
        trpc={trpc}
        uiState={uiState}
        onBack={() => onRouteChange('existing-podium')}
        onLocalSetup={() => onRouteChange('welcome')}
        onExplore={onExplore}
        onConfigured={onConfigured}
      />
    )
  }

  return (
    <ActivationShell
      eyebrow="Existing Podium"
      title="Use a Podium that already exists elsewhere."
      description="This is only for a Podium server you already run on another computer or VPS. Choose whether this device should simply open it or also contribute its local projects and agents."
      descriptionClassName="max-w-[660px]"
      onExplore={onExplore}
    >
      <div>
        <div className="grid gap-4 md:grid-cols-2">
          <ConnectionChoice
            icon={<Laptop size={17} aria-hidden="true" />}
            title="Open the other Podium"
            description="Use this app as a viewer and controller. The remote Podium keeps all server work; no projects or agents run on this computer."
            action="Use as a client"
            onSelect={() => onRouteChange('existing-client')}
          />
          <ConnectionChoice
            icon={<MonitorUp size={17} aria-hidden="true" />}
            title="Add this computer to it"
            description="Keep the other Podium as the server, but let it use repositories, credentials, and agents on this computer."
            action="Add this machine"
            badge="Shares this machine"
            secondary
            onSelect={() => onRouteChange('existing-machine')}
          />
        </div>
        <button
          type="button"
          onClick={() => onRouteChange('welcome')}
          className="mt-[18px] inline-flex items-center gap-2 text-[13px] leading-none text-[#a8adb6] hover:text-[#f2f3f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e3ba52]"
        >
          <ArrowLeft size={16} className="text-[#6f757f]" aria-hidden="true" />
          Back to activation choices
        </button>
      </div>
    </ActivationShell>
  )
}

function ConnectionChoice({
  icon,
  title,
  description,
  action,
  badge,
  secondary = false,
  onSelect,
}: {
  icon: JSX.Element
  title: string
  description: string
  action: string
  badge?: string
  secondary?: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <article className="flex min-h-[230px] flex-col rounded-[13px] bg-[#1b1e24] p-5 shadow-[inset_0_0_0_1px_#2f343d]">
      <span className="flex size-9 items-center justify-center rounded-[9px] bg-[#22262d] text-[#d7dae0] shadow-[inset_0_0_0_1px_#333842]">
        {icon}
      </span>
      <div className="mt-[18px] flex flex-wrap items-center gap-2.5">
        <h2 className="text-[15px] leading-none font-semibold text-[#f2f3f5]">{title}</h2>
        {badge && (
          <span className="shell-type-micro inline-flex min-h-[19px] items-center rounded-[5px] bg-[#2b2f37] px-2 py-[2px] font-mono tracking-[0.14em] text-[#a8adb6] uppercase">
            {badge}
          </span>
        )}
      </div>
      <p className="mt-2 text-[13px] leading-[1.6] text-[#9ba1ab] text-wrap-pretty">
        {description}
      </p>
      <span className="min-h-5 flex-1" aria-hidden="true" />
      <button
        type="button"
        className={`inline-flex h-[34px] self-start items-center gap-2 rounded-[9px] px-[15px] text-[13px] leading-none font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e3ba52] ${
          secondary
            ? 'text-[#f2f3f5] shadow-[inset_0_0_0_1px_#454b56] hover:bg-white/[0.04]'
            : 'bg-[#e3ba52] text-[#1a1408] hover:bg-[#efc95f]'
        }`}
        onClick={onSelect}
      >
        {action}
        <ArrowRight
          size={16}
          className={secondary ? 'text-[#9ba1ab]' : undefined}
          aria-hidden="true"
        />
      </button>
    </article>
  )
}

function ExistingClientStep({
  trpc,
  uiState,
  onBack,
  onLocalSetup,
  onExplore,
  onConfigured,
}: {
  trpc: Trpc
  uiState: Pick<UiState, 'get' | 'set'>
  onBack: () => void
  onLocalSetup: () => void
  onExplore: () => void
  onConfigured: () => Promise<void>
}): JSX.Element {
  const [serverUrl, setServerUrl] = useState(
    () => uiState.get(EXISTING_PODIUM_CLIENT_DRAFT_KEY) ?? '',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = async (): Promise<void> => {
    const normalized = normalizeExistingPodiumUrl(serverUrl)
    if (!normalized) {
      setError('Enter a Podium URL beginning with http://, https://, ws://, or wss://.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await trpc.setup.connect.mutate({ mode: 'client', serverUrl: normalized })
      uiState.set(EXISTING_PODIUM_CLIENT_DRAFT_KEY, null)
      try {
        await onConfigured()
      } catch {
        setBusy(false)
        setError('Connection saved — quit and reopen Podium to open the remote installation.')
      }
    } catch (cause) {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <ActivationShell
      eyebrow="Existing Podium · Client"
      title="Open your existing Podium here."
      description="This device becomes a client for the remote installation. It no longer hosts separate Podium state, projects, or agents."
      icon={<Laptop aria-hidden="true" />}
      contentClassName="mt-[38px]"
      onExplore={onExplore}
    >
      <div>
        <div className="rounded-[13px] bg-[#1b1e24] p-[22px] shadow-[inset_0_0_0_1px_#2f343d]">
          <label
            htmlFor="existing-podium-url"
            className="text-[13px] leading-none font-semibold text-[#a8adb6]"
          >
            Existing Podium URL
          </label>
          <div className="mt-[11px] flex gap-3 max-sm:flex-col">
            <Input
              id="existing-podium-url"
              className="h-[42px] flex-1 rounded-[10px] border-0 bg-[#15171b] px-3.5 font-mono text-[14px] text-[#e6e8ec] shadow-[inset_0_0_0_1px_#2f343d] placeholder:text-[#6f757f]"
              type="url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              placeholder="https://podium.example.com"
              value={serverUrl}
              disabled={busy}
              onChange={(event) => {
                const value = event.currentTarget.value
                setServerUrl(value)
                uiState.set(EXISTING_PODIUM_CLIENT_DRAFT_KEY, value || null)
                if (error) setError(null)
              }}
            />
            <Button
              type="button"
              className="h-[42px] rounded-[10px] border-0 bg-[#e3ba52] px-4 text-[13.5px] font-semibold text-[#1a1408] hover:bg-[#efc95f]"
              pending={busy}
              pendingLabel="Saving connection…"
              disabled={!serverUrl.trim()}
              onClick={() => void connect()}
            >
              Save and restart
              <ArrowRight size={17} aria-hidden="true" />
            </Button>
          </div>
          <ul className="mt-[18px] flex flex-col gap-[11px] border-t border-[#272b33] pt-4">
            <Consequence icon={<Ban />}>
              No agents run on this device in client-only mode.
            </Consequence>
            <Consequence icon={<LockKeyhole />}>
              If the remote Podium requires a password, it asks you to sign in after the app
              restarts — this URL doesn't bypass its authentication.
            </Consequence>
            <Consequence icon={<History />}>
              Your local activation progress stays available until you confirm the change.
            </Consequence>
          </ul>
        </div>
        <div className="mt-3">
          <ConnectionError error={error} />
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-5">
          <button
            type="button"
            onClick={onBack}
            disabled={busy}
            className="inline-flex items-center gap-2 text-[13px] leading-none text-[#a8adb6] hover:text-[#f2f3f5] disabled:opacity-50"
          >
            <ArrowLeft size={16} className="text-[#6f757f]" aria-hidden="true" />
            Connection options
          </button>
          <button
            type="button"
            onClick={onLocalSetup}
            disabled={busy}
            className="text-[13px] leading-none text-[#a8adb6] hover:text-[#f2f3f5] disabled:opacity-50"
          >
            Back to activation choices
          </button>
        </div>
      </div>
    </ActivationShell>
  )
}

function ExistingMachineStep({
  trpc,
  uiState,
  onBack,
  onLocalSetup,
  onExplore,
  onConfigured,
}: {
  trpc: Trpc
  uiState: Pick<UiState, 'get' | 'set'>
  onBack: () => void
  onLocalSetup: () => void
  onExplore: () => void
  onConfigured: () => Promise<void>
}): JSX.Element {
  const [joinCode, setJoinCode] = useState(
    () => uiState.get(EXISTING_PODIUM_MACHINE_DRAFT_KEY) ?? '',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [machineName, setMachineName] = useState('this machine')

  const restart = async (connectedMachineName = machineName): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onConfigured()
    } catch {
      setBusy(false)
      setError(`${connectedMachineName} is connected — quit and reopen Podium to finish joining.`)
    }
  }

  const join = async (): Promise<void> => {
    const token = existingPodiumJoinToken(joinCode)
    if (!token) {
      setError('Paste a join token or the complete one-line join command.')
      return
    }
    setBusy(true)
    setError(null)
    setWarning(null)
    try {
      const result = await trpc.setup.join.mutate({ code: token })
      uiState.set(EXISTING_PODIUM_MACHINE_DRAFT_KEY, null)
      setMachineName(result.name)
      if (result.warning) {
        setWarning(result.warning)
        setBusy(false)
        return
      }
      await restart(result.name)
    } catch (cause) {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <ActivationShell
      eyebrow="Existing Podium · Machine"
      title="Let your existing Podium use this machine."
      description="A join code points this machine at the remote server and pairs it as a place where projects and agents can run."
      icon={<Network aria-hidden="true" />}
      contentClassName="mt-[38px]"
      onExplore={onExplore}
    >
      <div>
        <div className="rounded-[13px] bg-[#1b1e24] p-[22px] shadow-[inset_0_0_0_1px_#2f343d]">
          <div className="flex items-start gap-3.5">
            <span className="flex size-9 flex-none items-center justify-center rounded-[9px] bg-[#22262d] text-[#e3ba52] shadow-[inset_0_0_0_1px_#333842]">
              <KeyRound size={19} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <label
                htmlFor="existing-podium-join"
                className="text-[15px] leading-none font-semibold text-[#f2f3f5]"
              >
                Join token or command
              </label>
              <p className="mt-1.5 text-[13.5px] leading-[1.5] text-[#9ba1ab]">
                In the existing Podium, open Machines › Add a machine, then paste its one-line code
                here.
              </p>
            </div>
          </div>
          <div className="mt-3.5 flex gap-3 max-sm:flex-col">
            <Input
              id="existing-podium-join"
              className="h-[42px] flex-1 rounded-[10px] border-0 bg-[#15171b] px-3.5 font-mono text-[13.5px] text-[#e6e8ec] shadow-[inset_0_0_0_1px_#2f343d] placeholder:text-[#6f757f]"
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste the join token or one-line command"
              value={joinCode}
              disabled={busy || warning !== null}
              onChange={(event) => {
                const value = event.currentTarget.value
                setJoinCode(value)
                uiState.set(EXISTING_PODIUM_MACHINE_DRAFT_KEY, value || null)
                if (error) setError(null)
              }}
            />
            {warning ? (
              <Button
                type="button"
                className="h-[42px] rounded-[10px] px-4"
                pending={busy}
                pendingLabel="Restarting…"
                onClick={() => void restart()}
              >
                Continue anyway
              </Button>
            ) : (
              <Button
                type="button"
                className="h-[42px] rounded-[10px] border-0 bg-[#e3ba52] px-4 text-[13.5px] font-semibold text-[#1a1408] hover:bg-[#efc95f]"
                pending={busy}
                pendingLabel="Joining machine…"
                disabled={!joinCode.trim()}
                onClick={() => void join()}
              >
                Join and restart
                <ArrowRight size={17} aria-hidden="true" />
              </Button>
            )}
          </div>
          <ul className="mt-[18px] flex flex-col gap-[11px] border-t border-[#272b33] pt-4">
            <Consequence icon={<Timer />}>
              The code is a short-lived, single-use machine credential — not your Podium login
              password.
            </Consequence>
            <Consequence icon={<Repeat2 />}>
              This machine stops hosting separate Podium state and instead runs projects and agents
              for the existing installation.
            </Consequence>
            <Consequence icon={<Shield />}>
              A managed join may copy the remote installation’s configured agent credentials; human
              access still follows its normal login screen after restart.
            </Consequence>
          </ul>
        </div>
        {warning && (
          <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2" role="alert">
            <p className="settings-label text-warning">Connection saved with a temporary URL</p>
            <p className="settings-prose mt-1">{warning}</p>
          </div>
        )}
        <div className="mt-3">
          <ConnectionError error={error} />
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-5">
          <button
            type="button"
            onClick={onBack}
            disabled={busy}
            className="inline-flex items-center gap-2 text-[13px] leading-none text-[#a8adb6] hover:text-[#f2f3f5] disabled:opacity-50"
          >
            <ArrowLeft size={16} className="text-[#6f757f]" aria-hidden="true" />
            Connection options
          </button>
          <button
            type="button"
            onClick={onLocalSetup}
            disabled={busy}
            className="text-[13px] leading-none text-[#a8adb6] hover:text-[#f2f3f5] disabled:opacity-50"
          >
            Back to activation choices
          </button>
        </div>
      </div>
    </ActivationShell>
  )
}
