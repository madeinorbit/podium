export const VITE_NODE_VERSION_RANGE = '^20.19.0 || >=22.12.0'

type Problem = { what: string; fix: string }

/** Match the Node range required by the Vite version used for the desktop web build. */
export const supportsViteNodeVersion = (rawVersion: string): boolean => {
  const match = rawVersion.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return false

  const major = Number(match[1])
  const minor = Number(match[2])
  return (major === 20 && minor >= 19) || major > 22 || (major === 22 && minor >= 12)
}

export const nodePrerequisiteProblem = (version: string | null): Problem | null => {
  if (version === null) {
    return {
      what: `Node.js not found (Vite requires ${VITE_NODE_VERSION_RANGE}).`,
      fix: 'Install Node.js 22.12 or newer and make sure `node` is on PATH.',
    }
  }

  if (supportsViteNodeVersion(version)) return null

  return {
    what: `Node.js ${version} cannot run Vite (requires ${VITE_NODE_VERSION_RANGE}).`,
    fix: 'Upgrade to Node.js 22.12 or newer and make sure `node --version` reports the upgraded version.',
  }
}
