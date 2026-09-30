// Registered repo prefixes are shared by transcript Markdown, terminal link
// providers, and the root ref host. Keep this registry free of parser and DOM
// imports so those eager consumers do not load the Markdown renderer.
let knownRefPrefixes = new Set<string>()

// The set arrives asynchronously (RefPrefixSync), usually AFTER the first
// transcript rows have rendered — and a row rendered against the empty set has
// no ref links. So renderers that memoize linkified HTML read this version and
// recompute when it moves (POD-4966). It moves only when the set's CONTENT
// changes, so a refetch returning the same prefixes rewrites nothing.
let knownRefPrefixesVersion = 0
const listeners = new Set<() => void>()

/** Replace the repo prefixes recognized by Markdown and terminal ref links. */
export function setKnownRefPrefixes(prefixes: Iterable<string>): void {
  const next = new Set(prefixes)
  if (next.size === knownRefPrefixes.size && [...next].every((p) => knownRefPrefixes.has(p))) {
    return
  }
  knownRefPrefixes = next
  knownRefPrefixesVersion += 1
  for (const listener of listeners) listener()
}

/** The currently registered repo prefixes. */
export function getKnownRefPrefixes(): ReadonlySet<string> {
  return knownRefPrefixes
}

/** Whether `prefix` belongs to a registered repo. */
export function isKnownRefPrefix(prefix: string): boolean {
  return knownRefPrefixes.has(prefix)
}

/** Bumps each time the registered prefix set changes content. */
export function getKnownRefPrefixesVersion(): number {
  return knownRefPrefixesVersion
}

/** Called after every content change of the prefix set. */
export function subscribeKnownRefPrefixes(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
