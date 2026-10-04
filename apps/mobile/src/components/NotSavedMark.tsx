import type { MobxPool } from '@podium/client-graph/pool'
import { useCallback } from 'react'
import { Text } from 'react-native'
import { useMobilePoolProjection } from '../client/mobile-pool'
import { color, font } from '../theme/theme'

/** A row-local subscription to the pool's parked transaction index. */
export function NotSavedMark({ kind, id }: { kind: 'issue' | 'session'; id: string }) {
  const read = useCallback((pool: MobxPool) => pool.notSaved(kind, id), [kind, id])
  const notSaved = useMobilePoolProjection(read, false)
  return notSaved ? (
    <Text testID="not-saved" accessibilityLiveRegion="polite" style={{ color: color.dangerText, fontSize: font.micro }}>
      not saved
    </Text>
  ) : null
}
