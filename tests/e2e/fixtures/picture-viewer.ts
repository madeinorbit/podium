/** The shipped browser transport and mount, without unrelated app surfaces. */
import { SocketHub } from '@podium/client-core/socket-transport'
import { asSessionId } from '@podium/model'
import { mountSession } from '@podium/terminal-client/session-mount'

const params = new URL(location.href).searchParams
const sessionId = asSessionId(params.get('session') ?? '')
let active = params.get('passive') !== '1'
// The terminal needs no metadata replica. This sink negotiates the shipped
// HTTP-sync wire in both admission and hello, then ignores unrelated feed frames.
const ignoreMetadata = () => undefined
const hub = new SocketHub({
  url: `${location.origin.replace(/^http/, 'ws')}/client`,
  onError: (message) => console.error(message),
  feed: {
    syncHttp: true,
    helloFields: () => null,
    connected: ignoreMetadata,
    disconnected: ignoreMetadata,
    frame: ignoreMetadata,
  },
})
const viewport = document.getElementById('viewport') as HTMLElement
const host = document.getElementById('terminal') as HTMLElement
const mount = () =>
  mountSession(host, {
    hub,
    sessionId,
    viewportEl: viewport,
    crop: 'scroll',
    test: true,
    focusOnMount: false,
    active,
  })
let mounted = mount()
hub.connect()

document.getElementById('cold-switch')?.addEventListener('click', () => {
  mounted.dispose()
  mounted = mount()
})
document.getElementById('take-control')?.addEventListener('click', () => {
  active = true
  mounted.setActive(true)
  mounted.takeControl()
})
document.getElementById('pause')?.addEventListener('click', () => {
  active = false
  mounted.setActive(false)
})
window.addEventListener('pagehide', () => {
  mounted.dispose()
  hub.dispose()
})
