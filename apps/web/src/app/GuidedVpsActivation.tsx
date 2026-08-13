import { shallowEqual } from '@podium/client-core/store'
import type { MachineWire } from '@podium/model'
import { ArrowLeft, ArrowRight, ExternalLink, Server } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStoreSelector } from '@/app/store'
import { Button } from '@/components/ui/button'
import { MachinePairing } from '@/features/machines/MachinePairing'
import { useMachinePairing } from '@/features/machines/machine-pairing'
import { ServerTransfer, ServerTransferProgress } from '@/features/machines/ServerTransfer'
import {
  transferErrorMessage,
  useServerTransfer,
  useServerTransferStatus,
  type ServerTransferStatusController,
} from '@/features/machines/server-transfer'
import { ActivationShell } from '@/features/setup/ActivationShell'
import type { ActivationRoute } from '@/features/setup/activation-route'
import { NetworkStep } from '@/features/setup/SetupView'
import {
  startAfterVpsPersistence,
  type ConfirmedVpsActivation,
} from '@/features/setup/use-vps-activation'
import {
  isDestinationOrigin,
  type VpsActivationState,
  vpsDestinationUrl,
  vpsIntroState,
  vpsPairingState,
  vpsTransferState,
} from '@/features/setup/vps-activation'

function runSafely(operation: Promise<unknown>): void {
  void operation.catch(() => {})
}

export async function clearVpsCheckpointAndReturn(
  vps: Pick<ConfirmedVpsActivation, 'clear'>,
  returnRoute: VpsActivationState['returnRoute'],
  onRouteChange: (route: ActivationRoute) => void,
): Promise<void> {
  // Clearing is the navigation fence: do not leave this flow until the server has confirmed that
  // the durable checkpoint is gone, otherwise a reload could unexpectedly resume VPS setup.
  await vps.clear()
  onRouteChange(returnRoute)
}

function returnActionLabel(returnRoute: VpsActivationState['returnRoute']): string {
  return returnRoute === 'welcome' ? 'Back to welcome' : 'Back to local setup'
}

