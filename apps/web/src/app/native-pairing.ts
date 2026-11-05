import { restartPodiumShell } from '@/features/setup/restart-shell'
import type { NativeDesktopBridge } from '@/lib/nativeDesktop'
import type { Trpc } from './trpc'

/** Hosting and client registration use the same authenticated one-use code and restart. */
export async function pairNativeDesktop(
  trpc: Pick<Trpc, 'machines'>,
  persist: (code: string) => Promise<void>,
  restartGuidance: string,
): Promise<void> {
  const { code } = await trpc.machines.pairingCode.mutate({
    podiumManaged: true,
    copyAgentCredentials: false,
  })
  await persist(code)
  await restartNativeDesktop(restartGuidance)
}

export async function restartNativeDesktop(restartGuidance: string): Promise<void> {
  // A saved handoff must survive a missing/refused native restart. Reloading the
  // WebView would leave the old supervisor running with its captured config.
  if (!(window as { __PODIUM_RESTART__?: unknown }).__PODIUM_RESTART__)
    throw new Error(restartGuidance)
  if ((await restartPodiumShell()) === 'unavailable') throw new Error(restartGuidance)
}

/** Explicit hosting on an enrolled client changes the existing machine's assignment.
 * A one-use enrollment code cannot enroll the same non-revoked identity twice. */
export async function enableNativeHosting(
  trpc: Pick<Trpc, 'machines'>,
  bridge: NativeDesktopBridge,
): Promise<void> {
  const enable = bridge.enableHosting
  if (!enable) throw new Error('This shell cannot enable hosting.')
  const guidance = 'Hosting enabled — quit and reopen the app to finish pairing.'
  const status = await bridge.clientRegistrationStatus?.()
  if (status?.state === 'rejected' || status?.state === 'unavailable')
    throw new Error(status.message)
  if (status?.state === 'starting' || status?.state === 'pending')
    throw new Error(
      'Client registration is pending — quit and reopen the app before enabling hosting.',
    )
  if (status?.state === 'not-applicable') throw new Error('Hosting requires a client-mode app.')
  if (status?.state === 'enrolled') {
    if (!bridge.machineId)
      throw new Error('Reopen the app before enabling hosting for this machine.')
    await trpc.machines.setAssignment.mutate({
      id: bridge.machineId,
      assignment: { server: false, agentExecution: true },
      requestId: crypto.randomUUID(),
    })
    await enable()
    await restartNativeDesktop(guidance)
    return
  }
  await pairNativeDesktop(trpc, enable, guidance)
}
