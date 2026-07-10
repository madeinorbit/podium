import {
  Braces,
  Database,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileImage,
  FileLock,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  type LucideIcon,
} from 'lucide-react'
import type { JSX } from 'react'

/** ext (lowercase, no dot) → icon + accent class. Kept small on purpose: the
 *  goal is scannability (code vs doc vs media vs config), not per-language art. */
const BY_EXT: Record<string, { icon: LucideIcon; className: string }> = {
  ts: { icon: FileCode, className: 'text-sky-400' },
  tsx: { icon: FileCode, className: 'text-sky-400' },
  js: { icon: FileCode, className: 'text-yellow-400' },
  jsx: { icon: FileCode, className: 'text-yellow-400' },
  mjs: { icon: FileCode, className: 'text-yellow-400' },
  cjs: { icon: FileCode, className: 'text-yellow-400' },
  py: { icon: FileCode, className: 'text-emerald-400' },
  rs: { icon: FileCode, className: 'text-orange-400' },
  go: { icon: FileCode, className: 'text-cyan-400' },
  c: { icon: FileCode, className: 'text-blue-400' },
  h: { icon: FileCode, className: 'text-blue-400' },
  cpp: { icon: FileCode, className: 'text-blue-400' },
  java: { icon: FileCode, className: 'text-red-400' },
  rb: { icon: FileCode, className: 'text-red-400' },
  php: { icon: FileCode, className: 'text-indigo-400' },
  swift: { icon: FileCode, className: 'text-orange-400' },
  kt: { icon: FileCode, className: 'text-purple-400' },
  html: { icon: FileCode, className: 'text-orange-400' },
  htm: { icon: FileCode, className: 'text-orange-400' },
  css: { icon: FileType, className: 'text-sky-300' },
  scss: { icon: FileType, className: 'text-pink-400' },
  json: { icon: Braces, className: 'text-yellow-300' },
  jsonc: { icon: Braces, className: 'text-yellow-300' },
  yaml: { icon: FileCog, className: 'text-fuchsia-300' },
  yml: { icon: FileCog, className: 'text-fuchsia-300' },
  toml: { icon: FileCog, className: 'text-fuchsia-300' },
  ini: { icon: FileCog, className: 'text-muted-foreground' },
  env: { icon: FileCog, className: 'text-muted-foreground' },
  md: { icon: FileText, className: 'text-blue-300' },
  mdx: { icon: FileText, className: 'text-blue-300' },
  txt: { icon: FileText, className: 'text-muted-foreground' },
  pdf: { icon: FileText, className: 'text-red-400' },
  png: { icon: FileImage, className: 'text-violet-400' },
  jpg: { icon: FileImage, className: 'text-violet-400' },
  jpeg: { icon: FileImage, className: 'text-violet-400' },
  gif: { icon: FileImage, className: 'text-violet-400' },
  webp: { icon: FileImage, className: 'text-violet-400' },
  svg: { icon: FileImage, className: 'text-violet-400' },
  ico: { icon: FileImage, className: 'text-violet-400' },
  mp4: { icon: FileVideo, className: 'text-rose-400' },
  webm: { icon: FileVideo, className: 'text-rose-400' },
  mov: { icon: FileVideo, className: 'text-rose-400' },
  mp3: { icon: FileAudio, className: 'text-rose-300' },
  wav: { icon: FileAudio, className: 'text-rose-300' },
  zip: { icon: FileArchive, className: 'text-amber-400' },
  gz: { icon: FileArchive, className: 'text-amber-400' },
  tar: { icon: FileArchive, className: 'text-amber-400' },
  sh: { icon: FileTerminal, className: 'text-green-400' },
  bash: { icon: FileTerminal, className: 'text-green-400' },
  zsh: { icon: FileTerminal, className: 'text-green-400' },
  sql: { icon: Database, className: 'text-teal-400' },
  db: { icon: Database, className: 'text-teal-400' },
  sqlite: { icon: Database, className: 'text-teal-400' },
  lock: { icon: FileLock, className: 'text-muted-foreground' },
}

/** Filetype icon for a filename, matched by extension (dotfiles → config icon). */
export function FileTypeIcon({ name, size = 14 }: { name: string; size?: number }): JSX.Element {
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? lower.split('.').pop()! : ''
  const m = BY_EXT[ext] ?? (lower.startsWith('.') ? { icon: FileCog, className: 'text-muted-foreground' } : { icon: FileIcon, className: 'text-muted-foreground' })
  const Icon = m.icon
  return <Icon size={size} className={`flex-none ${m.className}`} aria-hidden="true" />
}
