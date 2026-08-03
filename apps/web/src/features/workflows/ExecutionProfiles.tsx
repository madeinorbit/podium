/**
 * EXECUTION PROFILES (POD-647) — named launch presets, and the one place this
 * surface chooses a MACHINE.
 *
 * ---------------------------------------------------------------------------
 * PLACEMENT IS OWNED COMPUTE AND IT FAILS CLOSED
 * ---------------------------------------------------------------------------
 *
 * A profile's `machineId` decides where a workflow run's work executes. That is
 * the USE verb (readiness §3.1.4 M1) and a CODE-EXECUTION boundary (M2), not a
 * privacy one. So per M5 this control:
 *
 *  - OFFERS only machines the principal holds `use` on and that are reachable —
 *    the gate is on the POPULATION, via the machines slice's `placementOptions`,
 *    so there is no path on which an unauthorized machine is offered and then
 *    refused at click;
 *  - keeps UNAUTHORIZED and UNREACHABLE visibly apart, because "ask the owner"
 *    and "wake it up" are opposite recoveries and one greyed "unavailable" tells
 *    the user neither;
 *  - never silently retargets. `machineId: null` is submitted as null and reads
 *    as UNPLACED — the server resolves it through its own fail-closed path. The
 *    UI does not pick "whatever is available" on the principal's behalf, which
 *    is exactly the silent retarget M5 forbids.
 *
 * The refusals are shown rather than dropped: an empty offer list with no
 * explanation IS the M5 defect restated.
 */
import {
  machineViewsFromWire,
  placementOptions,
  profilePlacement,
} from '@podium/client-core/viewmodels'
import { AgentKind } from '@podium/model'
import type { JSX } from 'react'
import { useState } from 'react'
import { useStoreSelector } from '@/app/store'
import type { WorkflowsSource } from './use-workflows'
import { type WorkflowRights, workflowCommands } from './workflow-commands'
import { CommandButton, Empty, Field } from './workflow-ui'

const PLACEMENT_WORDS: Record<string, string> = {
  available: 'available',
  unreachable: 'offline — try again later',
  unauthorized: 'no access — ask its owner',
  unplaced: 'no machine chosen',
  unknown: 'unknown machine',
}

export function ExecutionProfiles({
  source,
  rights,
}: {
  source: WorkflowsSource
  rights: WorkflowRights
}): JSX.Element {
  const machines = useStoreSelector((s) => s.machines)
  const views = machineViewsFromWire(machines)
  const options = placementOptions(views)

  const [name, setName] = useState('')
  const [accountId, setAccountId] = useState('')
  const [harness, setHarness] = useState<AgentKind>('codex')
  const [model, setModel] = useState('auto')
  const [effort, setEffort] = useState('auto')
  // Null is a real choice — "no machine chosen" — and it is submitted as null.
  const [machineId, setMachineId] = useState<string | null>(null)
  const canSave = Boolean(name && accountId && harness)

  return (
    <section className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto grid max-w-5xl grid-cols-[1fr_360px] gap-6">
        <div>
          <h2 className="mb-1 text-lg font-semibold">Execution profiles</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Named launch presets only. Credentials stay in the account inventory.
          </p>
          {source.profiles.length === 0 ? (
            <Empty>No execution profiles.</Empty>
          ) : (
            <div className="space-y-2">
              {source.profiles.map((profile) => {
                const placement = profilePlacement(profile, views)
                return (
                  <div
                    key={profile.id}
                    className="rounded-lg border p-3"
                    data-profile-id={profile.id}
                  >
                    <div className="text-sm font-medium">{profile.name}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {profile.harness} · {profile.model} · {profile.effort}
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      account {profile.accountId}
                      {profile.machineId ? ` · machine ${profile.machineId}` : ''}
                    </div>
                    <div
                      className="mt-1 text-[11px] text-muted-foreground"
                      data-placement={placement.state}
                    >
                      placement: {PLACEMENT_WORDS[placement.state]}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="rounded-lg border p-4">
          <h3 className="mb-3 text-sm font-semibold">New profile</h3>
          <div className="space-y-3">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
            </Field>
            <Field label="Account ID">
              <input
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="input"
              />
            </Field>
            <Field label="Harness">
              <select
                value={harness}
                onChange={(e) => setHarness(AgentKind.parse(e.target.value))}
                className="input"
              >
                {AgentKind.options.map((kind) => (
                  <option key={kind}>{kind}</option>
                ))}
              </select>
            </Field>
            <Field label="Machine">
              <select
                value={machineId ?? ''}
                onChange={(e) => setMachineId(e.target.value === '' ? null : e.target.value)}
                className="input"
              >
                {/* Explicitly "none", not a default that resolves to anything. */}
                <option value="">No machine chosen</option>
                {options.offerable.map((machine) => (
                  <option key={machine.id} value={machine.id}>
                    {machine.name}
                  </option>
                ))}
              </select>
            </Field>
            {(options.unauthorized.length > 0 || options.unreachable.length > 0) && (
              <p className="text-[11px] text-muted-foreground" data-placement-refusals>
                {options.unauthorized.length > 0 && (
                  <span className="block">
                    {options.unauthorized.length} machine
                    {options.unauthorized.length === 1 ? '' : 's'} not offered — no access; ask the
                    owner.
                  </span>
                )}
                {options.unreachable.length > 0 && (
                  <span className="block">
                    {options.unreachable.length} machine
                    {options.unreachable.length === 1 ? '' : 's'} not offered — offline; try again
                    later.
                  </span>
                )}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Field label="Model">
                <input value={model} onChange={(e) => setModel(e.target.value)} className="input" />
              </Field>
              <Field label="Effort">
                <input
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                  className="input"
                />
              </Field>
            </div>
            <CommandButton
              className="w-full"
              command={workflowCommands.profileSave}
              rights={rights}
              dispatch={source.dispatch}
              disabled={!canSave}
              input={() => ({ name, accountId, harness, model, effort, machineId })}
            />
          </div>
        </div>
      </div>
    </section>
  )
}
