/**
 * Bun `with { type: 'file' }` imports (POD-1122).
 *
 * `bun build --compile` embeds the referenced file and hands the import a path to
 * the materialized copy at runtime. The targets are build artifacts — `dist-bun/`
 * does not exist in a fresh checkout — so without this declaration the scripts
 * typecheck lane reports an unresolvable module for a file that is never meant to
 * be on disk at check time.
 */
declare module '*.bin' {
  const path: string
  export default path
}
