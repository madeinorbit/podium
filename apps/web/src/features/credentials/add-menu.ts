/**
 * THE "ADD" MENU of the credentials page. Adding by paste is built in, one
 * entry per type whose `obtain` includes `paste`. Other ways of adding (a
 * subscription signed in on a machine, epic Task 9; a ChatGPT plan, Task 14)
 * register an entry here from their own folder:
 *
 *   registerAddEntry({ key: 'subscription', label: 'Subscription', hint: '…',
 *     render: ({ done }) => <AddSubscription onDone={done} /> })
 */

import type { ReactNode } from 'react'
import type { CredentialDeps } from './credentials-deps'

export interface AddEntryContext {
  deps: CredentialDeps
  /** Close the flow and read the list again. */
  done: () => void
}

export interface AddEntry {
  /** Stable and unique. */
  key: string
  label: string
  hint: string
  render: (ctx: AddEntryContext) => ReactNode
}

const registered = new Map<string, AddEntry>()

/** Adds an entry under its key (replacing one with the same key); returns its removal. */
export function registerAddEntry(entry: AddEntry): () => void {
  registered.set(entry.key, entry)
  return () => {
    if (registered.get(entry.key) === entry) registered.delete(entry.key)
  }
}

/** The registered entries, in registration order. */
export function registeredAddEntries(): AddEntry[] {
  return [...registered.values()]
}
