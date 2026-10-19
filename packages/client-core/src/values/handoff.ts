import type { SessionId, TranscriptItem } from '@podium/model'
import type { OperatorPromptOptions } from './compose/chat'
import { isOperatorPrompt } from './compose/chat'

export interface HandoffAnchor {
  sessionId: SessionId
  itemKey: string
}

export interface HandoffTranscriptPair {
  sessionId: SessionId
  prompt: { item: TranscriptItem; anchor: HandoffAnchor }
  answer?: { item: TranscriptItem; anchor: HandoffAnchor; legacy: boolean }
}

const itemKey = (item: TranscriptItem): string => item.cursor ?? item.id

/** Pair the newest real operator prompt with the final answer from that turn. */
export function pairLatestPromptAndAnswer(
  sessionId: SessionId,
  items: readonly TranscriptItem[],
  promptOptions: OperatorPromptOptions,
): HandoffTranscriptPair | null {
  let promptIndex = -1
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item && isOperatorPrompt(item, promptOptions)) {
      promptIndex = index
      break
    }
  }
  if (promptIndex < 0) return null

  const prompt = items[promptIndex] as TranscriptItem
  const operatorText = promptOptions.operatorTextOf?.(prompt.text)
  const displayPrompt = operatorText === undefined ? prompt : { ...prompt, text: operatorText }
  const hasAnswerMarkers = items.some((item) => item.answer === true)
  let markedAnswer: TranscriptItem | undefined
  let legacyAnswer: TranscriptItem | undefined
  for (let index = promptIndex + 1; index < items.length; index += 1) {
    const item = items[index]
    if (!item) continue
    if (isOperatorPrompt(item, promptOptions)) break
    if (item.role !== 'assistant' || !item.text.trim()) continue
    if (item.answer === true) markedAnswer = item
    if (!hasAnswerMarkers) legacyAnswer = item
  }
  const answer = markedAnswer ?? legacyAnswer
  return {
    sessionId,
    prompt: {
      item: displayPrompt,
      anchor: { sessionId, itemKey: itemKey(prompt) },
    },
    ...(answer
      ? {
          answer: {
            item: answer,
            anchor: { sessionId, itemKey: itemKey(answer) },
            legacy: markedAnswer === undefined,
          },
        }
      : {}),
  }
}
