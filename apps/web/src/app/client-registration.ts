import type { NativeDesktopBridge } from '@/lib/nativeDesktop'
import { restartNativeDesktop } from './native-pairing'
import type { Trpc } from './trpc'

const restartGuidance = 'Client registration saved — quit and reopen the app to finish pairing.'

/** One in-flight attempt per login, across StrictMode replays and authenticated remounts.
 * Native rechecks the target and eligibility under its config-write lock. A saved
 * pairCode and runtime registration history fence subsequent process launches. */
export class ClientRegistration {
  private attempt: Promise<string | null> | undefined
  private retryAfterLogin = false
  private principal: string | undefined
  private loginEpoch = 0
  private attemptedEpoch: number | undefined

  /** The LoginGate calls this only when its currently mounted principal expires. */
  invalidateLogin(): void {
    this.loginEpoch++
    this.principal = undefined
    this.retryAfterLogin = false
  }

  /** Only the live login owner calls this after the server accepts new credentials.
   * Native receipts still fence saved authority; an older attempt settles first. */
  retryAfterSignIn(): void {
    this.retryAfterLogin = true
  }

  start(
    bridge: NativeDesktopBridge | undefined,
    trpc: Pick<Trpc, 'machines'>,
    principal?: string,
  ): Promise<string | null> {
    if (
      bridge?.launchMode !== 'client' ||
      !bridge.clientRegistrationStatus ||
      !bridge.registerClient
    )
      return Promise.resolve(null)
    if (this.principal !== principal) {
      this.principal = principal
      this.loginEpoch++
    }
    const epoch = this.loginEpoch
    const current = () => this.loginEpoch === epoch && this.principal === principal
    const register = (afterSignIn = false) =>
      this.register(bridge, trpc, afterSignIn, current).catch((error: unknown) => {
        if (!current()) return null
        const message = error instanceof Error ? error.message : String(error)
        return message === restartGuidance
          ? message
          : `Client registration could not finish: ${message}`
      })
    if (this.retryAfterLogin || this.attemptedEpoch !== epoch) {
      const afterSignIn = this.retryAfterLogin
      this.retryAfterLogin = false
      this.attemptedEpoch = epoch
      this.attempt = this.attempt
        ? this.attempt.then(() => register(afterSignIn))
        : register(afterSignIn)
    }
    this.attempt ??= register()
    return this.attempt
  }

  private async register(
    bridge: NativeDesktopBridge,
    trpc: Pick<Trpc, 'machines'>,
    afterSignIn: boolean,
    current: () => boolean,
  ): Promise<string | null> {
    const read = bridge.clientRegistrationStatus
    const save = bridge.registerClient
    if (!read || !save) return null
    // Startup can reach an already-authenticated page before the CLI has written
    // its first canonical declaration. Pending pairing can likewise settle after
    // this page mounts. Only these transitional answers are read again, bounded.
    for (let observation = 0; observation < 40; observation++) {
      if (!current()) return null
      const status = await read()
      if (!current()) return null
      switch (status.state) {
        case 'not-applicable':
        case 'enrolled':
          return null
        case 'unavailable':
          return status.message
        case 'rejected':
        case 'needed': {
          // A prior saved code was already tried. Cookie mounts and process
          // restarts cannot retry it. Only a newly verified login gets one
          // server decision; this local gate grants no registration authority.
          const request =
            status.state === 'rejected' ? (afterSignIn ? status.retry : undefined) : status
          if (!request) return status.state === 'rejected' ? status.message : null
          if (!request.machineId)
            return 'This desktop companion does not support identity-preserving registration. Update the app and reopen it.'
          const { code } = await trpc.machines.pairingCode.mutate({
            podiumManaged: true,
            copyAgentCredentials: false,
            clientRegistration: {
              machineId: request.machineId,
              ...(request.publicKey ? { publicKey: request.publicKey } : {}),
            },
          })
          if (!current()) return null
          await save(code, request.target)
          if (!current()) return null
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
