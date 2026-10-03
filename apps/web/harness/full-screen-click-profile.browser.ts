/** Measurement entry; the acceptance fixture and every product module are unchanged. */
import '../test/sidebar-acceptance.browser'

window.__speedPaneMode = () => 'pool' as const
window.__speedReaderModes = () => ({ pane: 'pool', sessionPane: 'pool', chips: 'pool' })
