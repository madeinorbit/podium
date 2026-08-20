/**
 * Make Tauri's Linux AppImage portable across the supported distro range.
 *
 * linuxdeploy follows GTK/WebKit dependencies too aggressively and bundles old platform
 * infrastructure from the build image. On Mesa 25+/GLib 2.88 systems those copies are loaded
 * beside newer host libraries: WebKit aborts with EGL_BAD_PARAMETER, or a host GIO module loads
 * against an incompatible bundled dependency. Keep application libraries in the AppImage, but
 * let the host provide this ABI-stable platform layer, then rebuild and re-sign the updater
 * artifact. See tauri-apps/tauri#15665.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const scriptDir = import.meta.dirname
const desktopRoot = resolve(scriptDir, '..')
const repositoryRoot = resolve(desktopRoot, '../..')

/**
 * Libraries supplied by every supported Linux desktop, and unsafe to mix across distro eras.
 *
 * The first group is the upstream Tauri reproducer's platform-infrastructure set. The second is
 * the exact dependency overlap observed when Ubuntu 26.04's GIO proxy module loaded its system
 * libcurl while linuxdeploy placed Ubuntu 22.04 networking libraries first on LD_LIBRARY_PATH.
 */
export const incompatibleAppImageLibraryPrefixes = [
  'libwayland-',
  'libglib-2.0',
  'libgio-2.0',
  'libgobject-2.0',
  'libgmodule-2.0',
  'libgst',
  'libmount',
  'libblkid',
  'libselinux',
  'libpcre2-8',
  'libzstd',
  'libelf',
  'libffi',
  'libbrotlicommon',
  'libbrotlidec',
  'libgnutls',
  'libgssapi_krb5',
  'libhogweed',
  'libidn2',
  'libk5crypto',
  'libkeyutils',
  'libkrb5',
  'libkrb5support',
  'libnettle',
  'libnghttp2',
  'libp11-kit',
  'libpsl',
  'libtasn1',
] as const

export function isIncompatibleAppImageLibrary(name: string): boolean {
  return incompatibleAppImageLibraryPrefixes.some((prefix) => name.startsWith(prefix))
}

export function incompatibleAppImageLibraries(libraryDir: string): string[] {
  if (!existsSync(libraryDir))
    throw new Error(`AppImage library directory is missing: ${libraryDir}`)
  return readdirSync(libraryDir)
    .filter((name) => {
      if (!isIncompatibleAppImageLibrary(name)) return false
      const entry = join(libraryDir, name)
      return lstatSync(entry).isFile() || lstatSync(entry).isSymbolicLink()
    })
    .sort()
}

export function removeIncompatibleAppImageLibraries(libraryDir: string): string[] {
  const names = incompatibleAppImageLibraries(libraryDir)
  for (const name of names) rmSync(join(libraryDir, name), { force: true })
  return names
}

function exactlyOneAppImage(directory: string): string {
  const matches = readdirSync(directory)
    .filter((name) => name.endsWith('.AppImage'))
    .map((name) => join(directory, name))
  if (matches.length !== 1) {
    throw new Error(`expected exactly one AppImage in ${directory}; found ${matches.length}`)
  }
  return matches[0] ?? ''
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${basename(command)} ${args.join(' ')} exited ${result.status ?? 'without status'}`,
    )
  }
}

function packageVersion(): string {
  const parsed = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof parsed.version !== 'string' || !parsed.version) {
    throw new Error('root package.json has no release version')
  }
  return parsed.version
}

export function finalizeLinuxAppImage(input?: {
  bundleDir?: string
  appImagePlugin?: string
  tauriCli?: string
}): void {
  if (process.platform !== 'linux') return

  const bundleDir =
    input?.bundleDir ?? join(desktopRoot, 'src-tauri/target/release/bundle/appimage')
  const appImagePath = exactlyOneAppImage(bundleDir)
  const signaturePath = `${appImagePath}.sig`
  const hadDetachedSignature = existsSync(signaturePath)
  const scratch = mkdtempSync(join(bundleDir, '.podium-portable-'))

  try {
    chmodSync(appImagePath, 0o755)
    run(appImagePath, ['--appimage-extract'], {
      cwd: scratch,
      env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
    })

    const appDir = join(scratch, 'squashfs-root')
    const libraryDir = join(appDir, 'usr/lib')
    const removed = removeIncompatibleAppImageLibraries(libraryDir)
    if (removed.length === 0) {
      console.log('[podium] AppImage platform libraries already portable; keeping Tauri artifact')
      return
    }
    console.log(`[podium] removed ${removed.length} host platform libraries from AppImage`)
    if (incompatibleAppImageLibraries(libraryDir).length !== 0) {
      throw new Error('AppImage still contains incompatible host platform libraries')
    }

    const plugin =
      input?.appImagePlugin ??
      process.env.PODIUM_APPIMAGE_PLUGIN ??
      join(homedir(), '.cache/tauri/linuxdeploy-plugin-appimage.AppImage')
    if (!existsSync(plugin)) throw new Error(`Tauri AppImage plugin is missing: ${plugin}`)
    chmodSync(plugin, 0o755)
    const version = packageVersion()
    run(plugin, [`--appdir=${appDir}`], {
      cwd: scratch,
      env: {
        ...process.env,
        APPIMAGE_EXTRACT_AND_RUN: '1',
        ARCH: 'x86_64',
        LINUXDEPLOY_OUTPUT_VERSION: version,
      },
    })

    const rebuilt = exactlyOneAppImage(scratch)
    if (statSync(rebuilt).size === 0) throw new Error('rebuilt AppImage is empty')
    const replacement = join(bundleDir, `.${basename(appImagePath)}.portable`)
    copyFileSync(rebuilt, replacement)
    chmodSync(replacement, 0o755)
    renameSync(replacement, appImagePath)

    if (hadDetachedSignature) {
      rmSync(signaturePath, { force: true })
      const tauriCli =
        input?.tauriCli ??
        process.env.PODIUM_TAURI_CLI ??
        join(desktopRoot, 'node_modules/.bin/tauri')
      run(tauriCli, ['signer', 'sign', appImagePath], { cwd: desktopRoot })
      if (!existsSync(signaturePath) || statSync(signaturePath).size === 0) {
        throw new Error(`Tauri signer did not create ${signaturePath}`)
      }
    } else {
      console.log('[podium] rebuilt unsigned local AppImage (no original updater signature)')
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (import.meta.main) finalizeLinuxAppImage()
