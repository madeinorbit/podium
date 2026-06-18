import { describe, expect, it } from 'vitest'
import {
  ControlMessage,
  DaemonMessage,
  FileReadRequestMessage,
  FileReadResultMessage,
  FileWriteRequestMessage,
  FileWriteResultMessage,
  TranscriptItem,
} from './messages'

describe('file RPC messages', () => {
  it('parses a fileReadRequest with the knownPath flag', () => {
    const msg = {
      type: 'fileReadRequest',
      requestId: 'fr1',
      cwd: '/repo',
      path: '/repo/a.ts',
      knownPath: false,
    }
    expect(FileReadRequestMessage.parse(msg)).toEqual(msg)
    expect(ControlMessage.parse(msg)).toEqual(msg)
  })

  it('parses a fileReadResult carrying content + baseHash', () => {
    const msg = {
      type: 'fileReadResult',
      requestId: 'fr1',
      ok: true,
      path: '/repo/a.ts',
      content: 'hi',
      baseHash: '123:2',
    }
    expect(FileReadResultMessage.parse(msg)).toMatchObject({ ok: true, content: 'hi' })
    expect(DaemonMessage.parse(msg)).toMatchObject({ type: 'fileReadResult' })
  })

  it('parses a fileWriteRequest and a conflict result', () => {
    expect(
      FileWriteRequestMessage.parse({
        type: 'fileWriteRequest',
        requestId: 'fw1',
        cwd: '/repo',
        path: '/repo/a.ts',
        content: 'x',
        baseHash: '1:1',
      }).type,
    ).toBe('fileWriteRequest')
    expect(
      FileWriteResultMessage.parse({ type: 'fileWriteResult', requestId: 'fw1', ok: false, conflict: true })
        .conflict,
    ).toBe(true)
  })

  it('TranscriptItem accepts optional toolPaths', () => {
    const item = TranscriptItem.parse({ id: '1', role: 'tool', text: '', toolPaths: ['/repo/a.ts'] })
    expect(item.toolPaths).toEqual(['/repo/a.ts'])
  })
})
