import type { AccountCredentials } from '@podium/client-core/accounts'
import { checkWireVersion, describeWireSkew, type LiveConnectionObservers } from '@podium/client-core/live-connection'
import { CLIENT_WIRE_VERSION } from '@podium/protocol'

/** Native builds cannot obtain a new bundle by reloading a page. The phone's
 * remedy reports the same handshake evidence and names which peer to update. */
export function mobileVersionObservers(options: {
  credentials: AccountCredentials
  fetchVersion: () => Promise<unknown>
  report: (message: string) => void
}): Pick<LiveConnectionObservers, 'onWireSkew' | 'onReconnect'> & { dispose(): void } {
  let disposed = false
  let recoveryAttempted = false
  let severe = false
  const check = async (): Promise<void> => {
    const result = await checkWireVersion(options.fetchVersion)
    if (disposed || !result || result.verdict === 'ok' || severe) return
    if (result.verdict === 'client-too-new') {
      options.report(`Your server is running an older version of Podium than this app (wire ${result.server.wireVersion} against ${CLIENT_WIRE_VERSION}). Update your server to continue.`)
    } else {
      options.report(options.credentials.delivery === 'browser'
        ? 'This app and server are running different builds. Reload to pick up the build the server is serving.'
        : 'This app and server are running different builds. Update Podium on this device to continue.')
    }
  }
  return {
    onWireSkew: (skew) => {
      if (disposed) return
      const notice = describeWireSkew(skew, options.credentials.delivery)
      if (!severe || notice.severe) options.report(notice.message)
      severe ||= notice.severe
      if (skew.refusedFrames <= 0 || recoveryAttempted) return
      recoveryAttempted = true
      void check()
    },
    onReconnect: () => { if (!disposed) void check() },
    dispose: () => { disposed = true },
  }
}
