import { execFileSync } from 'node:child_process'

/** Upload the advertisement only after all named bytes exist. Keep old rolling assets. */
export function publishReleaseAssets(
  p: {
    tag: string
    artifacts: string[]
    manifest: string
    /** Fixed installer names are replaced after the new manifest stops naming the old ones. */
    aliases?: string[]
  },
  run: (args: string[]) => void = (args) => {
    execFileSync('gh', args)
  },
): void {
  run(['release', 'upload', p.tag, ...p.artifacts, '--clobber'])
  run(['release', 'upload', p.tag, p.manifest, '--clobber'])
  if (p.aliases?.length) run(['release', 'upload', p.tag, ...p.aliases, '--clobber'])
}
