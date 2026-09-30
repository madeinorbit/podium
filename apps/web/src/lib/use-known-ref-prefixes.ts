import { useSyncExternalStore } from 'react'
import { getKnownRefPrefixesVersion, subscribeKnownRefPrefixes } from './markdown-references'

/**
 * The registered ref-prefix set's version, for a memo that linkifies refs: put
 * it in the deps so HTML rendered before the prefixes arrived is rendered again
 * once they do (POD-4966).
 */
export function useKnownRefPrefixesVersion(): number {
  return useSyncExternalStore(
    subscribeKnownRefPrefixes,
    getKnownRefPrefixesVersion,
    getKnownRefPrefixesVersion,
  )
}
