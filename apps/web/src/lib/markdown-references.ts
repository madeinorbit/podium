// Registered repo prefixes are shared by transcript Markdown, terminal link
// providers, and the root ref host. Keep this registry free of parser and DOM
// imports so those eager consumers do not load the Markdown renderer.
let knownRefPrefixes = new Set<string>()

/** Replace the repo prefixes recognized by Markdown and terminal ref links. */
export function setKnownRefPrefixes(prefixes: Iterable<string>): void {
  knownRefPrefixes = new Set(prefixes)
}

/** The currently registered repo prefixes. */
export function getKnownRefPrefixes(): ReadonlySet<string> {
  return knownRefPrefixes
}

/** Whether `prefix` belongs to a registered repo. */
export function isKnownRefPrefix(prefix: string): boolean {
  return knownRefPrefixes.has(prefix)
}
