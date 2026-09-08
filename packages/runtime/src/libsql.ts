/**
 * The pure-JavaScript libsql remote client [POD-3272, spec §3.7].
 *
 * RUNTIME IMPORTS USE `/web` ONLY. The default `@libsql/client` specifier
 * loads `@neon-rs/load` and an `index.node`; `/web` is 54 modules of JavaScript
 * and does not load the addon (POD-3251 gate 1). A boundary lint forbids the
 * default specifier at runtime. Types are imported from `@libsql/core/api`
 * because `/web` does not export `Client`/`InValue` (it imports Client locally
 * and `export *` cannot re-export it). A type-only import is erased and loads
 * nothing native.
 *
 * THAT IS LOADING, NOT THE INSTALL TREE. `libsql` is a hard dependency of
 * `@libsql/client`, not an optional one, so the native `.node` artifacts still
 * land on disk. This delta is remote-only at runtime; it does not decide
 * deferred decision 1 (embedded replica / native addon).
 *
 * The provisioned URLs use a `turso://` scheme, which the client refuses
 * (`URL_SCHEME_NOT_SUPPORTED`). Under `/web`, `libsql://` resolves to HTTPS
 * because `web.js` calls `expandConfig(config, true)`. The rewrite belongs here
 * rather than at every caller.
 */

import { createClient } from '@libsql/client/web'
import type { Client, InValue, ResultSet, Transaction } from '@libsql/core/api'

export type { Client, InValue, ResultSet, Transaction }

export function normalizeLibsqlUrl(url: string): string {
  return url.startsWith('turso://') ? `libsql://${url.slice('turso://'.length)}` : url
}

export interface LibsqlClientOptions {
  readonly url: string
  readonly authToken?: string
}

export function createLibsqlClient(options: LibsqlClientOptions): Client {
  return createClient({
    url: normalizeLibsqlUrl(options.url),
    ...(options.authToken !== undefined ? { authToken: options.authToken } : {}),
  })
}
