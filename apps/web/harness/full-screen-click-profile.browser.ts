/** Measurement entry; the acceptance fixture and every product module are unchanged. */
import '../test/sidebar-acceptance.browser'
import { paneDataLayer } from '../src/lib/pane-data-layer'
import { sessionPaneDataLayer } from '../src/features/terminal/session-pane-data-layer'
import { chipsDataLayer } from '../src/lib/chips-data-layer'
import type {} from './full-screen-click-profile'

window.__speedPaneMode = paneDataLayer
window.__speedReaderModes = () => ({ pane: paneDataLayer(), sessionPane: sessionPaneDataLayer(), chips: chipsDataLayer() })
