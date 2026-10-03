import type { MobileTrpc } from './trpc'

// Compilation witnesses: the phone has the complete server API and rejects
// wrong verbs, missing inputs, and procedures which do not exist.
function apiContract(client: MobileTrpc) {
  client.repos.list.query()
  client.sessions.transcriptRead.query({ sessionId: 'session', direction: 'before', limit: 80 })
  // @ts-expect-error transcript paging is a query
  client.sessions.transcriptRead.mutate({ sessionId: 'session', direction: 'before', limit: 80 })
  // @ts-expect-error paging requires a direction and limit
  client.sessions.transcriptRead.query({ sessionId: 'session' })
  // @ts-expect-error nonexistent procedures must not be callable
  client.sessions.mobileOnlyProcedure.query()
}
