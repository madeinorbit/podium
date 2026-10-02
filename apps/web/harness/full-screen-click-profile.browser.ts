/** Measurement entry; the acceptance fixture and every product module are unchanged. */
import '../test/sidebar-acceptance.browser'
import { paneDataLayer } from '../src/lib/pane-data-layer'
import type {} from './full-screen-click-profile'

window.__speedPaneMode = paneDataLayer
const plantMs = Number(new URLSearchParams(location.search).get('plantBusyMs') ?? 0)
let plantSink = 0
function profileBusyLoop() {
  performance.mark('speed:plant:start')
  const until = performance.now() + plantMs
  do {
    for (let i = 0; i < 50_000; i++) plantSink = (Math.imul(plantSink, 1664525) + 1013904223) | 0
  } while (performance.now() < until)
  performance.mark('speed:plant:end')
}
if (plantMs) document.addEventListener('pointerdown', () => {
  if (window.__speedCapture?.action === 'mission-switch' && window.__speedCapture.input !== null)
    profileBusyLoop()
}, true)
