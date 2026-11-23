import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { isRecord } from '../shared/json-util.js'

export const antigravityHomeSharing = ['antigravity', []] as const

const CUSTOMIZATIONS = [
  'rules',
  'rules.json',
  'skills',
  'skills.json',
  'plugins',
  'plugins.json',
  'hooks.json',
  'mcp_config.json',
] as const
const UI_SETTINGS = [
  'colorScheme',
  'editor',
  'editorMode',
  'vimInsertFirst',
  'altScreenMode',
  'showTips',
  'showFeedbackSurvey',
] as const

/** Share the person's customizations, without sharing Google account state,
 * billing configuration, model providers, conversations, or project records. */
export function prepareAntigravityHomeLaunch(
  home: { harness: string; dir: string },
  input: { defaultDir: string },
) {
  if (home.harness !== 'antigravity') return
  const sourceConfig = join(dirname(input.defaultDir), 'config')
  for (const name of CUSTOMIZATIONS) {
    const source = join(sourceConfig, name)
    const target = join(home.dir, 'config', name)
    if (!existsSync(source)) continue
    try {
      lstatSync(target)
      continue
    } catch {
      /* Only add missing entries. */
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    try {
      symlinkSync(
        source,
        target,
        process.platform === 'win32' && lstatSync(source).isDirectory() ? 'junction' : undefined,
      )
    } catch (error) {
      if (isRecord(error) && error.code === 'EEXIST') continue
      if (
        process.platform !== 'win32' ||
        !isRecord(error) ||
        !['EPERM', 'EACCES'].includes(String(error.code)) ||
        !lstatSync(source).isFile()
      )
        throw error
      copyFileSync(source, target, constants.COPYFILE_EXCL)
    }
  }
  const target = join(home.dir, 'antigravity-cli', 'settings.json')
  if (existsSync(target)) return
  let settings: unknown = {}
  try {
    settings = JSON.parse(readFileSync(join(input.defaultDir, 'settings.json'), 'utf8'))
  } catch {
    // Leave first-run appearance and consent to the native CLI.
  }
  const source = isRecord(settings) ? settings : {}
  const projected = Object.fromEntries(
    UI_SETTINGS.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]),
  )
  if (!Object.keys(projected).length) return
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(target, `${JSON.stringify(projected, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (!isRecord(error) || error.code !== 'EEXIST') throw error
  }
}
