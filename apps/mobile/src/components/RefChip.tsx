import type { IssueReferenceModel } from '@podium/client-core/values'

import { StyleSheet, Text } from 'react-native'
import { usePoolRefChip } from '../client/use-inbox-data'
import { color, sans } from '../theme/theme'

/**
 * A `POD-529` mention inside agent output (POD-724), drawn as a quiet inline
 * ref since the iOS redesign (POD-2380): a word in the sentence, not a chip.
 * Its live workflow stage is resolved HERE (every markdown caller would
 * otherwise have to know about issues) and announced in the accessibility
 * label, so the state is never invented and never lost.
 */

interface RefChipProps {
  token: string
  refKind: 'issue' | 'session'
  prefix: string
  onPress?: ((ref: string) => void) | undefined
}

export function RefChip(props: RefChipProps) {
  const { known, model } = usePoolRefChip(props.token, props.refKind, props.prefix)
  return <RefChipView {...props} known={known} model={model} />
}

function RefChipView({
  token,
  refKind,
  onPress,
  known,
  model,
}: RefChipProps & { known: boolean; model: IssueReferenceModel | null }) {
  // Not a ref, just text that happens to be shaped like one.
  if (!known) return <>{token}</>

  // QUIET INLINE REF (board Chat, POD-2380 simulator pass): the token in the
  // label colour at semibold, inside the sentence it belongs to. No chip fill,
  // underline or stage glyph: the transcript is prose, and a ref is a word in
  // it. The live stage is still SAID, in the accessibility label, and the task
  // it names is one tap away. An unresolved issue ref and a session ref read
  // the same way, so a gap still claims nothing (POD-676).
  return (
    <Text
      accessibilityRole={onPress ? 'link' : 'text'}
      accessibilityLabel={
        model?.accessibleLabel ??
        (refKind === 'session' ? `Session ${token}` : `Task ${token} is unavailable`)
      }
      style={styles.ref}
      onPress={onPress ? () => onPress(token) : undefined}
    >
      {token}
    </Text>
  )
}

const styles = StyleSheet.create({
  ref: {
    ...sans(600),
    color: color.text,
  },
})
