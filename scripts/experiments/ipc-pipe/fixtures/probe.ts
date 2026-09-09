// Shared probes. Kept dependency-free so every fixture compiles standalone.
import fs from "node:fs";

export function probeFds(max = 6): Record<string, string> {
  const out: Record<string, string> = {};
  for (let fd = 0; fd <= max; fd++) {
    try {
      const s = fs.fstatSync(fd);
      out[String(fd)] = s.isSocket()
        ? "socket"
        : s.isFIFO()
          ? "fifo"
          : s.isCharacterDevice()
            ? "chardev"
            : s.isFile()
              ? "file"
              : "other";
    } catch {
      out[String(fd)] = "closed";
    }
  }
  return out;
}

// Env vars by which a runtime could hand a channel down. NODE_CHANNEL_FD is node's,
// BUN_INTERNAL_IPC_FD is Bun's. The second clause is the unknown-unknown catch, and it
// keys on the VALUE: a variable that really carries a channel has to hold a bare fd
// number or a pipe path, whatever it is called.
//
// Matching the bare word CHANNEL is too greedy — GitHub's runners export
// POWERSHELL_DISTRIBUTION_CHANNEL on Linux and Windows, and an earlier version of this
// probe read that as a leak on two platforms out of four. It appears identically in the
// positive control, which is what gave it away: a variable present with AND without a
// real channel cannot be the channel.
const KNOWN = ["NODE_CHANNEL_FD", "BUN_INTERNAL_IPC_FD", "ELECTRON_INTERNAL_CHANNEL_FD"];
const LOOKS_LIKE_A_HANDLE = /^(\d{1,4}|\\\\[.?]\\pipe\\\S+|\/\S*\.sock\S*)$/i;

export function channelEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const hits: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const value = String(v ?? "");
    const named = KNOWN.includes(k);
    const shaped = /CHANNEL|IPC|_FD$/i.test(k) && LOOKS_LIKE_A_HANDLE.test(value);
    if (named || shaped) hits[k] = value;
  }
  return hits;
}
