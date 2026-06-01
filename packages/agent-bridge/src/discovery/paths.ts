import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve } from 'node:path'

export function expandHome(input: string, homeDir: string): string {
  if (input === '~') return homeDir
  if (input.startsWith('~/')) return join(homeDir, input.slice(2))
  return input
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false
    throw error
  }
}

export async function canonicalPath(path: string): Promise<string> {
  const absolute = isAbsolute(path) ? normalize(path) : resolve(path)

  try {
    return await realpath(absolute)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return absolute
    throw error
  }
}

export async function listFilesRecursive(
  root: string,
  accept: (filePath: string) => boolean,
): Promise<string[]> {
  const files: string[] = []

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && accept(fullPath)) {
        files.push(fullPath)
      }
    }
  }

  await walk(root)
  return files
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
