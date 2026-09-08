/**
 * The pure-JavaScript libsql remote client [POD-3272, spec §3.7].
 *
 * THE `/web` ENTRY IS THE ONLY ENTRY THIS MODULE MAY IMPORT. The default
 * `@libsql/client` specifier loads `@neon-rs/load` and an `index.node`; `/web`
 * is 54 modules of JavaScript and compiles into the shipped binary with zero
 * native references (POD-3251 gate 1). A boundary lint forbids the default.
 *
 * The provisioned URLs use a `turso://` scheme, which the client refuses
 * (`URL_SCHEME_NOT_SUPPORTED`). Under `/web`, `libsql://` resolves to HTTPS
 * because `web.js` calls `expandConfig(config, true)`. The rewrite belongs here
 * rather than at every caller.
 */

import { type Client, createClient, type InValue } from '@libsql/client/web'

export type { Client, InValue }

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
