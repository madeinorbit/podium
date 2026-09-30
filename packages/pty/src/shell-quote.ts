/**
 * POSIX single-quoting for the few places that must hand a command to `sh -c`
 * rather than exec it from argv, such as the durable headless runner's
 * script.
 */

/** POSIX single-quote a string for `sh -c`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
