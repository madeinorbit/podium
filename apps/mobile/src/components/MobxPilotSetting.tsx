import { MOBX_SIDEBAR_KEY } from '@podium/client-core/ui-state'
import { StyleSheet, Switch, Text, View } from 'react-native'
import { mobileDataLayer } from '../client/mobile-pool'
import { usePersistedUiState } from '../hooks/usePersistedUiState'
import { color, font, leading, radius, space } from '../theme/theme'
import { SectionHeader } from './ui'

const readPilotPreference = (raw: string | null): boolean => raw === '1'
const writePilotPreference = (enabled: boolean): string => (enabled ? '1' : '0')

/** Settings → Experimental: this device's MobX pilot setting (POD-4976), the
 * counterpart of the web's development-only row. Listed in development builds,
 * and on any build while the setting or this launch is on, so it can be turned
 * back off. Saved now and applied at the next app start; the running app keeps
 * its startup choice. */
export function MobxPilotSetting({ dev = typeof __DEV__ !== 'undefined' && __DEV__ }) {
  const [enabled, setEnabled] = usePersistedUiState(
    MOBX_SIDEBAR_KEY,
    readPilotPreference,
    writePilotPreference,
  )
  const launchedOn = mobileDataLayer() === 'pool'
  if (!enabled && !dev && !launchedOn) return null
  return (
    <>
      <SectionHeader label="Experimental" />
      <View style={styles.panel}>
        <View style={styles.row}>
          <View style={styles.text}>
            <Text style={styles.label}>MobX pilot</Text>
            <Text style={styles.hint}>
              {`Applies at the next app start. This launch: ${launchedOn ? 'on' : 'off'}.`}
            </Text>
          </View>
          <Switch accessibilityLabel="MobX pilot" value={enabled} onValueChange={setEnabled} />
        </View>
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.card,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm + 2,
  },
  text: { flexShrink: 1 },
  label: { color: color.textDim, fontSize: font.small },
  hint: {
    color: color.textFaint,
    fontSize: font.tiny,
    lineHeight: leading(font.tiny, 'prose'),
    marginTop: space.xs,
  },
})
