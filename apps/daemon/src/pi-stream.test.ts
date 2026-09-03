import { describe, expect, it } from 'vitest'
import { createPiStreamReducer } from './pi-stream.js'

const header =
  '{"type":"session","version":3,"id":"9e804279-978a-4644-adc4-f815f25a5728","timestamp":"2026-09-02T09:48:46.898Z","cwd":"/w"}'
const start = (responseId: string) =>
  `{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending","responseId":"${responseId}"}}`
const delta = (text: string) =>
  `{"type":"message_update","usage":{},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"${text}"}}`
const end = (text: string, stopReason = 'stop') =>
  `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}],"stopReason":"${stopReason}"}}`

describe('createPiStreamReducer', () => {
  it('captures the session id from the header line and streams partial text', () => {
    const reducer = createPiStreamReducer()
    expect(reducer.pushLine(header)).toEqual({
      sessionId: '9e804279-978a-4644-adc4-f815f25a5728',
    })
    expect(reducer.pushLine(start('r1'))).toBeUndefined()
    expect(reducer.pushLine(delta('Reply '))).toEqual({ partialText: 'Reply ', itemHint: 'r1' })
    expect(reducer.pushLine(delta('#2'))).toEqual({ partialText: 'Reply #2', itemHint: 'r1' })
    expect(reducer.pushLine(end('Reply #2 '))).toEqual({ partialText: 'Reply #2', itemHint: 'r1' })
    expect(reducer.result()).toEqual({
      sessionId: '9e804279-978a-4644-adc4-f815f25a5728',
      output: 'Reply #2',
    })
  })

  it('reports tool starts and keeps the LAST assistant text as the answer', () => {
    const reducer = createPiStreamReducer()
    reducer.pushLine(header)
    reducer.pushLine(start('r1'))
    reducer.pushLine(
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"ls"}}],"stopReason":"toolUse"}}',
    )
    expect(
      reducer.pushLine(
        '{"type":"tool_execution_start","toolCallId":"call_1","toolName":"bash","args":{"command":"ls"}}',
      ),
    ).toEqual({ toolLabel: 'bash' })
    // The user echo and tool result messages are not answers.
    reducer.pushLine(
      '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"q"}]}}',
    )
    reducer.pushLine(
      '{"type":"message_end","message":{"role":"toolResult","toolCallId":"call_1","content":[{"type":"text","text":"a\\n"}]}}',
    )
    reducer.pushLine(start('r2'))
    reducer.pushLine(end('Found it.'))
    expect(reducer.result().output).toBe('Found it.')
  })

  it('turns a provider failure into an error even though pi exits 0', () => {
    const reducer = createPiStreamReducer()
    reducer.pushLine(header)
    reducer.pushLine(
      '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"500: simulated provider outage"}}',
    )
    reducer.pushLine('{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000}')
    reducer.pushLine(
      '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"500: simulated provider outage"}}',
    )
    reducer.pushLine(
      '{"type":"auto_retry_end","success":false,"attempt":3,"finalError":"500: simulated provider outage"}',
    )
    reducer.pushLine('{"type":"agent_settled"}')
    expect(reducer.result()).toEqual({
      sessionId: '9e804279-978a-4644-adc4-f815f25a5728',
      output: '',
      error: '500: simulated provider outage',
    })
  })

  it('a successful retry clears an earlier error', () => {
    const reducer = createPiStreamReducer()
    reducer.pushLine(header)
    reducer.pushLine(end('', 'error'))
    reducer.pushLine(start('r2'))
    reducer.pushLine(end('Recovered.'))
    expect(reducer.result()).toEqual({
      sessionId: '9e804279-978a-4644-adc4-f815f25a5728',
      output: 'Recovered.',
    })
  })

  it('ignores blank and unparseable lines', () => {
    const reducer = createPiStreamReducer()
    expect(reducer.pushLine('')).toBeUndefined()
    expect(reducer.pushLine('Warning: creating a new session')).toBeUndefined()
    expect(reducer.result()).toEqual({ output: '' })
  })
})
