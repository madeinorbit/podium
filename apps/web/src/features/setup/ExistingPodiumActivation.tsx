import {
  EXISTING_PODIUM_CLIENT_DRAFT_KEY,
  EXISTING_PODIUM_MACHINE_DRAFT_KEY,
  type UiState,
} from '@podium/client-core/ui-state'
import { ArrowLeft, ArrowRight, Laptop, MonitorUp, Network } from 'lucide-react'
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
    <p role="alert" className="settings-prose text-destructive">
      {error}
    </p>
  )
}

function Consequence({ children }: { children: string }): JSX.Element {
  return (
    <li className="flex gap-2 text-[12.5px] leading-5 text-muted-foreground">
      <span className="mt-[7px] size-1.5 flex-none rounded-full bg-primary/70" aria-hidden="true" />
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
        onLocalSetup={() => onRouteChange('local-project')}
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
        onLocalSetup={() => onRouteChange('local-project')}
        onExplore={onExplore}
        onConfigured={onConfigured}
      />
    )
  }

  return (
    <ActivationShell
      eyebrow="Existing Podium"
      title="Connect to a Podium you already run."
      description="Choose whether this device only opens the remote installation or also contributes its projects and agents. Your local setup route stays ready if you go back."
      onExplore={onExplore}
    >
      <div className="max-w-[720px] space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <ConnectionChoice
            icon={<Laptop size={17} aria-hidden="true" />}
            title="Just open it on this device"
            description="Use this app as a client for the existing Podium. No projects or agents run on this machine."
            action="Connect as a client"
            onSelect={() => onRouteChange('existing-client')}
          />
          <ConnectionChoice
            icon={<MonitorUp size={17} aria-hidden="true" />}
            title="Use this machine too"
            description="Join this machine so the existing Podium can run projects and agents here."
            action="Join as a machine"
            onSelect={() => onRouteChange('existing-machine')}
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onRouteChange('local-project')}
        >
          <ArrowLeft data-icon="inline-start" aria-hidden="true" />
          Back to local setup
        </Button>
      </div>
    </ActivationShell>
  )
}

function ConnectionChoice({
  icon,
  title,
  description,
  action,
  onSelect,
}: {
  icon: JSX.Element
  title: string
  description: string
  action: string
  onSelect: () => void
}): JSX.Element {
  return (
    <article className="rounded-xl border border-border bg-background/55 p-4 shadow-sm">
      <span className="flex size-9 items-center justify-center rounded-lg bg-secondary text-foreground">
        {icon}
      </span>
      <h2 className="mt-3 text-[14px] font-semibold text-foreground">{title}</h2>
      <p className="mt-1 text-[12.5px] leading-5 text-muted-foreground">{description}</p>
      <Button type="button" className="mt-4" onClick={onSelect}>
        {action}
        <ArrowRight data-icon="inline-end" aria-hidden="true" />
      </Button>
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
      description="This device becomes a client for the remote installation. It will no longer host separate Podium state, projects, or agents."
      onExplore={onExplore}
    >
      <div className="max-w-[620px] space-y-5">
        <div className="rounded-xl border border-border bg-background/55 p-4">
          <label htmlFor="existing-podium-url" className="text-[13px] font-medium text-foreground">
            Existing Podium URL
          </label>
          <Input
            id="existing-podium-url"
            className="mt-2"
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
          <ul className="mt-4 space-y-2">
            <Consequence>No agents run on this device in client-only mode.</Consequence>
            <Consequence>
              If the remote Podium requires a password, it asks you to sign in after the app
              restarts; this URL does not bypass its authentication.
            </Consequence>
            <Consequence>
              Existing local activation progress remains available until you confirm this change.
            </Consequence>
          </ul>
        </div>
        <ConnectionError error={error} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
            <ArrowLeft data-icon="inline-start" aria-hidden="true" />
            Connection options
          </Button>
          <Button
            type="button"
            pending={busy}
            pendingLabel="Saving connection…"
            disabled={!serverUrl.trim()}
            onClick={() => void connect()}
          >
            Save and restart
          </Button>
          <Button type="button" variant="link" onClick={onLocalSetup} disabled={busy}>
            Back to local setup
          </Button>
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
      onExplore={onExplore}
    >
      <div className="max-w-[620px] space-y-5">
        <div className="rounded-xl border border-border bg-background/55 p-4">
          <div className="flex items-start gap-3">
            <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Network size={17} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <label
                htmlFor="existing-podium-join"
                className="text-[13px] font-medium text-foreground"
              >
                Join token or command
              </label>
              <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                In the existing Podium, open Machines, add a machine, and paste its one-line code
                here.
              </p>
            </div>
          </div>
          <Input
            id="existing-podium-join"
            className="mt-3 font-mono"
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
          <ul className="mt-4 space-y-2">
            <Consequence>
              The code is a short-lived, single-use machine credential; it is not your Podium login
              password.
            </Consequence>
            <Consequence>
              This machine stops hosting separate Podium state and instead runs projects and agents
              for the existing installation.
            </Consequence>
            <Consequence>
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
        <ConnectionError error={error} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
            <ArrowLeft data-icon="inline-start" aria-hidden="true" />
            Connection options
          </Button>
          {warning ? (
            <Button
              type="button"
              pending={busy}
              pendingLabel="Restarting…"
              onClick={() => void restart()}
            >
              Continue anyway
            </Button>
          ) : (
            <Button
              type="button"
              pending={busy}
              pendingLabel="Joining machine…"
              disabled={!joinCode.trim()}
              onClick={() => void join()}
            >
              Join and restart
            </Button>
          )}
          <Button type="button" variant="link" onClick={onLocalSetup} disabled={busy}>
            Back to local setup
          </Button>
        </div>
      </div>
    </ActivationShell>
  )
}
