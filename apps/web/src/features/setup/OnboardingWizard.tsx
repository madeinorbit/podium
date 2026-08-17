import { Laptop, Link2, Server, Terminal } from 'lucide-react'
import type { JSX } from 'react'
import type { Trpc } from '@/app/trpc'
import {
  ActivationBack,
  ActivationChoice,
  ActivationChoiceNote,
  ActivationShell,
} from './ActivationShell'
import type { ActivationRoute } from './activation-route'
import { ExistingPodiumActivation, isExistingPodiumRoute } from './ExistingPodiumActivation'
import { FirstTaskActivation } from './FirstTaskActivation'
import { RepoScanFlow } from './RepoScanFlow'
import type { ConfirmedVpsActivation } from './use-vps-activation'
import { VpsFirstActivation } from './VpsFirstActivation'
import { isVpsActivationRoute } from './vps-activation'

/**
 * First-run setup, and while it runs, the only thing in the window. The route
 * belongs to the caller so AppShell can persist it independently of any step
 * implementation.
 *
 * Every screen asks ONE question with TWO answers (POD-1174). The first asks
 * where Podium runs; the VPS answer asks whether the server already has Podium
 * on it. Connecting to an existing installation used to be a third option on the
 * first screen, where it read as a peer choice to people who had nothing to
 * connect to yet.
 */
export function OnboardingWizard({
  route,
  onRouteChange,
  onComplete,
  onConnectionConfigured,
  onEnterVps,
  trpc,
  vps,
}: {
  route: ActivationRoute
  onRouteChange: (route: ActivationRoute) => void
  onComplete: () => void
  onConnectionConfigured: () => Promise<void>
  onEnterVps: () => Promise<void>
  trpc: Trpc
  vps: ConfirmedVpsActivation
}): JSX.Element {
  if (isExistingPodiumRoute(route)) {
    return (
      <ExistingPodiumActivation
        route={route}
        trpc={trpc}
        onRouteChange={onRouteChange}
        onConfigured={onConnectionConfigured}
      />
    )
  }

  if (isVpsActivationRoute(route)) {
    return (
      <VpsFirstActivation
        trpc={trpc}
        vps={vps}
        onRouteChange={onRouteChange}
        onConfigured={onConnectionConfigured}
      />
    )
  }

  if (route === 'agent' || route === 'first-task') {
    return (
      <FirstTaskActivation route={route} onRouteChange={onRouteChange} onComplete={onComplete} />
    )
  }

  if (route === 'local-project') {
    return (
      <RepoScanFlow
        onboarding
        onClose={() => onRouteChange('welcome')}
        onDone={() => onRouteChange('agent')}
      />
    )
  }

  if (route === 'vps-choice') {
    return (
      <ActivationShell
        eyebrow="Set up Podium · VPS"
        title="Is Podium already on your VPS?"
        description="If it isn’t, one command puts it there. If it is, this app connects to it instead."
        icon={<Server aria-hidden="true" />}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <ActivationChoice
            primary
            icon={<Terminal aria-hidden="true" />}
            title="No — set it up now"
            badge="Guided"
            badgeLit
            description="Paste one command into your server over SSH. It installs Podium and the agents, then asks for a URL and a password."
            action="Set up my VPS"
            onSelect={() => void onEnterVps().catch(() => {})}
          />
          <ActivationChoice
            icon={<Link2 aria-hidden="true" />}
            title="Yes — it’s running"
            description="Podium is already installed on a server or another computer. Connect this app to it."
            action="Connect to it"
            onSelect={() => onRouteChange('existing-podium')}
          />
        </div>
        <div className="mt-[18px]">
          <ActivationBack onBack={() => onRouteChange('welcome')} />
        </div>
        {vps.error && (
          <p role="alert" className="settings-prose mt-3 text-destructive">
            {vps.error}
          </p>
        )}
      </ActivationShell>
    )
  }

  return (
    <ActivationShell
      eyebrow="Set up Podium"
      title="Where should Podium run?"
      description="Podium keeps your agents working. Pick the computer it lives on — you can move it later."
      descriptionClassName="max-w-[640px]"
    >
      <div className="grid gap-4 md:grid-cols-2">
        <ActivationChoice
          primary
          icon={<Laptop aria-hidden="true" />}
          title="Work locally"
          badge="Simplest"
          badgeLit
          description="Podium runs on this computer. Point it at a project and start — there is nothing else to set up."
          action="Pick a project"
          note={
            <ActivationChoiceNote>
              Moving to a VPS later means starting fresh there: your projects, tasks and history
              can’t move across yet. Carrying them over is coming.
            </ActivationChoiceNote>
          }
          onSelect={() => onRouteChange('local-project')}
        />
        <ActivationChoice
          icon={<Server aria-hidden="true" />}
          title="Work on my VPS"
          badge="Always on"
          description="Podium runs on your own server. Agents keep going after you shut the laptop, and you can reach them from any device."
          action="Continue"
          onSelect={() => onRouteChange('vps-choice')}
        />
      </div>
    </ActivationShell>
  )
}
