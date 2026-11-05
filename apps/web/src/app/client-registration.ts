import type { NativeDesktopBridge } from '@/lib/nativeDesktop'
import { restartNativeDesktop } from './native-pairing'
import type { Trpc } from './trpc'

const restartGuidance = 'Client registration saved — quit and reopen the app to finish pairing.'

/** One attempt per WebView, across StrictMode replays and authenticated remounts.
 * Native rechecks the target and eligibility under its config-write lock. A saved
 * pairCode and runtime registration history fence subsequent process launches. */
export class ClientRegistration {
  private attempt: Promise<string | null> | undefined

  start(
    bridge: NativeDesktopBridge | undefined,
    trpc: Pick<Trpc, 'machines'>,
  ): Promise<string | null> {
    if (
      bridge?.launchMode !== 'client' ||
      !bridge.clientRegistrationStatus ||
      !bridge.registerClient
    )
      return Promise.resolve(null)
    this.attempt ??= this.register(bridge, trpc).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      return message === restartGuidance
        ? message
        : `Client registration could not finish: ${message}`
    })
    return this.attempt
  }

  private async register(
    bridge: NativeDesktopBridge,
    trpc: Pick<Trpc, 'machines'>,
  ): Promise<string | null> {
    const read = bridge.clientRegistrationStatus
    const save = bridge.registerClient
    if (!read || !save) return null
    // Startup can reach an already-authenticated page before the CLI has written
    // its first canonical declaration. Pending pairing can likewise settle after
    // this page mounts. Only these transitional answers are read again, bounded.
    for (let observation = 0; observation < 40; observation++) {
      const status = await read()
      switch (status.state) {
        case 'not-applicable':
        case 'enrolled':
          return null
        case 'rejected':
        case 'unavailable':
          return status.message
        case 'needed': {
          if (!status.machineId)
            return 'This desktop companion does not support identity-preserving registration. Update the app and reopen it.'
          const { code } = await trpc.machines.pairingCode.mutate({
            podiumManaged: true,
            copyAgentCredentials: false,
            clientRegistration: {
              machineId: status.machineId,
              ...(status.publicKey ? { publicKey: status.publicKey } : {}),
            },
          })
          await save(code, status.target)
          await restartNativeDesktop(restartGuidance)
          return null
        }
        case 'starting':
        case 'pending':
          if (observation === 39)
            return status.state === 'pending'
              ? restartGuidance
              : 'Client supervisor registration is unavailable. Reopen the app and inspect its local logs. Older companion runtimes need an app and runtime that support registration.'
          await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    return null
  }
}

export const clientRegistration = new ClientRegistration()
