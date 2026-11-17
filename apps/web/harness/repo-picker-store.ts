/**
 * THE ADD-REPOSITORY PICKER, WITH NO SERVER (POD-6869).
 *
 * `vite.repo-picker-harness.config.ts` points the picker's settings access and
 * settings readers here. `repos.browse` answers one fixed folder listing and
 * `repos.githubList` one signed-in GitHub CLI, so both sources render as a
 * connected machine shows them.
 */
import type { Dispatch, SetStateAction } from 'react'
import { useState } from 'react'

const home = '/home/ada'

const browse = async ({ path }: { path?: string }) => ({
  path: path ?? `${home}/src`,
  homePath: home,
  parentPath: home,
  entries: [
    { name: 'atlas', path: `${home}/src/atlas`, isRepo: true },
    { name: 'notes', path: `${home}/src/notes` },
    { name: 'podium', path: `${home}/src/podium`, isRepo: true },
  ],
})

const githubList = async () => ({
  status: { state: 'ready', login: 'ada' },
  repositories: [
    {
      nameWithOwner: 'ada/atlas',
      description: 'Maps and routing',
      isPrivate: false,
      url: 'https://github.com/ada/atlas',
      pushedAt: '2026-11-10T09:00:00.000Z',
    },
  ],
})

const trpc = { repos: { browse: { query: browse }, githubList: { query: githubList } } }

export const useSettingsTrpc = () => trpc as never
export const useSettingsClient = () => ({ trpc, uiState: null }) as never

export function useSettingsDraft<T>(
  _key: string,
  parse: (raw: string | null) => T,
): [T, Dispatch<SetStateAction<T>>] {
  return useState(() => parse(null))
}
