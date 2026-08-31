import { describe, expect, it, vi } from 'vitest'
import {
  releaseBuildTimingEnvironment,
  releaseBuildTimingFileName,
  timeReleaseBuild,
  timeReleaseBuildSync,
  type ReleaseBuildTimingRecord,
} from './release-build-timing'

describe('release build timing', () => {
  it('gives development versions a filesystem-safe staging identity', () => {
    expect(releaseBuildTimingFileName('0.1.1-dev.24+421a3ae')).toBe(
      '0.1.1-dev.24-421a3ae.jsonl',
    )
  })

  it('is default-off and does not even read the clock', () => {
    const now = vi.fn(() => 1)
    const emit = vi.fn()
    const result = timeReleaseBuildSync(
      { granularity: 'phase', phase: 'web-packaging' },
      () => 'unchanged',
      { env: {}, now, emit },
    )

    expect(result).toBe('unchanged')
    expect(now).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('records monotonic success and failure without changing results', async () => {
    const records: ReleaseBuildTimingRecord[] = []
    const readings = [10, 14.25, 20, 29]
    const deps = {
      enabled: true,
      now: () => readings.shift() as number,
      emit: (record: ReleaseBuildTimingRecord) => records.push(record),
      context: { channel: 'dev' as const, version: '0.4.3-dev.7+abc1234', sourceSha: 'abc1234' },
    }

    await expect(
      timeReleaseBuild(
        { granularity: 'task', phase: 'validation', task: 'source-identity' },
        async () => 42,
        deps,
      ),
    ).resolves.toBe(42)
    const failure = new Error('compile failed')
    await expect(
      timeReleaseBuild(
        { granularity: 'task', phase: 'headless-platform-build', task: 'compile-cli' },
        async () => {
          throw failure
        },
        deps,
      ),
    ).rejects.toBe(failure)

    expect(records).toEqual([
      expect.objectContaining({
        phase: 'validation',
        task: 'source-identity',
        outcome: 'success',
        durationMs: 4.25,
      }),
      expect.objectContaining({
        phase: 'headless-platform-build',
        task: 'compile-cli',
        outcome: 'failure',
        durationMs: 9,
      }),
    ])
  })

  it('fails open when the clock or evidence sink fails', () => {
    expect(
      timeReleaseBuildSync({ granularity: 'phase', phase: 'signing' }, () => 'built', {
        enabled: true,
        now: () => {
          throw new Error('clock')
        },
      }),
    ).toBe('built')

    expect(
      timeReleaseBuildSync({ granularity: 'phase', phase: 'signing' }, () => 'built', {
        enabled: true,
        now: vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(2),
        emit: () => {
          throw new Error('disk full')
        },
      }),
    ).toBe('built')
  })

  it('enables only opted-in child processes with the approved release identity', () => {
    expect(
      releaseBuildTimingEnvironment(
        { enabled: true, outputDirectory: '/release-evidence' },
        {
          channel: 'dev',
          version: '0.4.3-dev.7+abc1234',
          sourceSha: 'abc1234',
        },
      ),
    ).toEqual({
      PODIUM_RELEASE_BUILD_TIMING: '1',
      PODIUM_RELEASE_TIMING_DIR: '/release-evidence',
      PODIUM_RELEASE_CHANNEL: 'dev',
      PODIUM_RELEASE_TIMING_VERSION: '0.4.3-dev.7+abc1234',
      PODIUM_RELEASE_TIMING_SHA: 'abc1234',
    })
    expect(
      releaseBuildTimingEnvironment(
        { enabled: false, outputDirectory: '/release-evidence' },
        { channel: 'dev', version: 'ignored', sourceSha: 'ignored' },
      ),
    ).toEqual({})
  })
})
