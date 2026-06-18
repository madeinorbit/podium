import { describe, expect, it } from 'vitest'
import { cursorProjectPathFromSlug, cursorProjectSlug, cursorSessionPaths } from './paths.js'

describe('cursor paths', () => {
  it('builds the project slug Cursor uses on disk', () => {
    expect(cursorProjectSlug('/home/user/src/other/podium')).toBe('home-user-src-other-podium')
  })

  it('decodes a slug back to an absolute path', () => {
    expect(cursorProjectPathFromSlug('home-user-src-other-podium')).toBe(
      '/home/user/src/other/podium',
    )
  })

  it('derives transcript paths from cwd and chat id', () => {
    expect(
      cursorSessionPaths({
        homeDir: '/home/tester',
        cwd: '/home/user/src/other/podium',
        chatId: '6ae2e968-64a4-40c7-9a9e-c4b2eba17511',
      }),
    ).toEqual({
      chatId: '6ae2e968-64a4-40c7-9a9e-c4b2eba17511',
      projectSlug: 'home-user-src-other-podium',
      transcriptPath:
        '/home/tester/.cursor/projects/home-user-src-other-podium/agent-transcripts/6ae2e968-64a4-40c7-9a9e-c4b2eba17511/6ae2e968-64a4-40c7-9a9e-c4b2eba17511.jsonl',
    })
  })
})