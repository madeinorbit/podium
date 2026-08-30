import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'modules/podium-speech/ios/PodiumSpeechModule.swift'),
  'utf8',
)

function sourceBetween(start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)

  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('PodiumSpeech audio buffering', () => {
  it('gives both audio streams fixed FIFO capacities', () => {
    expect(source).toContain('private static let capturedAudioBufferLimit = 16')
    expect(source).toContain('private static let analyzerInputBufferLimit = 32')
    expect(source).toMatch(
      /of: AnalyzerInput\.self,\s+bufferingPolicy: \.bufferingOldest\(Self\.analyzerInputBufferLimit\)/,
    )
    expect(source).toMatch(
      /of: AVAudioPCMBuffer\.self,\s+bufferingPolicy: \.bufferingOldest\(Self\.capturedAudioBufferLimit\)/,
    )
    expect(source).not.toContain('.bufferingNewest(')
  })

  it('turns a microphone queue drop into one recoverable abort', () => {
    const failure = sourceBetween(
      'static var audioBacklogOverflow',
      '@available(iOS 26.0, *)',
    )
    expect(failure).toContain('code: "audio_backlog_overflow"')
    expect(failure).toContain('recoverable: true')

    const overflowHandler = sourceBetween(
      'let stopForOverflow: @Sendable () -> Void',
      'inputNode.installTap',
    )
    expect(overflowHandler).toContain('guard overflowLatch.signal() else { return }')
    expect(overflowHandler).toContain('audioContinuation.finish()')
    expect(overflowHandler).toContain('await self?.abort(')
    expect(overflowHandler).toContain('reason: .audioBacklogOverflow')
    expect(overflowHandler).toContain('notify: true')

    const tap = sourceBetween('inputNode.installTap', 'audioTapInstalled = true')
    expect(tap).toContain('switch audioContinuation.yield(buffer)')
    expect(tap).toMatch(/case \.dropped:\s+stopForOverflow\(\)/)
    expect(tap).toMatch(/case \.terminated:\s+break/)
  })

  it('checks every converted analyzer input and fails on a drop', () => {
    const analyzerYield = sourceBetween(
      'private func yieldAnalyzerInput(',
      'private func consume(',
    )
    expect(analyzerYield).toContain(
      'switch continuation.yield(AnalyzerInput(buffer: buffer))',
    )
    expect(analyzerYield).toMatch(
      /case \.dropped:\s+throw PodiumSpeechFailure\.audioBacklogOverflow/,
    )
    expect(analyzerYield).toMatch(/case \.terminated:\s+throw CancellationError\(\)/)
    expect(source.match(/try yieldAnalyzerInput\(/g)).toHaveLength(2)
    expect(source.match(/continuation\.yield\(AnalyzerInput/g)).toHaveLength(1)
  })

  it('does not finalize successfully when Stop races with microphone overflow', () => {
    const stop = sourceBetween(
      'func stop(clientGeneration: Int) async throws',
      'func cancel(clientGeneration: Int) async',
    )
    const overflowCheck = stop.indexOf('audioOverflowLatch?.hasOverflowed == true')
    const converterFlush = stop.indexOf('try flushConverter()')

    expect(overflowCheck).toBeGreaterThanOrEqual(0)
    expect(converterFlush).toBeGreaterThan(overflowCheck)
    expect(stop).toContain('throw PodiumSpeechFailure.audioBacklogOverflow')
  })
})
