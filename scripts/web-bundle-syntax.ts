import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from 'acorn'

/** Parse emitted bytes, including workers without maps. ES2025 excludes decorators. */
export function browserSyntaxErrors(directory: string): { files: number; errors: string[] } {
  const errors: string[] = []
  let files = 0
  function visit(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)) {
        files++
        try {
          parse(readFileSync(file, 'utf8'), { ecmaVersion: 2025, sourceType: 'module' })
        } catch (error) {
          errors.push(
            `${relative(directory, file)}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }
  visit(directory)
  return { files, errors }
}
