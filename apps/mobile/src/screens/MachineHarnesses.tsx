import { here } from '@podium/client-graph/lookup'
import { observer } from 'mobx-react-lite'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useMobilePool } from '../client/mobile-pool'
import { PhoneAgentSetupSheet } from '../components/AgentSetupSheet'
import { PressableScale } from '../components/PressableScale'
import { color, font, sans, space } from '../theme/theme'

/** One Settings entry per machine; management opens in its own sheet. */
export const PhoneMachineHarnesses = observer(function PhoneMachineHarnesses({
  machineId,
}: {
  machineId: string
}) {
  const [open, setOpen] = useState(false)
  const pool = useMobilePool()
  const machine = pool ? here(pool.model('machine', machineId)) : undefined
  if (!machine) return null
  return (
    <View>
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={`Harnesses on ${machine.name}`}
        onPress={() => setOpen(true)}
        style={styles.row}
      >
        <Text style={styles.label}>Harnesses</Text>
        <Text style={styles.chevron}>›</Text>
      </PressableScale>
      {open ? (
        <PhoneAgentSetupSheet
          machineId={machineId}
          origin="settings"
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  )
})
const styles = StyleSheet.create({
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  label: { ...sans(), color: color.accentTint, fontSize: font.body },
  chevron: { color: color.textMicro, fontSize: font.title },
})
