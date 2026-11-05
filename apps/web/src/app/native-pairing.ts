import { restartPodiumShell } from '@/features/setup/restart-shell'
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
