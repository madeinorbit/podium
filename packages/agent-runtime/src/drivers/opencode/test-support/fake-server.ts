/**
 * A FAKE `opencode serve`, ON A REAL LOOPBACK SOCKET (POD-1761 W5).
 *
 * ---------------------------------------------------------------------------
 * WHY A REAL SOCKET AND NOT AN INJECTED `fetch`
 * ---------------------------------------------------------------------------
 *
 * An injected fetch would have been less code and would have tested less. Two
 * properties this driver has to prove are about the TRANSPORT, not about the
 * mapping:
 *
 *   1. spec §6's refusal. "A client without the password must be rejected by the
 *      server; prove it." A stubbed function returning 401 proves that the stub
 *      returns 401. A real request, over a real TCP connection, to a real
 *      listener that reads a real `Authorization` header, proves the shape of
 *      the thing opencode does — and this server implements the check exactly
 *      as opencode 1.18.16 was observed to (Basic only; no credentials, wrong
 *      password and `Bearer <password>` all 401).
 *   2. The SSE stream is genuinely asynchronous, arriving in chunks split at
 *      arbitrary boundaries. A synchronous stub would have hidden every framing
 *      bug in the client's parser.
 *
 * What is still deterministic — and this is the whole point of W5 being the
 * epic's first headless driver — is that no model runs, no PTY exists and no
 * timing ladder is waited out. The server answers instantly and only when told.
 *
 * ---------------------------------------------------------------------------
 * IT SPEAKS THE RECORDED PROTOCOL, NOT AN IDEALIZED ONE
 * ---------------------------------------------------------------------------
 *
 * Every response shape here is the shape in `../__fixtures__`, including the
 * awkward ones: `prompt_async` answers 204 with no body, `permission.asked`
 * carries `always` as rule patterns rather than a boolean, question answers are
 * LABELS, and `/event` yields nothing at all unless `?directory=` matches. A
 * fake that smoothed those over would let the driver pass here and fail against
 * the real thing.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OpencodeQuestionInfo } from '../protocol.js'

export interface FakeOpencodeSession {
  id: string
  directory: string
  title?: string
  model?: { id: string; providerID: string; variant?: string }
  messages: {
    info: Record<string, unknown>
    parts: Record<string, unknown>[]
  }[]
}

export interface FakePermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
}

export interface FakeQuestionRequest {
  id: string
  sessionID: string
  questions: OpencodeQuestionInfo[]
}

export interface FakeOpencodeServer {
  baseUrl: string
  username: string
  password: string
  pid: number
  /** Every prompt POST this server accepted, per session. The corpus's
   *  `deliveryAttempts` counter — one DELIVERY of the caller's words, counted
   *  where the words actually arrive. */
  promptCount(sessionId: string): number
  /** The next prompt POST answers 500. The honest way to make a send fail
   *  without a verification window this family does not have. */
  failNextPrompt(): void
  createSessionId(): string
  session(id: string): FakeOpencodeSession | undefined
  /** Push one SSE frame to every subscriber whose `?directory=` matches. */
  emit(type: string, properties: Record<string, unknown>): void
  askPermission(input: Omit<FakePermissionRequest, 'id'> & { id?: string }): string
  askQuestion(input: Omit<FakeQuestionRequest, 'id'> & { id?: string }): string
  /** The turn ended. Emits exactly what opencode emits: a status flip and the
   *  single authoritative `session.idle`. */
  goIdle(sessionId: string): void
  goBusy(sessionId: string): void
  /**
   * A REAL unauthenticated request against this REAL listener.
   *
   * The conformance corpus's `connectWithoutSecret` is synchronous, so the
   * answer is computed once at launch and cached — but it is computed by
   * actually opening a connection with no `Authorization` header and reading the
   * status back, which is the only form of this check worth having.
   */
  probeWithoutSecret(): Promise<boolean>
  alive: boolean
  close(): Promise<void>
}

let nextId = 0
const id = (prefix: string): string => `${prefix}_${(++nextId).toString().padStart(12, '0')}fake`

