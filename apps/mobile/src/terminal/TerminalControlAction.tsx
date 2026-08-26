import { Maximize2, Smartphone } from 'lucide-react-native'
import { Icon } from '../components/Icon'
import { HeaderButton } from '../components/Screen'
import { color } from '../theme/theme'
import { type TerminalControlState, terminalControlCopy } from './terminal-control'

/**
 * The header's take-control action (POD-724) — stateful, never a blind button.
 *
 * Spectating shows the fit-to-screen glyph in resting ink: the tap will change
 * the terminal's size. In control it becomes the phone glyph in Accent Blue —
 * calm liveness, the same channel the app uses for "this is live and working".
 * Deliberately NOT the accent: taking control is not the operator being
 * waited on, and the Signal Rule holds even when an action feels important.
 *
 * No confirmation dialog. The desk already loses control to whichever client
 * foregrounded last, so a sheet here would interrupt for a consequence the
 * product accepts everywhere else — the label states it instead, and one tap
 * of the desk keyboard takes it straight back.
 */
export function TerminalControlAction({ control }: { control: TerminalControlState }) {
  const copy = terminalControlCopy(control)
  const controlling = control.phase === 'controlling'
  return (
    <HeaderButton label={copy.label} onPress={control.takeControl}>
      <Icon
        as={controlling ? Smartphone : Maximize2}
        size={15}
        color={controlling ? color.working : color.textDim}
      />
    </HeaderButton>
  )
}
