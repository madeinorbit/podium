import type { RefObject } from 'react'
import type { TextInput } from 'react-native'

/**
 * Native measures itself — `TextInput`'s own `onContentSizeChange` reports the
 * content height and shrinks with it, so there is nothing to do here. The web
 * implementation next door exists because react-native-web's version of that
 * event reads `scrollHeight` off a box whose height we control, which can only
 * ever grow. See ./composer-measure.web.ts.
 */
export function useComposerMeasure(
  _ref: RefObject<TextInput | null>,
  _text: string,
  _width: number,
  _onMeasured: (height: number) => void,
): void {}
