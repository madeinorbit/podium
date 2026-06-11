import { readFileSync } from 'node:fs'
import { freemem, totalmem } from 'node:os'
import type { HostMemoryWire } from '@podium/protocol'

const MEMINFO_PATH = '/proc/meminfo'

function kbField(text: string, name: string): number | undefined {
  const m = text.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm'))
  return m ? Number(m[1]) * 1024 : undefined
}

/**
 * Extract the memory sample from /proc/meminfo content. MemAvailable is the
 * kernel's "allocatable without swapping" estimate — the right "used" baseline
 * (used = total − available); subtracting MemFree would count page cache as
 * pressure. Returns undefined when the format isn't usable (caller falls back).
 */
export function parseMeminfo(text: string): HostMemoryWire | undefined {
  const totalBytes = kbField(text, 'MemTotal')
  const availableBytes = kbField(text, 'MemAvailable')
  if (totalBytes === undefined || availableBytes === undefined) return undefined
  return {
    totalBytes,
    availableBytes,
    swapTotalBytes: kbField(text, 'SwapTotal') ?? 0,
    swapFreeBytes: kbField(text, 'SwapFree') ?? 0,
  }
}

/**
 * Sample this machine's memory. Prefers /proc/meminfo; elsewhere (macOS, or an
 * unreadable proc) falls back to os.totalmem/freemem — pessimistic about cache
 * but never wrong about capacity — with swap unknown (reported as 0).
 */
export function sampleHostMemory(meminfoPath: string = MEMINFO_PATH): HostMemoryWire {
  try {
    const parsed = parseMeminfo(readFileSync(meminfoPath, 'utf8'))
    if (parsed) return parsed
  } catch {
    // fall through to the os fallback
  }
  return { totalBytes: totalmem(), availableBytes: freemem(), swapTotalBytes: 0, swapFreeBytes: 0 }
}
