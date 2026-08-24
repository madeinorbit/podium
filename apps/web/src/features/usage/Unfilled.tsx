import type { JSX } from 'react'

/**
 * A MISSING READING, DRAWN AS THE RULE THE DIGITS WILL SIT ON.
 *
 * Not a grey block, never a `0`, never an em dash. A skeleton block claims the
 * shape of content that has not arrived; a `0` is a lie; a dash reads as "not
 * applicable" rather than "not yet". A baseline rule inherits the local ink, so
 * the hierarchy of the region survives while its numbers are absent — and the
 * layout does not move when they land.
 *
 * Lives in its own module because two regions need it and the sheet's main view
 * imports the ledger: sharing it through `UsageView` would make that a cycle.
 */
export function Unfilled({ ch }: { ch: number }): JSX.Element {
  return <span className="usage-unfilled" style={{ width: `${ch}ch` }} aria-hidden="true" />
}
