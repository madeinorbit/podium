/** Measurement entry; the acceptance fixture and every product module are unchanged. */
import '../test/sidebar-acceptance.browser'
import { paneDataLayer } from '../src/lib/pane-data-layer'
import type {} from './full-screen-click-profile'

window.__speedPaneMode = paneDataLayer

// Arming control only. Removed before the retained four-action capture.
function profileBusyLoop() {
  performance.mark('profile:plant:start')
  const until = performance.now() + 200
  let value = 0
  while (performance.now() < until) value = Math.imul(value + 1, 48271)
  ;(window as Window & { __profilePlantValue?: number }).__profilePlantValue = value
  performance.mark('profile:plant:end')
}
document.addEventListener('pointerdown', (event) => {
  const capture = window.__speedCapture
  if (event.isTrusted && capture?.action === 'mission-switch' && capture.input !== null &&
    (event.target as Element)?.closest(capture.trigger)) profileBusyLoop()
}, true)
