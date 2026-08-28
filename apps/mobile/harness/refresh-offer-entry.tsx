/**
 * PHONE REFRESH OFFER HARNESS (POD-2511). Not shipped, not part of the app.
 *
 * The offer is a phone surface, so it has to be looked at at phone width, on
 * the app's own ground, in a browser — the only place `react-native-web` lays
 * these styles out for real. The trigger is stubbed at the network edge, not
 * in the component: `fetch` answers the served-build stamp with a build the
 * page is not running, exactly as a server that has just been updated does, so
 * what is on screen came through the real detection path.
 */
import { PRODUCT_VERSION_META } from '@podium/protocol'
import { createRoot } from 'react-dom/client'
import { StyleSheet, Text, View } from 'react-native'
import { RefreshOffer } from '../src/components/RefreshOffer'
import { color, font, sans, space } from '../src/theme/theme'

const PAGE_VERSION = '0.1.1-edge.3'
const SERVED_VERSION = new URLSearchParams(window.location.search).get('served') ?? '0.1.1-edge.4'

const meta = document.createElement('meta')
meta.setAttribute('name', PRODUCT_VERSION_META)
meta.setAttribute('content', PAGE_VERSION)
document.head.appendChild(meta)

window.fetch = (async () =>
  new Response(JSON.stringify({ appVersion: SERVED_VERSION }), {
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch

function Harness() {
  return (
    <View style={styles.phone}>
      <Text style={styles.title}>Inbox</Text>
      <RefreshOffer />
      <Text style={styles.caption}>
        page {PAGE_VERSION} · served {SERVED_VERSION}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  phone: { width: 390, paddingTop: space.lg, backgroundColor: color.bg, minHeight: 240 },
  title: {
    ...sans(600),
    color: color.text,
    fontSize: font.title,
    paddingHorizontal: space.md,
    paddingBottom: space.md,
  },
  caption: {
    ...sans(400),
    color: color.textMicro,
    fontSize: font.micro,
    paddingHorizontal: space.md,
  },
})

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />)
