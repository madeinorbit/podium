import { useCommands } from '@podium/client-core/react'
import type { MachineModel } from '@podium/client-graph'
import { observer } from '@podium/client-graph/react'
import { machineWrites } from '@podium/commands/fleet-synced'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFleetConvergence } from '@/app/MachinesPanel'
import { Button } from '@/components/ui/button'
import { RepoScanFlow } from '@/features/setup/RepoScanFlow'
import { MachineFailureReason } from '@/features/updates/MachineFailureReason'
import { formatDisplayedVersion, machineVersionSkew } from '@/lib/machine-version-skew'
import { nativeDesktopBridge } from '@/lib/nativeDesktop'
import { useServerAppVersion } from '@/lib/version-skew'
import { MachineCustody } from './machine-custody'
import { useEnableHosting } from './machine-hosting'
import { MachineCustodianName, MachineStatus } from './machine-list'
import { MachineProjects } from './machine-projects'
import { MachineRemove } from './machine-remove'
import { SettingsMachine } from './machine-view'
import { useSettingsMachine } from './readers'
import { harnessAgentLabel, Row, Section, TextRow } from './sections/shared'
import { useSettingsFrame } from './settings-frame'
import { useSettingsClient } from './stable-access'

export const MachineDetail = observer(function MachineDetail({ machineId }: { machineId: string }) {
  const machine = useSettingsMachine(machineId)
  return machine ? (
    <MachineDetailRecord machine={machine} />
  ) : (
    <p className="settings-prose" role="status">
      This machine is no longer available to you.
    </p>
  )
})

