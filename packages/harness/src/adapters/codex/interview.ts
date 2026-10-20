import { isRecord } from '../shared/json-util'

export const CODEX_ASYNC_QUESTION_TOOL = 'request_user_input_async'

export interface CodexQuestionReply {
  answer: string
  question: string
  questionItemId: string
  callId: string
  questionIndex: number
}

/** Codex emits both wrapped native replies and bare JSON reply arrays. */
export function parseCodexQuestionReplies(text: string): CodexQuestionReply[] | null {
  const body = text
    .trim()
    .replace(
      /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/,
      '$1',
    )
  if (!body.startsWith('[')) return null
  try {
    const values: unknown = JSON.parse(body)
    if (!Array.isArray(values) || values.length === 0) return null
    const replies: CodexQuestionReply[] = []
    for (const value of values) {
      if (
        !isRecord(value) ||
        typeof value.answer !== 'string' ||
        typeof value.question !== 'string' ||
        typeof value.questionItemId !== 'string'
      )
        return null
      const id: unknown = JSON.parse(value.questionItemId)
      if (
        !Array.isArray(id) ||
        id.length !== 3 ||
        id[0] !== CODEX_ASYNC_QUESTION_TOOL ||
        typeof id[1] !== 'string' ||
        id[1] === '' ||
        !Number.isInteger(id[2]) ||
        id[2] < 0
      )
        return null
      replies.push({
        answer: value.answer,
        question: value.question,
        questionItemId: value.questionItemId,
        callId: id[1],
        questionIndex: id[2],
      })
    }
    return replies
  } catch {
    return null
  }
}

/** Display only; callers retain the original text for delivery receipt matching. */
export function codexQuestionReplyText(text: string): string | undefined {
  return parseCodexQuestionReplies(text)
    ?.map((reply) => reply.answer)
    .join('\n\n')
}

/** Translate the async tool's title/string-options format into the shared card input. */
export function codexAsyncQuestionInput(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.questions)) return undefined
  const questions = []
  for (const q of input.questions) {
    if (
      !isRecord(q) ||
      typeof q.title !== 'string' ||
      !q.title.trim() ||
      (q.options !== undefined &&
        (!Array.isArray(q.options) || q.options.some((o) => typeof o !== 'string')))
    )
      return undefined
    questions.push({
      question: q.title,
      options: ((q.options ?? []) as string[]).map((label) => ({ label })),
    })
  }
  return { questions }
}
