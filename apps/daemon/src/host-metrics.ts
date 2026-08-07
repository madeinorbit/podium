import { readFileSync } from 'node:fs'
import { cpus, freemem, loadavg, totalmem } from 'node:os'
import type { HostLoadWire, HostMemoryWire } from '@podium/model'

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

/**
 * Kernel load averages + logical core count for the host-metrics heartbeat.
 * Policy and UI form load-per-core from load1 / cpuCount (never load5 — a
 * day-long pin leaves load5 high long after the fleet drains). On Windows
 * loadavg is [0,0,0]; still schema-valid and directionally inert.
 */
export function sampleHostLoad(): HostLoadWire {
  const [one = 0, five = 0, fifteen = 0] = loadavg()
  // At least one core so load-per-core never divides by zero on a pathological
  // report; real hosts always have ≥1.
  return {
    one,
    five,
    fifteen,
    cpuCount: Math.max(1, cpus().length),
  }
}
