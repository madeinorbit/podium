/**
 * The web's inputs to one {@link AgentSetupView}: the request client, the
 * person's own `credentialDefaults` (read live from their synced preferences,
 * written as one personal leaf) and the saved credentials each harness accepts.
 *
 * The credential list and the served `accepts` lines reach React as values;
 * they are copied into observable fields here so the view's derived answers
 * follow them.
 */

import { useCommands, useRequestClient } from '@podium/client-core/react'
import type { MachineModel } from '@podium/client-graph'
import {
  type AgentSetupOrigin,
  type AgentSetupPreferences,
  AgentSetupView,
  type SavedCredentialChoice,
} from '@podium/client-graph/agent-setup-view'
import { myPreferences } from '@podium/client-graph/per-user-records'
import type { BuiltinHarnessKind, CredentialView } from '@podium/model'
import { action, observableRef } from 'mobx'
import { useEffect, useMemo, useState } from 'react'
import { useWorklistPool } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { harnessChoices, identityText, typeTitle } from '@/features/credentials/credential-facts'
import {
  useHarnessAccepts,
  useSessionCredentials,
} from '@/features/credentials/session/use-session-credentials'

type Accepts = (harness: string) => readonly { type: string }[]
type Defaults = Readonly<Partial<Record<BuiltinHarnessKind, string>>>
type Pool = NonNullable<ReturnType<typeof useWorklistPool>>
const NO_DEFAULTS: Defaults = {}

class WebAgentSetupPreferences implements AgentSetupPreferences {
  @observableRef private accessor views: readonly CredentialView[] | undefined = undefined
  @observableRef private accessor accepts: Accepts = () => []

  constructor(
    private readonly pool: Pool | undefined,
    private readonly write: (values: Readonly<Record<string, unknown>>) => Promise<void>,
  ) {}

  readonly update = action((views: readonly CredentialView[] | undefined, accepts: Accepts) => {
    this.views = views
    this.accepts = accepts
  })

  credentialDefaults(): Defaults {
    return (
      ((this.pool ? myPreferences(this.pool)?.credentialDefaults : undefined) as
        | Defaults
        | undefined) ?? NO_DEFAULTS
    )
  }

  saveCredentialDefaults(next: Partial<Record<BuiltinHarnessKind, string>>): Promise<void> {
    return this.write({ credentialDefaults: next })
  }

  savedCredentials(harness: BuiltinHarnessKind): readonly SavedCredentialChoice[] {
    const views = this.views
    if (!views) return []
    return harnessChoices(views, this.accepts(harness)).map((view) => {
      const hint = [typeTitle(view.type), identityText(view)].filter(Boolean).join(' · ')
      return { id: view.id as string, label: view.label, ...(hint ? { hint } : {}) }
    })
  }
}

/** One view per opening of the panel for this machine; closed when it unmounts. */
export function useAgentSetupView({
  machine,
  origin,
  onStart,
  focus,
  opening,
}: {
  machine: MachineModel
  origin: AgentSetupOrigin['kind']
  onStart?: AgentSetupOrigin['onStart']
  focus?: BuiltinHarnessKind
  /** Changes when the opener asks again: a new view, nothing carried over. */
  opening?: number
}): AgentSetupView {
  const pool = useWorklistPool()
  const client = useRequestClient<Trpc>()
  const setPreferences = useCommands<Trpc>().preferences.setPreferences
  const credentials = useSessionCredentials()
  const accepts = useHarnessAccepts(machine.id)
  const [preferences] = useState(
    () => new WebAgentSetupPreferences(pool ?? undefined, setPreferences),
  )
  useEffect(
    () => preferences.update(credentials.views, accepts),
    [preferences, credentials.views, accepts],
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: `opening` asks for a fresh view
  const view = useMemo(
    () =>
      new AgentSetupView({
        machine,
        client,
        preferences,
        origin: { kind: origin, ...(onStart ? { onStart } : {}) },
        ...(focus ? { focus } : {}),
      }),
    [machine, client, preferences, origin, onStart, focus, opening],
  )
  useEffect(() => () => view.close(), [view])
  return view
}
