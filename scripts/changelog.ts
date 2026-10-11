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
function extractUnreleased(markdown: string): ReleaseNotes | null {
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
 * The notes a release of `version` ships with: its own section, or — for an edge build, which
 * is a preview of what is not released yet — the `## [Unreleased]` section (POD-5969). Edge cuts
 * do not promote Unreleased (that is the stable cut's job), so without this every edge build
 * shipped with no notes at all. A stable version never falls back: shipping Unreleased as the
 * notes of what someone just installed would misdescribe it.
 */
export function releaseNotesFor(markdown: string, version: string): ReleaseNotes | null {
  return (
    extractRelease(markdown, version) ??
    (/-edge\.\d+$/.test(version) ? extractUnreleased(markdown) : null)
  )
}