export async function startFakeOpencodeServer(options: {
  username: string
  password: string
}): Promise<FakeOpencodeServer> {
  const sessions = new Map<string, FakeOpencodeSession>()
  const permissions = new Map<string, FakePermissionRequest>()
  const questions = new Map<string, FakeQuestionRequest>()
  const prompts = new Map<string, number>()
  const subscribers = new Set<{ directory: string; write: (chunk: string) => void }>()
  let failNext = false

  const expected = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const directory = url.searchParams.get('directory') ?? ''

    /**
     * SPEC §6, ENFORCED BEFORE ROUTING — exactly as opencode does it.
     *
     * Not per-route, not after parsing a body, and with no exempt endpoint: a
     * loopback port fronting a credentialed agent has no route that is safe to
     * leave open, and `/global/health` is the one a naive implementation would
     * exempt "because it is only a health check" — while it is also the one that
     * tells an attacker the port is an opencode.
     */
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('Unauthorized')
      return
    }

    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    const readBody = (then: (body: Record<string, unknown>) => void): void => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        try {
          then(raw ? (JSON.parse(raw) as Record<string, unknown>) : {})
        } catch {
          json(400, { error: 'bad json' })
        }
      })
    }

    if (path === '/global/health' && req.method === 'GET') {
      json(200, { ok: true })
      return
    }

    if (path === '/event' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const subscriber = {
        directory,
        write: (chunk: string) => {
          res.write(chunk)
        },
      }
      subscribers.add(subscriber)
      // opencode's own first frame. Harmless, and its presence keeps the client
      // parser honest about frames it must ignore.
      subscriber.write(`data: ${JSON.stringify({ id: id('evt'), type: 'server.connected', properties: {} })}\n\n`)
      req.on('close', () => subscribers.delete(subscriber))
      return
    }

    if (path === '/session' && req.method === 'POST') {
      readBody((body) => {
        const sessionId = id('ses')
        const session: FakeOpencodeSession = {
          id: sessionId,
          directory,
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(body.model ? { model: body.model as FakeOpencodeSession['model'] } : {}),
          messages: [],
        }
        sessions.set(sessionId, session)
        emit('session.created', { sessionID: sessionId, info: sessionSummary(session) })
        json(200, sessionSummary(session))
      })
      return
    }

    if (path === '/permission' && req.method === 'GET') {
      json(200, [...permissions.values()])
      return
    }

    if (path === '/question' && req.method === 'GET') {
      json(200, [...questions.values()])
      return
    }

    const permissionReply = /^\/permission\/([^/]+)\/reply$/.exec(path)
    if (permissionReply && req.method === 'POST') {
      const requestId = decodeURIComponent(permissionReply[1] ?? '')
      const pending = permissions.get(requestId)
      if (!pending) {
        json(404, { error: 'no such permission' })
        return
      }
      readBody((body) => {
        permissions.delete(requestId)
        emit('permission.replied', {
          sessionID: pending.sessionID,
          requestID: requestId,
          reply: body.reply,
        })
        json(200, true)
      })
      return
    }

    const questionReply = /^\/question\/([^/]+)\/reply$/.exec(path)
    if (questionReply && req.method === 'POST') {
      const requestId = decodeURIComponent(questionReply[1] ?? '')
      const pending = questions.get(requestId)
      if (!pending) {
        json(404, { error: 'no such question' })
        return
      }
      readBody((body) => {
        questions.delete(requestId)
        emit('question.replied', {
          sessionID: pending.sessionID,
          requestID: requestId,
          answers: body.answers,
        })
        json(200, true)
      })
      return
    }

    const questionReject = /^\/question\/([^/]+)\/reject$/.exec(path)
    if (questionReject && req.method === 'POST') {
      const requestId = decodeURIComponent(questionReject[1] ?? '')
      const pending = questions.get(requestId)
      if (!pending) {
        json(404, { error: 'no such question' })
        return
      }
      questions.delete(requestId)
      emit('question.rejected', { sessionID: pending.sessionID, requestID: requestId })
      json(200, true)
      return
    }

    const prompt = /^\/session\/([^/]+)\/prompt_async$/.exec(path)
    if (prompt && req.method === 'POST') {
      const sessionId = decodeURIComponent(prompt[1] ?? '')
      if (!sessions.has(sessionId)) {
        json(404, { error: 'no such session' })
        return
      }
      if (failNext) {
        failNext = false
        // NOT A "verification failure" — this family has no verification window.
        // A server that refuses the POST is the only way a send can fail here,
        // and the driver must report `refused`, never `unverified`.
        json(500, { error: 'induced failure' })
        return
      }
      readBody(() => {
        prompts.set(sessionId, (prompts.get(sessionId) ?? 0) + 1)
        // 204 IS THE ACK, with no body — the exact shape recorded from 1.18.16.
        res.writeHead(204)
        res.end()
        goBusy(sessionId)
      })
      return
    }

    const abort = /^\/session\/([^/]+)\/abort$/.exec(path)
    if (abort && req.method === 'POST') {
      json(200, true)
      return
    }

    const messages = /^\/session\/([^/]+)\/message$/.exec(path)
    if (messages && req.method === 'GET') {
      const session = sessions.get(decodeURIComponent(messages[1] ?? ''))
      json(200, session?.messages ?? [])
      return
    }

    const get = /^\/session\/([^/]+)$/.exec(path)
    if (get && req.method === 'GET') {
      const session = sessions.get(decodeURIComponent(get[1] ?? ''))
      if (!session) {
        json(404, { error: 'no such session' })
        return
      }
      json(200, sessionSummary(session))
      return
    }

    json(404, { error: `unrouted ${req.method} ${path}` })
  })

  function sessionSummary(session: FakeOpencodeSession): Record<string, unknown> {
    return {
      id: session.id,
      directory: session.directory,
      ...(session.title ? { title: session.title } : {}),
      ...(session.model ? { model: session.model } : {}),
      tokens: { input: 12, output: 34, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      time: { created: 1_786_682_760_537, updated: 1_786_682_760_616 },
    }
  }

  function emit(type: string, properties: Record<string, unknown>): void {
    const frame = `data: ${JSON.stringify({ id: id('evt'), type, properties })}\n\n`
    for (const subscriber of subscribers) subscriber.write(frame)
  }

  function goBusy(sessionId: string): void {
    emit('session.status', { sessionID: sessionId, status: { type: 'busy' } })
  }

  function goIdle(sessionId: string): void {
    emit('session.status', { sessionID: sessionId, status: { type: 'idle' } })
    // THE AUTHORITATIVE ONE. `session.status: idle` fires between internal steps
    // as well; `session.idle` fires once, at the end of the turn.
    emit('session.idle', { sessionID: sessionId })
  }

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  // Never hold the test process open on a fake server's account.
  server.unref()
  const port = (server.address() as AddressInfo).port
  const baseUrl = `http://127.0.0.1:${port}`

  const fake: FakeOpencodeServer = {
    baseUrl,
    username: options.username,
    password: options.password,
    pid: process.pid,
    alive: true,
    promptCount: (sessionId) => prompts.get(sessionId) ?? 0,
    failNextPrompt: () => {
      failNext = true
    },
    createSessionId: () => id('ses'),
    session: (sessionId) => sessions.get(sessionId),
    emit,
    goIdle,
    goBusy,
    askPermission(input) {
      const requestId = input.id ?? id('per')
      permissions.set(requestId, { ...input, id: requestId })
      emit('permission.asked', { ...input, id: requestId })
      return requestId
    },
    askQuestion(input) {
      const requestId = input.id ?? id('que')
      questions.set(requestId, { ...input, id: requestId })
      emit('question.asked', { ...input, id: requestId })
      return requestId
    },
    async probeWithoutSecret() {
      const response = await fetch(`${baseUrl}/global/health`)
      return response.status === 401
    },
    async close() {
      fake.alive = false
      for (const subscriber of subscribers) subscriber.write('')
      subscribers.clear()
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
    },
  }
  return fake
}
