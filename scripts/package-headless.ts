/**
 * The only one-platform headless packaging entry point.
 *
 * It fresh-builds both clients, captures their identity in a module-branded session,
 * then compiles and packages without crossing a process boundary. Direct build-bun
 * invocation refuses, so packaging cannot silently fall back to whatever dist existed.
 */
import { beginFreshClientPackagingSession, packageHeadlessForFreshClients } from './build-bun'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const session = await beginFreshClientPackagingSession(argv)
  packageHeadlessForFreshClients(session, argv)
}

if (import.meta.main) void main()