export function GuidedVpsActivation({
  route,
  vps,
  onRouteChange,
  onExplore,
}: {
  route: ActivationRoute
  vps: ConfirmedVpsActivation
  onRouteChange: (route: ActivationRoute) => void
  onExplore: () => void
}): JSX.Element {
  const { machines, trpc } = useStoreSelector(
    (store) => ({ machines: store.machines, trpc: store.trpc }),
    shallowEqual,
  )
  const status = useServerTransferStatus(trpc)
  const eligibleTargets = useMemo(
    () =>
      new Set(
        status.snapshot?.targetEligibility
          .filter((target) => target.eligible)
          .map((target) => target.targetMachineId) ?? [],
      ),
    [status.snapshot?.targetEligibility],
  )
  const pairing = useMachinePairing({
    trpc,
    machines,
  })
  const pairingRef = useRef(pairing)
  pairingRef.current = pairing
  const vpsStateRef = useRef(vps.state)
  vpsStateRef.current = vps.state
  const pairingBaseline = vps.state?.baselineMachineIds.join('\u0000') ?? ''
  const [makeServerAfterPair, setMakeServerAfterPair] = useState(
    () => vps.state?.moveServer ?? true,
  )
  const [showNetwork, setShowNetwork] = useState(false)

  // Pairing credentials are intentionally ephemeral. Re-mint on mount, but keep using the
  // durable pre-pairing machine baseline so a machine connected during downtime is detected.
  useEffect(() => {
    const state = vpsStateRef.current
    if (route !== 'vps-pairing' || !state) return
    const controller = pairingRef.current
    controller.watchForNewMachine(new Set(state.baselineMachineIds))
    void controller.mint()
    return () => controller.stopWatchingForNewMachine()
    // The baseline string is the durable identity of this pairing attempt.
  }, [pairingBaseline, route])

  useEffect(() => {
    if (route === 'vps-pairing' && vps.state) setMakeServerAfterPair(vps.state.moveServer)
  }, [route, vps.state])

  const finishDaemonOnly = async (): Promise<void> => {
    const returnRoute = vps.state?.returnRoute
    if (!returnRoute) return
    await vps.clear()
    pairing.reset()
    onRouteChange(returnRoute)
  }

  if (!vps.ready || !vps.state) {
    const beginFreshSetup = async (): Promise<void> => {
      const next = vpsIntroState('welcome')
      await vps.persist(next)
      onRouteChange(next.route)
    }
    return (
      <ActivationShell
        eyebrow="Always-on Podium"
        title="Set up an always-on VPS."
        description="You will get one secure command to run on a new VPS. Once it connects, Podium can move its shared server state there while your projects, credentials, and agents stay on their own machines."
        onExplore={onExplore}
      >
        <div className="max-w-[640px] space-y-4">
          <div className="rounded-xl border border-primary/30 bg-primary/[0.06] p-4">
            <h2 className="text-sm font-semibold text-foreground">What you need</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[12.5px] leading-5 text-muted-foreground">
              <li>A fresh Linux VPS you can access over SSH.</li>
              <li>Permission to install and run Podium on that VPS.</li>
              <li>About five minutes; no project or agent credentials are transferred.</li>
            </ul>
            <Button
              type="button"
              className="mt-4"
              disabled={!vps.ready || vps.saving}
              pending={vps.saving}
              pendingLabel="Preparing setup…"
              onClick={() => runSafely(beginFreshSetup())}
            >
              Show VPS setup
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Button>
          </div>
          <Button type="button" variant="outline" onClick={() => onRouteChange('welcome')}>
            <ArrowLeft aria-hidden="true" />
            Back to activation
          </Button>
        </div>
        <PersistError error={vps.error} />
      </ActivationShell>
    )
  }
  const returnRoute = vps.state.returnRoute

  if (route === 'vps-intro') {
    const startPairing = async (moveServer: boolean): Promise<void> => {
      const next = vpsPairingState(
        vps.state as VpsActivationState,
        vps.state?.baselineMachineIds.length
          ? vps.state.baselineMachineIds
          : machines.map((machine) => machine.id),
        moveServer,
      )
      await vps.persist(next)
      onRouteChange(next.route)
    }
    return (
      <ActivationShell
        eyebrow="Always-on Podium"
        title="Give Podium a home that stays online."
        description="Pair an inexpensive VPS, then move only Podium's shared server state there. Projects, native credentials, and running agents remain on their machines."
        onExplore={onExplore}
      >
        <div className="max-w-[640px] space-y-4">
          <div className="rounded-xl border border-primary/30 bg-primary/[0.06] p-4">
            <div className="flex items-start gap-3">
              <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Server size={17} aria-hidden="true" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  Recommended: move the server to the VPS
                </h2>
                <p className="mt-1 text-[12.5px] leading-5 text-muted-foreground">
                  This computer reconnects as a daemon after a proof-backed transfer, so its
                  projects and agent sessions stay available without hosting shared state.
                </p>
              </div>
            </div>
            <Button
              type="button"
              className="mt-4"
              pending={vps.saving}
              pendingLabel="Saving setup…"
              onClick={() => runSafely(startPairing(true))}
            >
              Pair an always-on VPS
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Button>
          </div>
          <div className="rounded-lg border border-border/70 px-4 py-3">
            <p className="settings-label">Advanced: use the VPS as a worker</p>
            <p className="settings-prose mt-1">
              Pair the VPS for agents and projects while leaving this computer as the server.
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2"
              disabled={vps.saving}
              onClick={() => runSafely(startPairing(false))}
            >
              Pair as a worker
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Button>
          </div>
          <div className="border-t border-border/70 pt-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={vps.saving}
              onClick={() =>
                runSafely(clearVpsCheckpointAndReturn(vps, returnRoute, onRouteChange))
              }
            >
              <ArrowLeft data-icon="inline-start" aria-hidden="true" />
              {returnActionLabel(returnRoute)}
            </Button>
          </div>
          <PersistError error={vps.error} />
        </div>
      </ActivationShell>
    )
  }

  if (route === 'vps-transfer' && vps.state.target) {
    return (
      <VpsTransferStep
        state={
          vps.state as VpsActivationState & { target: NonNullable<VpsActivationState['target']> }
        }
        machines={machines}
        status={status}
        vps={vps}
        onRouteChange={onRouteChange}
        onExplore={onExplore}
      />
    )
  }

  const pairedMachine = pairing.newMachine
  const pairedEligibility = pairedMachine
    ? status.snapshot?.targetEligibility.find(
        (target) => target.targetMachineId === pairedMachine.id,
      )
    : undefined
  const reviewTransfer = async (): Promise<void> => {
    if (!pairedMachine) return
    const next = vpsTransferState(vps.state as VpsActivationState, {
      machineId: pairedMachine.id,
      name: pairedMachine.name,
    })
    await vps.persist(next)
    onRouteChange(next.route)
  }
  const retryPairing = (): void => {
    pairing.watchForNewMachine(new Set(vps.state?.baselineMachineIds ?? []))
    void pairing.mint({ podiumManaged: pairing.podiumManaged })
  }
  const changeMoveServer = async (value: boolean): Promise<void> => {
    const previous = makeServerAfterPair
    setMakeServerAfterPair(value)
    try {
      await vps.persist({
        ...(vps.state as VpsActivationState),
        moveServer: value,
      })
    } catch (cause) {
      setMakeServerAfterPair(previous)
      throw cause
    }
  }

  return (
    <ActivationShell
      eyebrow="Pair the VPS"
      title="Run one command on your always-on machine."
      description="Podium will detect the new daemon live. The pairing command expires, so a reload safely creates a fresh one while retaining the original machine baseline."
      onExplore={onExplore}
    >
      <div className="max-w-[700px] space-y-4">
        <MachinePairing
          pairingCode={pairing.pairingCode}
          joinCommand={pairing.joinCommand}
          publicUrl={pairing.publicUrl}
          loading={pairing.loading}
          error={pairing.error}
          podiumManaged={pairing.podiumManaged}
          recommendServer
          makeServerAfterPair={makeServerAfterPair}
          newMachine={
            makeServerAfterPair && pairedMachine && eligibleTargets.has(pairedMachine.id)
              ? pairedMachine
              : null
          }
          onManagedChange={(managed) => void pairing.mint({ podiumManaged: managed })}
          onMakeServerAfterPairChange={(value) => runSafely(changeMoveServer(value))}
          onChangeUrl={() => setShowNetwork(true)}
          onReviewPairedMachine={() => runSafely(reviewTransfer())}
        />

        {(showNetwork || (pairing.pairingCode && !pairing.joinCommand)) && (
          <div className="rounded-xl border border-border bg-background/55 p-4">
            <h2 className="settings-h">Make this server reachable first</h2>
            <p className="settings-prose mt-1 mb-4">
              The current Podium server needs a reachable URL so it can create a working VPS join
              command. You will confirm the VPS destination URL separately before transfer.
            </p>
            <NetworkStep
              embedded
              trpc={trpc}
              onSaved={() => {
                setShowNetwork(false)
                retryPairing()
              }}
            />
          </div>
        )}

        {pairing.error && !pairing.loading && (
          <Button type="button" variant="outline" size="sm" onClick={retryPairing}>
            Create a new pairing command
          </Button>
        )}

        {pairedMachine && !makeServerAfterPair && (
          <div className="rounded-lg border border-border px-4 py-3">
            <p className="settings-label">{pairedMachine.name} is paired as a daemon</p>
            <p className="settings-prose mt-1">
              Advanced mode keeps the current machine as the server and returns you to the
              activation step where you started.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={vps.saving}
              onClick={() => runSafely(finishDaemonOnly())}
            >
              Keep the current server
            </Button>
          </div>
        )}

        {pairedMachine && makeServerAfterPair && pairedEligibility?.eligible === false && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
            <p className="settings-label text-warning">
              {pairedMachine.name} is paired, but cannot receive the server yet
            </p>
            <p className="settings-prose mt-1">
              {pairedEligibility.reason === 'offline'
                ? 'Bring the VPS daemon back online to continue, or keep it as a daemon for now.'
                : 'This daemon does not support server transfer. You can still keep it paired for agents.'}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={vps.saving}
              onClick={() => runSafely(finishDaemonOnly())}
            >
              Keep it as a daemon
            </Button>
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t border-border/70 pt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={vps.saving}
            onClick={() =>
              runSafely(
                (async () => {
                  const next: VpsActivationState = {
                    ...(vps.state as VpsActivationState),
                    route: 'vps-intro',
                  }
                  await vps.persist(next)
                  onRouteChange(next.route)
                })(),
              )
            }
          >
            <ArrowLeft data-icon="inline-start" aria-hidden="true" />
            VPS overview
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={vps.saving}
            onClick={() => runSafely(clearVpsCheckpointAndReturn(vps, returnRoute, onRouteChange))}
          >
            {returnActionLabel(returnRoute)}
          </Button>
        </div>
        <PersistError error={vps.error ?? status.error} />
      </div>
    </ActivationShell>
  )
}

function VpsTransferStep({
  state,
  machines,
  status,
  vps,
  onRouteChange,
  onExplore,
}: {
  state: VpsActivationState & { target: NonNullable<VpsActivationState['target']> }
  machines: readonly MachineWire[]
  status: ServerTransferStatusController
  vps: ConfirmedVpsActivation
  onRouteChange: (route: ActivationRoute) => void
  onExplore: () => void
}): JSX.Element {
  const trpc = useStoreSelector((store) => store.trpc)
  const target = machines.find((machine) => machine.id === state.target.machineId) ?? state.target
  const sourceName =
    machines.find((machine) => machine.id === status.snapshot?.sourceMachineId)?.name ??
    'the current server'
  const transfer = useServerTransfer({
    trpc,
    targetMachineId: state.target.machineId,
    status,
  })
  const [reviewOpen, setReviewOpen] = useState(true)
  const durableUrl = transfer.transfer?.publicUrl ?? state.target.publicUrl ?? ''
  const destinationUrl = vpsDestinationUrl(durableUrl)
  const onDestination = durableUrl ? isDestinationOrigin(durableUrl, window.location.origin) : false
  const targetEligible =
    status.snapshot?.targetEligibility.find(
      (candidate) => candidate.targetMachineId === state.target.machineId,
    )?.eligible === true

  useEffect(() => {
    if (
      state.target.publicUrl &&
      !transfer.publicUrl &&
      (!transfer.transfer || transfer.displayState === 'aborted')
    ) {
      transfer.setPublicUrl(state.target.publicUrl)
    }
  }, [
    state.target.publicUrl,
    transfer.displayState,
    transfer.publicUrl,
    transfer.setPublicUrl,
    transfer.transfer,
  ])

  useEffect(() => {
    if (transfer.displayState === 'switching' || transfer.displayState === 'connected') {
      setReviewOpen(false)
    }
  }, [transfer.displayState])

  const start = async (): Promise<void> => {
    const next = vpsTransferState(state, {
      machineId: state.target.machineId,
      name: state.target.name,
      publicUrl: transfer.publicUrl.trim(),
    })
    // This awaited authoritative layout snapshot is the transfer boundary: the destination's
    // copied podium.db must contain enough information to reconstruct activation before cutover.
    await startAfterVpsPersistence(async () => {
      await vps.persist(next)
      // Reveal the durable destination before cutover can disconnect this source origin.
      setReviewOpen(false)
    }, transfer.start)
  }

  const finishOnDestination = async (): Promise<void> => {
    await clearVpsCheckpointAndReturn(vps, state.returnRoute, onRouteChange)
  }

  const abandonBeforeTransfer = async (): Promise<void> => {
    await clearVpsCheckpointAndReturn(vps, state.returnRoute, onRouteChange)
  }

  const returnToPairing = async (): Promise<void> => {
    const next: VpsActivationState = { ...state, route: 'vps-pairing', target: undefined }
    await vps.persist(next)
    onRouteChange(next.route)
  }

  const progressState = transfer.displayState ?? 'preparing'
  const detail = transferErrorMessage(transfer.transfer)
  const cutoverStarted =
    transfer.showProgress ||
    transfer.displayState === 'preparing' ||
    transfer.displayState === 'copying' ||
    transfer.displayState === 'validating' ||
    transfer.displayState === 'switching' ||
    transfer.displayState === 'connected' ||
    transfer.displayState === 'commit-uncertain'

  return (
    <ActivationShell
      eyebrow="Move the Podium server"
      title={`Make ${target.name} the always-on server.`}
      description="The transfer is journalled and proof-backed. Shared state moves; projects, credentials, and running agents stay where they are."
      onExplore={onExplore}
    >
      <div className="max-w-[700px] space-y-4">
        {(transfer.showProgress || transfer.displayState === 'aborted') && (
          <div className="rounded-xl border border-border bg-background/55 p-4">
            <ServerTransferProgress
              state={progressState}
              targetName={target.name}
              detail={detail}
            />
          </div>
        )}

        {transfer.displayState === 'connected' && onDestination && (
          <div className="rounded-xl border border-success/30 bg-success/5 p-4">
            <h2 className="settings-h">The VPS is now your Podium server</h2>
            <p className="settings-prose mt-1">
              Continue where you left activation. This VPS stays available while your other machines
              run agents.
            </p>
            <Button
              type="button"
              className="mt-3"
              pending={vps.saving}
              pendingLabel="Finishing activation…"
              onClick={() => runSafely(finishOnDestination())}
            >
              {state.returnRoute === 'welcome' ? 'Continue activation' : 'Continue with a project'}
              <ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Button>
          </div>
        )}

        {!onDestination && destinationUrl && (
          <div className="rounded-xl border border-primary/30 bg-primary/[0.06] p-4">
            <h2 className="settings-h">Continue on {target.name}</h2>
            <p className="settings-prose mt-1">
              Keep this recovery address available before starting the move. Once cutover begins,
              open it in this tab; a browser may ask you to sign in there before Podium resumes this
              exact transfer route.
            </p>
            <code className="mt-3 block overflow-x-auto rounded-md border bg-muted px-2.5 py-2 font-mono text-[12px] text-muted-foreground">
              {destinationUrl}
            </code>
            {cutoverStarted ? (
              <Button className="mt-3" render={<a href={destinationUrl} />}>
                Open the VPS
                <ExternalLink data-icon="inline-end" aria-hidden="true" />
              </Button>
            ) : (
              <p className="settings-micro mt-2">The link activates when transfer starts.</p>
            )}
          </div>
        )}

        {!cutoverStarted && transfer.displayState !== 'connected' && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => setReviewOpen(true)}>
              {transfer.displayState === 'aborted' ? 'Review and retry' : 'Review server transfer'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={vps.saving}
              onClick={() => runSafely(returnToPairing())}
            >
              <ArrowLeft data-icon="inline-start" aria-hidden="true" />
              Back to pairing
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={vps.saving}
              onClick={() => runSafely(abandonBeforeTransfer())}
            >
              {returnActionLabel(state.returnRoute)}
            </Button>
          </div>
        )}

        {transfer.showProgress && transfer.displayState !== 'connected' && (
          <Button type="button" variant="outline" size="sm" onClick={() => setReviewOpen(true)}>
            View transfer details
          </Button>
        )}

        <PersistError error={vps.error ?? transfer.error ?? status.error} />
      </div>

      <ServerTransfer
        open={reviewOpen}
        targetName={target.name}
        sourceName={sourceName}
        publicUrl={transfer.publicUrl}
        confirmation={transfer.confirmation}
        displayState={transfer.displayState}
        detail={detail}
        error={vps.error ?? transfer.error ?? status.error}
        awaitingStatus={vps.saving || transfer.awaitingStatus}
        checkingTarget={transfer.checkingTarget}
        showProgress={transfer.showProgress}
        urlIsValid={transfer.urlIsValid}
        canStart={transfer.canStart && targetEligible && !vps.saving}
        onOpenChange={setReviewOpen}
        onPublicUrlChange={transfer.setPublicUrl}
        onConfirmationChange={transfer.setConfirmation}
        onStart={() => runSafely(start())}
        onCheckTarget={() => void transfer.checkTarget()}
      />
    </ActivationShell>
  )
}

function PersistError({ error }: { error: string | null | undefined }): JSX.Element | null {
  return error ? (
    <p role="alert" className="settings-prose text-destructive">
      {error}
    </p>
  ) : null
}
