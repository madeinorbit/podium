// Windows job-object probe. CORROBORATION ONLY — the control arms are the
// discriminator; this just says whether the environment has the mechanism that
// reading (b) blames. Everything here is best-effort: any failure reports
// `available: false` with the reason and must never take the experiment down.
//
// POD-3772 established that bun:ffi loads from inside a `bun build --compile`
// binary, which is the only reason this is reachable from a fixture at all.

export type JobReport = {
  available: boolean;
  error?: string;
  inJob?: boolean;
  /** LimitFlags from JOBOBJECT_BASIC_LIMIT_INFORMATION, or null if unreadable. */
  limitFlags?: number | null;
  /** JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE — the bit that would kill an orphan. */
  killOnJobClose?: boolean | null;
  /** JOB_OBJECT_LIMIT_BREAKAWAY_OK / SILENT_BREAKAWAY_OK — can a child escape? */
  breakawayOk?: boolean | null;
  silentBreakawayOk?: boolean | null;
  queryError?: number | null;
};

const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0000_0800;
const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x0000_1000;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const JobObjectExtendedLimitInformation = 9;
// sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on x64: 64-byte basic + 48-byte
// IO_COUNTERS + four SIZE_T. LimitFlags sits at offset 16 of the basic block,
// after the two LARGE_INTEGER time limits.
const EXTENDED_LIMIT_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;

export function probeJob(): JobReport {
  if (process.platform !== "win32") return { available: false, error: "not win32" };
  try {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const { symbols } = dlopen("kernel32.dll", {
      GetCurrentProcess: { args: [], returns: FFIType.u64 },
      IsProcessInJob: {
        args: [FFIType.u64, FFIType.u64, FFIType.ptr],
        returns: FFIType.i32,
      },
      QueryInformationJobObject: {
        args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
      GetLastError: { args: [], returns: FFIType.u32 },
    });

    const self = symbols.GetCurrentProcess();
    const boolOut = Buffer.alloc(4);
    // A NULL job handle asks "is this process in ANY job", which is the question.
    const ok = symbols.IsProcessInJob(self as never, 0n as never, ptr(boolOut));
    if (!ok) {
      return { available: true, error: `IsProcessInJob failed, GetLastError=${symbols.GetLastError()}` };
    }
    const inJob = boolOut.readInt32LE(0) !== 0;
    if (!inJob) return { available: true, inJob: false, limitFlags: null, killOnJobClose: null };

    // A NULL job handle here means "the job this process is in". It needs
    // JOB_OBJECT_QUERY access, which a process does not always have on its own
    // job — a failure is a real answer ("in a job we cannot read"), not a bug.
    const buf = Buffer.alloc(EXTENDED_LIMIT_SIZE);
    const queried = symbols.QueryInformationJobObject(
      0n as never,
      JobObjectExtendedLimitInformation,
      ptr(buf),
      EXTENDED_LIMIT_SIZE,
      null as never,
    );
    if (!queried) {
      return {
        available: true,
        inJob: true,
        limitFlags: null,
        killOnJobClose: null,
        queryError: symbols.GetLastError(),
      };
    }
    const limitFlags = buf.readUInt32LE(LIMIT_FLAGS_OFFSET);
    return {
      available: true,
      inJob: true,
      limitFlags,
      killOnJobClose: (limitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) !== 0,
      breakawayOk: (limitFlags & JOB_OBJECT_LIMIT_BREAKAWAY_OK) !== 0,
      silentBreakawayOk: (limitFlags & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) !== 0,
      queryError: null,
    };
  } catch (err) {
    return { available: false, error: `${(err as Error).name}: ${(err as Error).message}` };
  }
}