const MachineDetailRecord = observer(function MachineDetailRecord({
  machine,
}: {
  machine: MachineModel
}) {
  const { trpc, setSettingsTab } = useSettingsClient()
  const deviceHosting = useEnableHosting(trpc)
  const hosting = nativeDesktopBridge()?.machineId === machine.id ? deviceHosting : null
  const { closeTakeover } = useSettingsFrame()
  const { rename } = useCommands().machines
  const view = useMemo(() => new SettingsMachine(machine), [machine])
  const replacement = useSettingsMachine(machine.supersededBy ?? null)
  const serverAppVersion = useServerAppVersion(trpc)
  const convergence = useFleetConvergence()
  const update = convergence.rows.get(machine.id) ?? null
  const skew = machineVersionSkew(
    machine,
    serverAppVersion,
    update?.reason ? 'rejected' : (update?.state ?? null),
  )
  const [findingRepos, setFindingRepos] = useState(false)
  const findButton = useRef<HTMLButtonElement | null>(null)
  const restoreFindFocus = useRef(false)
  useEffect(() => {
    if (findingRepos || !restoreFindFocus.current) return
    restoreFindFocus.current = false
    findButton.current?.focus({ preventScroll: true })
  }, [findingRepos])
  const closeRepositories = () => {
    restoreFindFocus.current = true
    setFindingRepos(false)
  }
  const [adopting, setAdopting] = useState(false)
  const [adoptError, setAdoptError] = useState<string | null>(null)

  if (findingRepos)
    return (
      <RepoScanFlow
        embedded
        initialMachineId={machine.id}
        onClose={closeRepositories}
        onDone={closeRepositories}
      />
    )

  return (
    <>
      {machine.unowned === true && (
        <div className="mb-5 rounded-lg border border-warning/30 bg-warning/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="settings-prose min-w-0 flex-1">
              <strong className="font-medium text-foreground">
                Nobody looks after this machine
              </strong>
              , so no agents can run on it. Its last owner was removed.
            </p>
            {machine.adoptable === true && (
              <Button
                type="button"
                size="sm"
                disabled={adopting}
                onClick={() => {
                  if (machine.unowned !== true || machine.adoptable !== true) return
                  setAdopting(true)
                  setAdoptError(null)
                  void machineWrites(trpc)
                    .adopt.mutate({ id: machine.id })
                    .catch((error: unknown) =>
                      setAdoptError(error instanceof Error ? error.message : String(error)),
                    )
                    .finally(() => setAdopting(false))
                }}
              >
                {adopting ? 'Adopting…' : 'Adopt it'}
              </Button>
            )}
          </div>
          {adoptError && (
            <p className="settings-prose mt-2 text-destructive" role="alert">
              {adoptError}
            </p>
          )}
        </div>
      )}
      {!view.canManage && machine.unowned !== true && !machine.revokedAt && (
        <p className="settings-prose mb-3">
          Only the person who looks after this machine or an admin can change it.
        </p>
      )}
      <Section>
        <TextRow
          label="Name"
          description="A name you can recognise in the workspace."
          value={machine.name}
          readOnly={!view.canManage}
          onChange={async (name) => {
            if (!view.canManage) return
            const trimmed = name.trim()
            if (!trimmed) throw new Error('Enter a name for this machine.')
            await rename(machine.id, trimmed)
          }}
        />
        <Row
          label="Status"
          description={
            <>
              {machine.supersededBy && (
                <span className="block">
                  Replaced by {replacement?.name ?? machine.supersededBy}
                </span>
              )}
              {view.runsServer && (
                <span className="block">This machine also runs the Podium server.</span>
              )}
              {view.status.detail && <span className="block">{view.status.detail}</span>}
              {view.componentsNote && <span className="block">{view.componentsNote}</span>}
              {(view.agentChangesOnRestart || view.serverChangesOnRestart) && (
                <span className="block">Changes on restart.</span>
              )}
              {machine.services?.topology?.legacyUnits.some((unit) =>
                unit.endsWith('-daemon.service'),
              ) && <span className="block">Legacy daemon unit installed.</span>}
              <MachineFailureReason reason={update?.reason} />
            </>
          }
        >
          <MachineStatus view={view} />
        </Row>
        {hosting && !machine.online && !machine.revokedAt && view.canManage && (
          <Row
            label="Host sessions on this device"
            description={hosting.error ?? 'Enable hosting here. The app will restart to pair it.'}
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={hosting.busy}
              onClick={() => void hosting.enable()}
            >
              {hosting.busy ? 'Enabling…' : 'Enable'}
            </Button>
          </Row>
        )}
        <Row
          label="Looked after by"
          description="Their logins and keys run here without asking. They decide who else may."
        >
          <span className="settings-prose">
            <MachineCustodianName view={view} capitalized />
          </span>
        </Row>
        {machine.podiumManaged === false && (
          <Row
            label="Keeps its own logins"
            description="Agent logins from your other machines are not copied here."
          />
        )}
        <Row
          label="Podium version"
          description={skew.note ?? 'The Podium build installed on this machine.'}
        >
          <span className="settings-value break-all">
            {machine.appVersion ? formatDisplayedVersion(machine.appVersion) : 'Not reported'}
          </span>
          {skew.label === 'Update available' && (
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={() => {
                closeTakeover()
                setSettingsTab('updates')
              }}
            >
              Update
            </Button>
          )}
        </Row>
        <Row
          label="Agents installed"
          description="The agent versions last reported by this machine."
        >
          {machine.harnessVersions === undefined ? (
            <span className="settings-prose">Not reported</span>
          ) : machine.harnessVersions.length === 0 ? (
            <span className="settings-prose">None reported</span>
          ) : (
            <ul className="settings-prose space-y-1" aria-label="Agents installed">
              {machine.harnessVersions.map((agent) => (
                <li
                  key={`${agent.harness}:${agent.version}`}
                  title={`First seen ${agent.firstSeen}`}
                >
                  {harnessAgentLabel(agent.harness)} <code>{agent.version}</code>
                  {agent.unverified && (
                    <span
                      className="ml-1 text-warning"
                      title={`Verified through ${agent.verifiedThrough}`}
                    >
                      unverified
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Row>
      </Section>
      {machine.unowned !== true && !machine.revokedAt && (
        <MachineCustody machineId={machine.id} transferable={view.canManage} trpc={trpc} />
      )}
      <MachineProjects
        machine={machine}
        findRef={findButton}
        onFind={view.canFindRepositories ? () => setFindingRepos(true) : undefined}
      />
      <MachineRemove view={view} />
    </>
  )
})
