/**
 * The MOBILE replica storage adapter (POD-375) as a BROWSER ENTRYPOINT of
 * `@podium/sync` — `@podium/sync/adapters/mobile-sqlite` (POD-307).
 *
 * "Browser entrypoint" is the manifest's word for browser-SAFE, and it is the
 * right one here even though the consumer is React Native: `apps/mobile` is tagged
 * `browser-safe`, and what the tag actually asserts is that no Node builtin is
 * reachable. This adapter satisfies that by construction — `./sql` types the
 * SQLite surface STRUCTURALLY, so `packages/sync` takes no dependency on
 * `expo-sqlite`, `bun:sqlite` or `node:sqlite`; the composition root passes the
 * engine in.
 *
 * `./conformance` and `./test-support` are deliberately NOT here: the second
 * imports `node:fs`/`node:os` to build a real temp-file database, which is
 * exactly the reachability rule 12b exists to keep out of a client bundle.
 */
export * from './schema'
export * from './sql'
export * from './store'
