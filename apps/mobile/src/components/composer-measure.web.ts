import { type RefObject, useLayoutEffect } from 'react'
import type { TextInput } from 'react-native'

/**
 * Measure the composer's content height on web [POD-502].
 *
 * react-native-web renders `multiline` as a `<textarea>` and answers
 * `onContentSizeChange` with the node's `scrollHeight`. That is the wrong
 * number for a field whose height we set: `scrollHeight` is floored at the
 * element's own height, so it tracks growth and then never comes back down when
 * text is deleted. Collapsing the box to zero first makes `scrollHeight` the
 * content height and nothing else.
 *
 * `height: 0` ALONE DOES NOT COLLAPSE IT. The field is a flex item filling a
 * height-animated wrapper, and on a flex item `flex-basis` is the main size —
 * `height` is ignored. Left like that the measurement still tracks growth
 * (content exceeds the box) and silently stops shrinking, which is the exact
 * defect this module exists to fix. So the item opts out of flex for the
 * measurement and is put back immediately.
 *
 * The write/read/restore happens inside one layout effect, so the browser never
 * paints the collapsed box — the only cost is a forced reflow per keystroke,
 * which is what every autosizing textarea on the web pays. Width is untouched:
 * a column flex container stretches its items on the cross axis, so the text
 * keeps wrapping exactly as it did.
 *
 * `width` is not read; it is a dependency so a rotation, a split-view resize or
 * a Dynamic Type change re-measures the new wrapping.
 */
export function useComposerMeasure(
  ref: RefObject<TextInput | null>,
  text: string,
  width: number,
  onMeasured: (height: number) => void,
): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` and `width` are read off the node, not the closure — they are here to re-measure when the content or its wrapping changes
  useLayoutEffect(() => {
    // react-native-web's TextInput ref IS the host node, with RN's imperative
    // methods hung off it.
    const node = ref.current as unknown as HTMLTextAreaElement | null
    if (!node || typeof node.scrollHeight !== 'number' || !node.style) return
    const previousHeight = node.style.height
    const previousFlex = node.style.flex
    node.style.flex = 'none'
    node.style.height = '0px'
    const measured = node.scrollHeight
    node.style.flex = previousFlex
    node.style.height = previousHeight
    // A layout engine that reports nothing (happy-dom, a detached node) must
    // not be read as "the field is empty".
    if (measured > 0) onMeasured(measured)
  }, [ref, text, width, onMeasured])
}
