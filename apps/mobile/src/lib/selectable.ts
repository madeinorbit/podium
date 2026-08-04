import { Platform } from 'react-native'

/**
 * Marks a subtree as user-selectable [POD-366].
 *
 * The web shell turns selection off app-wide (scripts/patch-web-html.ts) so a
 * long-press on a card cannot raise iOS's selection magnifier and callout menu
 * — the single loudest "this is a web page" tell. Prose the user may
 * legitimately want to copy (agent replies, transcripts) opts back in with
 * this.
 *
 * `dataSet` is react-native-web's escape hatch to a `data-*` attribute and is
 * absent from React Native's own prop types, hence the cast. On native it is
 * omitted: selection there is governed by `<Text selectable>`.
 */
export const selectableProps: object =
  Platform.OS === 'web' ? { dataSet: { selectable: 'true' } } : {}
