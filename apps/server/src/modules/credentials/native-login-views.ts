/** Machine-owned login controls projected onto credentials, never a second native listing. */
import type { CredentialView, UserId } from '@podium/model'
import { DEFAULT_HOME_ID } from '@podium/protocol'
import { homeHarnessFor } from './home-removers'
import type { NativeLoginState } from './native-login-actions'

export async function withNativeLoginViews(
  views: CredentialView[],
  state: NativeLoginState,
  viewer: UserId,
): Promise<CredentialView[]> {
  const standing = await state.machineStanding()
  const custody = new Set([...standing].filter(([, s]) => s === 'custody').map(([id]) => id))
  const machines = (await state.machineService.listMachines()).filter((machine) =>
    custody.has(machine.id),
  )
  const keyOf = (harness: string, fingerprint: string) => `${harness}\u0000${fingerprint}`
  const ticked = new Set(
    (await state.store.nativeLogins.optInsFor(viewer))
      .filter((choice) => choice.enabled)
      .map((choice) => keyOf(choice.harness, choice.fingerprint)),
  )
  const kept = new Map<string, Set<string>>()
  for (const transfer of await state.store.nativeLogins.transfersFor(viewer)) {
    if (transfer.outcome !== 'preserved' || !custody.has(transfer.machineId)) continue
    const key = keyOf(transfer.harness, transfer.fingerprint)
    const ids = kept.get(key) ?? new Set()
    ids.add(transfer.machineId)
    kept.set(key, ids)
  }
  return views.map((view) => {
    // Managing another person's credential never permits changing their machine's login.
    if (view.access !== 'owner' || view.status === 'revoked') return view
    const harness = homeHarnessFor(view.type)
    const fingerprint = view.identity.fingerprint
    if (!harness || !fingerprint) return view
    const key = keyOf(harness, fingerprint)
    let observed = false
    const targets: NonNullable<CredentialView['nativeLogin']>['machines'] = []
    for (const machine of machines) {
      if (!machine.online || machine.revokedAt) continue
      const agent = machine.inventory?.agents.find((agent) => agent.kind === harness)
      if (!agent?.installed) continue
      const login = agent.logins?.find((login) => login.homeId === DEFAULT_HOME_ID) ?? agent.login
      const matches = login.state === 'in' && login.identity?.fingerprint === fingerprint
      if (matches) observed = true
      // A different signed-in account is never offered as a repair target for this row.
      if (login.state === 'in' && !matches) continue
      targets.push({ id: machine.id, name: machine.name, state: login.state })
    }
    const enabled = ticked.has(key)
    if (!targets.length && !enabled) return view
    // A credential held only in a Podium-created home does not repair the machine's own login.
    if (!observed && !enabled && view.homes.some((home) => home.homeId !== DEFAULT_HOME_ID)) return view
    const attempt = state.nativeLogin.attempt(viewer, harness)
    return {
      ...view,
      nativeLogin: {
        harness,
        machines: targets,
        required:
          targets.some((machine) => machine.state === 'out') ||
          state.nativeLogin.isRequired(harness, new Set(targets.map((machine) => machine.id))),
        // An enabled choice can always be turned off, even after its source goes offline.
        ...(observed || enabled ? { useOnMyMachines: enabled } : {}),
        keptOn: machines
          .filter((machine) => kept.get(key)?.has(machine.id))
          .map((machine) => ({ id: machine.id, name: machine.name })),
        ...(attempt && targets.some((machine) => machine.id === attempt.machineId)
          ? { attempt }
          : {}),
      },
    }
  })
}
