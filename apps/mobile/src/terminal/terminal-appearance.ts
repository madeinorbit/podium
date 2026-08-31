/**
 * The mobile terminal's LOOK, shared by both renderers of the same pane: the
 * Expo-web pane (react-native-web + xterm in the page) and the native pane's
 * DOM component (xterm inside the app's webview). One module so a size or
 * palette decision cannot fork between platforms that are supposed to be the
 * same surface.
 */

/**
 * This accessory intentionally retains the pre-redesign mobile-web SURFACES:
 * parity includes its contrast hierarchy, not only its controls and gestures.
 * The accent is not part of that parity — it is the brand mark on the one lit
 * key, so it tracks `color.accent` (POD-1436) rather than staying a generation
 * behind on the pre-redesign amber.
 */
export const LEGACY_MOBILE_KEYBOARD_THEME = {
  bar: '#08080c',
  card: '#16161c',
  border: '#2a2a34',
  secondary: '#25252f',
  hairlineSoft: '#25252f',
  hairlineBar: '#2e2e38',
  muted: '#9a9aa8',
  accent: '#d9b477',
  onAccent: '#191308',
  danger: '#f87171',
  fontFamily: 'GeistMono_400Regular, ui-monospace, Menlo, monospace',
} as const

/**
 * Mobile default appearance for the native agent view [POD-131]: a much
 * smaller mono size than the desktop default (13px) so agent TUI frames fit a
 * phone width crisply on retina screens. Applied via the terminal-client
 * appearance channel — the same one the web's terminal themability settings
 * use — so a future mobile settings surface can override it live.
 */
export const MOBILE_APPEARANCE = {
  fontSize: 10,
  // Expo registers this exact static-face name. The shared desktop stack starts
  // with `Geist Mono Variable`, which this bundle does not ship; leaving it in
  // place made xterm measure/rasterize a browser fallback instead. Inside the
  // native pane's webview no expo-registered face exists at all, so the stack's
  // `ui-monospace, Menlo` tail is what actually renders there.
  fontFamily: 'GeistMono_400Regular, ui-monospace, Menlo, monospace',
  lineHeight: 1.12,
} as const
