/**
 * THE KEYS THAT START WITH A PREFIX, AS A RANGE AN INDEX CAN SEEK [POD-6173].
 *
 * `key LIKE 'prefix%'` reads every row: SQLite's LIKE optimisation needs a
 * literal pattern and a case-insensitive index, and a bound pattern has
 * neither. `key >= prefix AND key < prefixUpperBound(prefix)` selects exactly
 * the same keys through any index on `key`, and compares case-sensitively, as
 * an equality does.
 *
 * The bound is the prefix with its last character raised by one. That is exact
 * when the last character is ASCII: its UTF-8 form is one byte, so a key sorts
 * at or above the prefix and below the bound exactly when it starts with the
 * prefix. Every caller's prefix ends in a separator (`/`, `:`), so a prefix
 * that does not end in ASCII is a mistake and throws.
 */
export function prefixUpperBound(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1)
  if (!(last < 0x7f)) {
    throw new Error(`a key prefix must end in an ASCII character: ${JSON.stringify(prefix)}`)
  }
  return prefix.slice(0, -1) + String.fromCharCode(last + 1)
}
