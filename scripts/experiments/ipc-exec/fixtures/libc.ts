// Raw libc, because the question is what the KERNEL does across execve and the
// runtime's own wrapper turns out to have an opinion of its own.
//
// Everything here is posix. Windows has no execve at all — callers must check
// `available` first and report that leg as n/a rather than manufacturing a result.
import { dlopen, FFIType, ptr } from "bun:ffi";

export const F_GETFD = 1;
export const F_SETFD = 2;
export const FD_CLOEXEC = 1;

type Libc = {
  fcntl: (fd: number, cmd: number, arg: number) => number;
  execve: (path: unknown, argv: unknown, envp: unknown) => number;
};

function load(): { libc: Libc | null; error: string } {
  if (process.platform === "win32") return { libc: null, error: "win32 has no execve" };
  // glibc, musl and macOS disagree on the name; try each rather than branching on
  // platform alone, so an alpine-ish runner does not read as a broken harness.
  const candidates =
    process.platform === "darwin"
      ? ["libSystem.B.dylib"]
      : ["libc.so.6", "libc.musl-x86_64.so.1", "libc.so"];
  const errors: string[] = [];
  for (const name of candidates) {
    try {
      const { symbols } = dlopen(name, {
        fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        execve: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      });
      return { libc: symbols as unknown as Libc, error: "" };
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
  }
  return { libc: null, error: errors.join("; ") };
}

const loaded = load();
export const available = loaded.libc !== null;
export const loadError = loaded.error;

/** F_GETFD, or null where libc is unavailable. */
export function getFdFlags(fd: number): number | null {
  return loaded.libc ? loaded.libc.fcntl(fd, F_GETFD, 0) : null;
}

/** Clear FD_CLOEXEC so the descriptor survives an exec. Reports both sides so a
 *  caller can prove the bit was set BEFORE and clear AFTER — an unverified
 *  "I cleared it" would make every downstream result unattributable. */
export function clearCloexec(fd: number): { before: number | null; after: number | null } {
  const before = getFdFlags(fd);
  if (loaded.libc && before !== null) loaded.libc.fcntl(fd, F_SETFD, before & ~FD_CLOEXEC);
  return { before, after: getFdFlags(fd) };
}

// The buffers behind a char** must outlive the call, and on the success path there
// IS no "after the call" — so hold them in a module-level array and never free.
const pinned: unknown[] = [];

function cString(s: string): Buffer {
  const b = Buffer.from(`${s}\0`, "utf8");
  pinned.push(b);
  return b;
}

function cStringArray(items: string[]): BigUint64Array {
  const arr = new BigUint64Array(items.length + 1);
  items.forEach((s, i) => {
    arr[i] = BigInt(ptr(cString(s)));
  });
  arr[items.length] = 0n; // NULL terminator
  pinned.push(arr);
  return arr;
}

/** Replace this process via libc execve. Returns only on FAILURE (like execve itself). */
export function rawExecve(
  path: string,
  argv: string[],
  env: Record<string, string | undefined>,
): number {
  if (!loaded.libc) return -1;
  const envp = Object.entries(env)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${v}`);
  return loaded.libc.execve(ptr(cString(path)), ptr(cStringArray(argv)), ptr(cStringArray(envp)));
}

/** Read the flags, and clear FD_CLOEXEC only when `clear` is set. The control mode
 *  leaves the bit alone, so both modes go through one call site and the report shows
 *  the same before/after shape either way. */
export function clearCloexec_or_read(
  fd: number,
  clear: boolean,
): { before: number | null; after: number | null; cleared: boolean } {
  if (!clear) {
    const before = getFdFlags(fd);
    return { before, after: before, cleared: false };
  }
  return { ...clearCloexec(fd), cleared: true };
}
