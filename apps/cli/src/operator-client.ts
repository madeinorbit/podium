/**
 * The direct (non-relay) issue client, carrying the operator's credential [POD-1376].
 *
 * Every `podium <verb>` module picks one of two transports: a constrained agent's calls
 * ride its daemon relay (which applies scope), and everything else talks to the local
 * server over tRPC. That second path used to send no credential at all, so on a
 * password-protected instance it failed on every call — reads and writes alike — with
 * "Unable to transform response from server", because the auth guard's 401 body is not a
 * tRPC envelope.
 *
 * One helper rather than eight call sites resolving the token themselves: the credential
 * lookup order (PODIUM_SESSION_TOKEN, then the state-dir cache) has to be identical for
 * `podium issue` and `podium mail` and the rest, or the operator would find some verbs
 * authenticated and others not.
 *
 * No credential is the correct, silent state on an instance with no password: the server's
 * clientAuthGuard passes those requests through untouched.
 */
import { type IssueTrpc, makeIssueClient } from '@podium/issue-client'
import { resolveSessionToken } from '@podium/runtime/session-mint'

export function makeOperatorIssueClient(baseUrl: string): IssueTrpc {
  return makeIssueClient(baseUrl, { sessionToken: resolveSessionToken() })
}
