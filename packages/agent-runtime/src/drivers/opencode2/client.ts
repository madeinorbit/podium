import type { OpencodeClient, OpencodeClientConfig } from '../opencode/client.js'
import type {
  OpencodeEvent,
  OpencodeMessageWithParts,
  OpencodePermissionReply,
  OpencodePromptBody,
  OpencodeQuestionAnswers,
  OpencodeQuestionRequest,
  OpencodeSession,
  OpencodeSessionId,
} from '../opencode/protocol.js'

/** Adapter from the OpenCode 2 preview /api surface to the stable OpenCode
 * runtime port. Keeping this translation here lets both protocol generations
 * share the RuntimeDriver implementation and conformance behavior. */
export function createOpencode2Client(config: OpencodeClientConfig): OpencodeClient {
  const fetcher = config.fetch ?? globalThis.fetch
  const auth = `Basic ${base64(`opencode:${config.password}`)}`
  const timeoutMs = config.timeoutMs ?? 30_000
  let session: string | undefined
  const forms = new Map<string, Opencode2Form>()
  const request = async (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    streaming = false,
  ) => {
    const timer = new AbortController()
    const onAbort = (): void => timer.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => timer.abort(), timeoutMs)
    if (typeof timeout === 'object' && 'unref' in timeout) timeout.unref()
    let response: Response
    try {
      response = await fetcher(`${config.baseUrl}${path}`, {
        method,
        headers: {
          authorization: auth,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: timer.signal,
      })
    } finally {
      clearTimeout(timeout)
      if (!streaming) signal?.removeEventListener('abort', onAbort)
    }
    if (!response.ok)
      throw new Error(`opencode2 ${method} ${path} → ${response.status}: ${await response.text()}`)
    return response
  }
  const sid = () => {
    if (!session) throw new Error('opencode2 session is not bound')
    return session
  }

  return {
    baseUrl: config.baseUrl,
    async health() {
      try {
        await request('GET', '/api/health')
        return true
      } catch {
        return false
      }
    },
    async createSession(input) {
      const model = input?.model
      const response = await request('POST', '/api/session', {
        title: input?.title,
        agent: input?.agent,
        location: { directory: config.directory },
        ...(model
          ? {
              model: {
                providerID: model.providerID,
                id: model.id,
                variant: model.variant,
              },
            }
          : {}),
      })
      const row = ((await response.json()) as { data: OpencodeSession }).data
      session = row.id
      return row
    },
    async getSession(sessionId) {
      session = sessionId
      const response = await request('GET', `/api/session/${encodeURIComponent(sessionId)}`)
      return ((await response.json()) as { data: OpencodeSession }).data
    },
    async prompt(sessionId, body: OpencodePromptBody) {
      session = sessionId
      if (body.model) {
        await request('POST', `/api/session/${encodeURIComponent(sessionId)}/model`, {
          model: {
            providerID: body.model.providerID,
            id: body.model.modelID,
            variant: body.variant,
          },
        })
      }
      if (body.agent) {
        await request('POST', `/api/session/${encodeURIComponent(sessionId)}/agent`, {
          agent: body.agent,
        })
      }
      if (body.system !== undefined) {
        await request(
          'PUT',
          `/api/session/${encodeURIComponent(sessionId)}/instructions/entries/podium-system`,
          {
            value: body.system,
          },
        )
      }
      const text = body.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
      await request('POST', `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text })
    },
    async abort(sessionId) {
      await request('POST', `/api/session/${encodeURIComponent(sessionId)}/interrupt`)
    },
    async messages(sessionId) {
      session = sessionId
      const rows: Array<Record<string, unknown>> = []
      let path = `/api/session/${encodeURIComponent(sessionId)}/message?order=asc&limit=200`
      for (;;) {
        const response = await request('GET', path)
        const page = (await response.json()) as {
          data?: Array<Record<string, unknown>>
          cursor?: { next?: string | null }
        }
        rows.push(...(page.data ?? []))
        if (!page.cursor?.next) break
        path = `/api/session/${encodeURIComponent(
          sessionId,
        )}/message?limit=200&cursor=${encodeURIComponent(page.cursor.next)}`
      }
      return rows.map((row): OpencodeMessageWithParts => {
        const id = String(row.id)
        const type = String(row.type)
        const time = row.time as { created?: number; completed?: number } | undefined
        const model = row.model as { id?: string; providerID?: string } | undefined
        const content = Array.isArray(row.content)
          ? (row.content as Array<Record<string, unknown>>)
          : []
        return {
          info: {
            ...row,
            id,
            sessionID: sessionId,
            role: type === 'assistant' ? 'assistant' : type === 'system' ? 'system' : 'user',
            time,
            ...(model?.id ? { modelID: model.id } : {}),
            ...(model?.providerID ? { providerID: model.providerID } : {}),
          },
          parts: (type === 'user' ? [{ type: 'text', text: String(row.text ?? '') }] : content).map(
            (part, index) => ({
              ...part,
              id: `${id}:${index}`,
              messageID: id,
              sessionID: sessionId,
              type: String(part.type ?? 'text'),
            }),
          ),
        }
      })
    },
    async permissions() {
      const response = await request('GET', `/api/session/${encodeURIComponent(sid())}/permission`)
      const rows = ((await response.json()) as { data?: Array<Record<string, unknown>> }).data ?? []
      return rows.map((row) => ({
        id: String(row.id),
        sessionID: String(row.sessionID),
        permission: String(row.action),
        patterns: Array.isArray(row.resources) ? row.resources.map(String) : [],
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
        always: Array.isArray(row.save) ? row.save.map(String) : [],
      }))
    },
    async questions() {
      const response = await request('GET', `/api/session/${encodeURIComponent(sid())}/form`)
      const rows = ((await response.json()) as { data?: Opencode2Form[] }).data ?? []
      forms.clear()
      for (const row of rows) forms.set(row.id, row)
      return rows.map(formToQuestion)
    },
    async replyPermission(requestId, reply: OpencodePermissionReply, message) {
      await request(
        'POST',
        `/api/session/${encodeURIComponent(
          sid(),
        )}/permission/${encodeURIComponent(requestId)}/reply`,
        { reply, message },
      )
    },
    async replyQuestion(requestId: string, answers: OpencodeQuestionAnswers) {
      let form = forms.get(requestId)
      if (!form) {
        const response = await request('GET', `/api/session/${encodeURIComponent(sid())}/form`)
        const rows = ((await response.json()) as { data?: Opencode2Form[] }).data ?? []
        for (const row of rows) forms.set(row.id, row)
        form = forms.get(requestId)
      }
      if (!form) throw new Error(`opencode2 form ${requestId} is no longer pending`)
      const answer = Object.fromEntries(
        form.fields.map((field, index) => [field.key, answerForField(field, answers[index] ?? [])]),
      )
      await request(
        'POST',
        `/api/session/${encodeURIComponent(sid())}/form/${encodeURIComponent(requestId)}/reply`,
        { answer },
      )
      forms.delete(requestId)
    },
    async rejectQuestion(requestId) {
      await request(
        'POST',
        `/api/session/${encodeURIComponent(sid())}/form/${encodeURIComponent(requestId)}/cancel`,
      )
    },
    events(signal) {
      return events(request, signal)
    },
  }
}

type Opencode2FormField = {
  key: string
  type: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect' | 'external'
  title?: string
  description?: string
  options?: Array<{ value: string; label: string; description?: string }>
  custom?: boolean
}

type Opencode2Form = {
  id: string
  sessionID: string
  title: string
  fields: Opencode2FormField[]
}

function formToQuestion(form: Opencode2Form): OpencodeQuestionRequest {
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: form.fields.map((field) => {
      const options =
        field.type === 'boolean'
          ? [{ label: 'Yes' }, { label: 'No' }]
          : (field.options ?? []).map(({ label, description }) => ({
              label,
              ...(description ? { description } : {}),
            }))
      return {
        question: field.title ?? field.description ?? field.key,
        header: form.title,
        options,
        multiple: field.type === 'multiselect',
        custom:
          field.custom === true ||
          ((field.type === 'string' || field.type === 'number' || field.type === 'integer') &&
            (field.options?.length ?? 0) === 0),
      }
    }),
  }
}

function answerForField(field: Opencode2FormField, labels: readonly string[]): unknown {
  const optionValue = (label: string): string =>
    field.options?.find((option) => option.label === label)?.value ?? label
  if (field.type === 'multiselect') return labels.map(optionValue)
  const value = optionValue(labels[0] ?? '')
  if (field.type === 'boolean') return value.toLowerCase() === 'yes' || value === 'true'
  if (field.type === 'number' || field.type === 'integer') {
    const number = Number(value)
    return Number.isFinite(number) ? number : value
  }
  return value
}

async function* events(
  request: (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ) => Promise<Response>,
  signal: AbortSignal,
): AsyncIterable<OpencodeEvent> {
  const response = await request('GET', '/api/event', undefined, signal, true)
  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''
  while (!signal.aborted) {
    const next = await reader.read()
    if (next.done) return
    buffer += decoder.decode(next.value, { stream: true })
    for (;;) {
      const end = buffer.indexOf('\n\n')
      if (end < 0) break
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '))
      if (!line) continue
      const raw = JSON.parse(line.slice(6)) as {
        id?: string
        type?: string
        created?: number
        data?: Record<string, unknown>
      }
      const data = raw.data ?? {}
      const eventID = raw.id ?? `opencode2-${crypto.randomUUID()}`
      const sessionID = typeof data.sessionID === 'string' ? data.sessionID : undefined
      let mapped: OpencodeEvent | undefined
      if (raw.type === 'form.created') {
        const form = data.form as Opencode2Form | undefined
        if (form) mapped = { id: eventID, type: 'question.asked', properties: formToQuestion(form) }
      } else if (raw.type === 'form.replied' && sessionID) {
        mapped = {
          id: eventID,
          type: 'question.replied',
          properties: { sessionID, requestID: String(data.id), answers: [] },
        }
      } else if (raw.type === 'form.cancelled' && sessionID) {
        mapped = {
          id: eventID,
          type: 'question.rejected',
          properties: { sessionID, requestID: String(data.id) },
        }
      } else if (raw.type === 'permission.asked') {
        const permission = (data.request ?? data) as Record<string, unknown>
        const permissionSessionID =
          typeof permission.sessionID === 'string' ? permission.sessionID : undefined
        if (permissionSessionID) {
          mapped = {
            id: eventID,
            type: 'permission.asked',
            properties: {
              id: String(permission.id),
              sessionID: permissionSessionID,
              permission: String(permission.action),
              patterns: Array.isArray(permission.resources) ? permission.resources.map(String) : [],
              metadata: (permission.metadata ?? {}) as Record<string, unknown>,
              always: Array.isArray(permission.save) ? permission.save.map(String) : [],
            },
          }
        }
      } else if (raw.type === 'permission.replied' && sessionID) {
        mapped = {
          id: eventID,
          type: 'permission.replied',
          properties: {
            sessionID,
            requestID: String(data.id ?? data.requestID),
            reply: String(data.reply) as OpencodePermissionReply,
          },
        }
      }
      if (!mapped && raw.type === 'session.execution.started' && sessionID)
        mapped = {
          id: eventID,
          type: 'session.status',
          properties: { sessionID, status: { type: 'busy' } },
        }
      else if (!mapped && raw.type === 'session.execution.succeeded' && sessionID)
        mapped = {
          id: eventID,
          type: 'session.idle',
          properties: { sessionID },
        }
      else if (!mapped && raw.type === 'session.execution.failed' && sessionID)
        mapped = {
          id: eventID,
          type: 'session.error',
          properties: { sessionID, error: data.error ?? data },
        }
      else if (!mapped && raw.type === 'session.execution.interrupted' && sessionID)
        mapped = {
          id: eventID,
          type: 'session.error',
          properties: { sessionID, error: { name: 'MessageAborted', ...data } },
        }
      else if (raw.type === 'session.step.started' && sessionID) {
        const messageID = String(data.assistantMessageID)
        const model = data.model as { id?: string; providerID?: string } | undefined
        mapped = {
          id: eventID,
          type: 'message.updated',
          properties: {
            sessionID,
            info: {
              id: messageID,
              sessionID,
              role: 'assistant',
              time: { created: raw.created },
              modelID: model?.id,
              providerID: model?.providerID,
            },
          },
        }
      } else if (
        (raw.type === 'session.text.ended' || raw.type === 'session.reasoning.ended') &&
        sessionID
      ) {
        const messageID = String(data.assistantMessageID)
        mapped = {
          id: eventID,
          type: 'message.part.updated',
          properties: {
            sessionID,
            time: raw.created,
            part: {
              id: `${messageID}:${String(data.ordinal ?? 0)}:${raw.type}`,
              messageID,
              sessionID,
              type: raw.type === 'session.text.ended' ? 'text' : 'reasoning',
              text: String(data.text ?? ''),
            },
          },
        }
      } else if (raw.type === 'session.text.delta' && sessionID) {
        const messageID = String(data.assistantMessageID)
        mapped = {
          id: eventID,
          type: 'message.part.delta',
          properties: {
            sessionID,
            messageID,
            partID: `${messageID}:${String(data.ordinal ?? 0)}:session.text.ended`,
            field: 'text',
            delta: String(data.delta ?? ''),
          },
        }
      }
      if (mapped) yield mapped
    }
  }
}

function base64(value: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(value).toString('base64')
  return btoa(value)
}
