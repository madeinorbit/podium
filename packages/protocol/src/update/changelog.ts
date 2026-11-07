export type ReleaseNotes = { summary: string }

const VERSION_HEADING = /^##[ \t]+(.+?)[ \t]*$/gm

function headingVersion(title: string): string | undefined {
  const bracketed = title.match(/^\[([^\]]+)\]/)
  if (bracketed) return bracketed[1]

  const plain = title.match(/^(\S+)/)
  return plain?.[1]
}

/** Extract the Keep a Changelog section for one released version. */
export function extractRelease(markdown: string, version: string): ReleaseNotes | null {
  if (version.toLowerCase() === 'unreleased') return null

  const headings = [...markdown.matchAll(VERSION_HEADING)]
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    if (!heading) continue
    if (headingVersion(heading[1] ?? '') !== version) continue

    const headingStart = heading.index ?? 0
    const sectionStart = headingStart + heading[0].length
    const sectionEnd = headings[index + 1]?.index ?? markdown.length
    const summary = markdown.slice(sectionStart, sectionEnd).trim()
    return summary ? { summary } : null
  }

  return null
}

/** The `## [Unreleased]` section, or null when it is missing or empty. */
export function extractUnreleased(markdown: string): ReleaseNotes | null {
  const headings = [...markdown.matchAll(VERSION_HEADING)]
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]
    if (!heading || headingVersion(heading[1] ?? '')?.toLowerCase() !== 'unreleased') continue
    const sectionStart = (heading.index ?? 0) + heading[0].length
    const sectionEnd = headings[index + 1]?.index ?? markdown.length
    const summary = markdown.slice(sectionStart, sectionEnd).trim()
    return summary ? { summary } : null
  }
  return null
}

/**
 * A preview build: an edge cut (`0.3.0-edge.2`), a publisher dev mint (`0.2.0-dev.76+bcca0ff`)
 * or a legacy dev identity (`dev+bcca0ff`). Each is a preview of what is not released yet.
 */
const PREVIEW_VERSION = /(?:-(?:edge|dev)\.\d+(?:\+[0-9A-Za-z.-]+)?|^dev\+[0-9A-Za-z.-]+)$/

/**
 * The notes a release of `version` ships with: its own section, or — for a preview build — the
 * `## [Unreleased]` section (POD-5969 for edge, this issue's dev builds). Edge cuts do not promote
 * Unreleased (that is the stable cut's job), and a dev build is cut from whatever has landed, so
 * without this every preview shipped with no notes at all. A stable version never falls back:
 * shipping Unreleased as the notes of what someone just installed would misdescribe it.
 */
export function releaseNotesFor(markdown: string, version: string): ReleaseNotes | null {
  return (
    extractRelease(markdown, version) ??
    (PREVIEW_VERSION.test(version) ? extractUnreleased(markdown) : null)
  )
}
