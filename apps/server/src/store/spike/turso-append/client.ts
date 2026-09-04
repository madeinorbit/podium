/**
 * The libsql client this proof drives, and the round-trip counter [POD-3250].
 *
 * ROUND TRIPS ARE COUNTED AT THE TRANSPORT, NOT AT THE CALL SITE, and that is
 * the only place the number is trustworthy. `client.batch` of 371 statements is
 * one call and one request; an interactive transaction is one request per
 * statement PLUS one for the BEGIN and one for the COMMIT; and the client is
 * free to coalesce or split as it likes. Counting `execute()` invocations would
 * therefore measure the code rather than the network, and the whole point of
 * the measurement is what the network costs. `@libsql/client` takes a `fetch`
 * in its config, so the counter wraps that and counts actual HTTP requests.
 *
 * THE `/web` ENTRY IS NOT A STYLE CHOICE (spec §3.7, POD-3251 gate 1). The
 * default entry of `@libsql/client` pulls `@neon-rs/load` and an `index.node`
 * into the bundle; `/web` is pure JavaScript and compiles into the shipped
 * binary with zero native references. Nothing here may import the default
 * entry.
 */

import { type Client, createClient } from '@libsql/client/web'
import { unprefixedTableUse } from './namespace'

/** A live count of HTTP requests issued by one client. */
export interface RoundTripCounter {
  /** Requests since the counter was created or last reset. */
  count(): number
  /** Set the count back to zero and return what it was. */
  reset(): number
}

export interface CountedClient {
  readonly client: Client
  readonly roundTrips: RoundTripCounter
}

/**
 * The URL the credentials are written with is not the URL the client accepts.
 *
 * The provisioned URLs use a `turso://` scheme, which the client refuses
 * outright (`URL_SCHEME_NOT_SUPPORTED`, POD-3251 gate 1). Under the `/web`
 * entry `libsql://` resolves to HTTPS, because `web.js` calls `expandConfig`
 * with `preferHttp = true`. So the rewrite is mechanical and belongs here
 * rather than in every caller's environment.
 */
export function normalizeTursoUrl(url: string): string {
  return url.startsWith('turso://') ? `libsql://${url.slice('turso://'.length)}` : url
}

/**
 * The namespace guard, run over the body of every outgoing request [POD-3358].
 *
 * THE PREFIX IS ENFORCED AT THE TRANSPORT BECAUSE THAT IS THE ONLY PLACE THAT
 * SEES EVERY STATEMENT. The slice builds most of its SQL through drizzle, where
 * the table object carries the namespace and a missed site is impossible — but
 * not all of it: the proof script and the integration test issue raw statements
 * that spell `changes` in a template string, and one of them keys a
 * `sqlite_sequence` lookup on the literal 'changes'. Those are hand-written, so
 * one of them can be forgotten, and a forgotten one silently rejoins the shared
 * table that this whole change exists to get out of. Checking here means such a
 * statement throws before it is sent rather than corrupting a neighbour's run.
 *
 * Skipped when the prefix is empty, which is the deliberate pre-fix arrangement
 * the POD-3358 control run uses — there, bare names are the point.
 */
async function assertNamespaced(
  prefix: string,
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
): Promise<void> {
  if (prefix === '') return
  // THE STATEMENT IS IN THE `Request`, NOT IN `init.body`, and finding that out
  // is the reason this function is async. `@libsql/client/web` builds a
  // `Request` and passes it as the sole argument, so a guard that read
  // `init.body` saw `undefined` on every call and passed everything — which is
  // exactly how it behaved when first written, and why the mutation test that
  // caught it is worth more than the guard itself.
  const body =
    input instanceof Request
      ? await input.clone().text()
      : typeof init?.body === 'string'
        ? init.body
        : undefined
  if (body === undefined) return
  const leaked = unprefixedTableUse(body)
  if (leaked === undefined) return
  throw new Error(
    `spike statement names the unprefixed table \`${leaked}\` (namespace \`${prefix}\`). ` +
      'Every table this slice touches must be spelled through the run prefix, or ' +
      'concurrent runs share it again — see namespace.ts [POD-3358].',
  )
}

/** Wrap `fetch` so every HTTP request the client makes increments a counter. */
function countingFetch(prefix: string): { fetch: typeof globalThis.fetch; counter: RoundTripCounter } {
  let requests = 0
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    await assertNamespaced(prefix, input, init)
    requests += 1
    return await globalThis.fetch(input, init)
  }
  return {
    fetch: wrapped,
    counter: {
      count: () => requests,
      reset: () => {
        const was = requests
        requests = 0
        return was
      },
    },
  }
}

export interface BackendConfig {
  readonly url: string
  readonly authToken?: string
}

/**
 * A client with its own transport counter.
 *
 * ONE COUNTER PER CLIENT, deliberately: the contention proof runs two clients
 * against one database and has to attribute requests to the writer that made
 * them, which a process-wide counter could not do.
 */
export function createCountedClient(config: BackendConfig, prefix = ''): CountedClient {
  const { fetch, counter } = countingFetch(prefix)
  const client = createClient({
    url: normalizeTursoUrl(config.url),
    ...(config.authToken === undefined ? {} : { authToken: config.authToken }),
    fetch,
  })
  return { client, roundTrips: counter }
}

/**
 * The two backends this proof runs against, resolved from the environment.
 *
 * BOTH, NOT EITHER. `turso dev` is a local sqld and is what CI can run, but it
 * is not the engine the hosted database uses — POD-3251 found the hosted one is
 * in MVCC mode and refuses virtual tables, which is already one behavioural
 * difference. A contract proven only on the local server would be a false
 * green, so every proof here states which backend it ran on and the results
 * document reports where the two disagree.
 */
export function localBackend(): BackendConfig {
  return { url: process.env.TURSO_DEV_URL ?? 'http://127.0.0.1:8080' }
}

/** The hosted spike database, or `undefined` when its credentials are absent. */
export function remoteBackend(): BackendConfig | undefined {
  const url = process.env.TURSO_SPIKE_URL
  const authToken = process.env.TURSO_SPIKE_TOKEN
  if (!url || !authToken) return undefined
  return { url, authToken }
}
