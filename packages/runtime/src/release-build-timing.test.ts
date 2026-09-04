import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  emitReleaseBuildTiming,
  mintReleaseTimingRunId,
  type ReleaseBuildTimingRecord,
  releaseBuildTimingEnvironment,
  releaseBuildTimingFileName,
  timeReleaseBuild,
  timeReleaseBuildSync,
} from './release-build-timing'

describe('release build timing', () => {
  it('gives development versions a filesystem-safe staging identity', () => {
    expect(releaseBuildTimingFileName('0.1.1-dev.24+421a3ae')).toBe('0.1.1-dev.24-421a3ae.jsonl')
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

  it('separates two attempts at one version into two staging files', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-release-timing-'))
    const line = (runId: string) =>
      ({
        evidence: 'release-build-timing',
        granularity: 'phase',
        phase: 'approval-to-publish',
        outcome: 'success',
        durationMs: 1,
        runId,
        version: '0.4.3-dev.29+09743a0',
        sourceSha: '09743a0',
      }) as const
    for (const runId of ['run-one', 'run-two'])
      emitReleaseBuildTiming(line(runId), { outputDirectory: root, log: () => {} })

    expect(readdirSync(root).sort()).toEqual(['run-one.jsonl', 'run-two.jsonl'])
    expect(JSON.parse(readFileSync(join(root, 'run-one.jsonl'), 'utf8'))).toMatchObject({
      version: '0.4.3-dev.29+09743a0',
      sourceSha: '09743a0',
    })
  })

  it('keys a child process line by the run id it inherited', () => {
    const root = mkdtempSync(join(tmpdir(), 'podium-release-timing-child-'))
    timeReleaseBuildSync({ granularity: 'phase', phase: 'client-bundle' }, () => 'built', {
      enabled: true,
      outputDirectory: root,
      log: () => {},
      now: vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(2),
      env: {
        PODIUM_RELEASE_TIMING_RUN: 'inherited-run',
        PODIUM_RELEASE_TIMING_VERSION: '0.4.3-dev.29+09743a0',
        PODIUM_RELEASE_TIMING_SHA: '09743a0',
      },
    })

    expect(readdirSync(root)).toEqual(['inherited-run.jsonl'])
    expect(JSON.parse(readFileSync(join(root, 'inherited-run.jsonl'), 'utf8'))).toMatchObject({
      runId: 'inherited-run',
      version: '0.4.3-dev.29+09743a0',
      sourceSha: '09743a0',
    })
  })

  it('mints a distinct run id per attempt within the same second', () => {
    const now = () => Date.UTC(2026, 7, 30, 20, 58, 14)
    const first = mintReleaseTimingRunId({ now, random: () => 0.123456 })
    const second = mintReleaseTimingRunId({ now, random: () => 0.654321 })
    expect(first).toMatch(/^20260830205814Z-[0-9a-z]{6}$/)
    expect(second).not.toBe(first)
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
        { enabled: true, outputDirectory: '/release-evidence' },
        {
          channel: 'dev',
          version: '0.4.3-dev.7+abc1234',
          sourceSha: 'abc1234',
          runId: '20260830205814Z-a1b2c3',
        },
      ),
    ).toMatchObject({ PODIUM_RELEASE_TIMING_RUN: '20260830205814Z-a1b2c3' })
    expect(
      releaseBuildTimingEnvironment(
        { enabled: false, outputDirectory: '/release-evidence' },
        { channel: 'dev', version: 'ignored', sourceSha: 'ignored' },
      ),
    ).toEqual({})
  })
})
