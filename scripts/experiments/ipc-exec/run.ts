#!/usr/bin/env bun
// POD-3772 experiment: when the supervisor upgrades itself IN PLACE — execs its own
// new binary over itself — does its end of the 'ipc' channel to the server and daemon
// survive, or is it silently dropped?
//
// POD-3760 settled the child end: a compiled child keeps the channel across its own
// exec, because that is what a compiled child IS. The parent end is the open question,
// and the one POD-3767 depends on: a supervisor that loses it must hand its children
// over instead of keeping them.
//
// Contract with .github/workflows/platform-experiment.yml: run with `bun run.ts`,
// write result.json under EXPERIMENT_OUT, print a markdown summary, exit 0 whenever
// the experiment ran. Only a broken harness exits non-zero.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dir;
const outDir = process.env.EXPERIMENT_OUT ?? path.join(process.cwd(), "experiment-out");
const binDir = path.join(outDir, "bin");
fs.mkdirSync(binDir, { recursive: true });
const exe = process.platform === "win32" ? ".exe" : "";

function sh(
  cmd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd: outDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill(), 120_000);
    p.on("error", (e) => {
      clearTimeout(t);
      resolve({ code: null, out: `spawn error: ${e.message}` });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

const BINS = ["parent", "child"] as const;
// Keyed by the literal fixture names rather than a string index, so `bins.parent`
// is a `string` — what spawn() takes — instead of `string | undefined`.
const bins = {} as Record<(typeof BINS)[number], string>;
for (const name of BINS) {
  const outfile = path.join(binDir, name + exe);
  const r = await sh(process.execPath, [
    "build",
    "--compile",
    path.join(here, "fixtures", `${name}.ts`),
    "--outfile",
    outfile,
  ]);
  if (r.code !== 0 || !fs.existsSync(outfile)) {
    console.error(`FATAL: could not compile ${name}\n${r.out}`);
    process.exit(1); // harness broken — this one IS a CI failure
  }
  bins[name] = outfile;
  console.log(`compiled ${name} -> ${outfile}`);
}

const results: Record<string, unknown> = {
  experiment: "ipc-exec",
  platform: process.platform,
  arch: process.arch,
  bunVersion: Bun.version,
  runner: process.env.RUNNER_NAME ?? "local",
  runnerOs: process.env.ImageOS ?? "",
  startedAt: new Date().toISOString(),
  // Windows has no execve. That is not a failed measurement, it is a different
  // question with a different answer, and saying so is the honest report.
  execveExists: process.platform !== "win32",
  modes: {} as Record<string, unknown>,
};

const MODES = ["bun-execve", "raw-execve", "raw-execve-cloexec"] as const;

if (process.platform === "win32") {
  results.modes = {};
  results.windowsNote =
    "No execve on win32: a supervisor cannot replace itself in place, so this experiment's question does not arise. An in-place upgrade there has to be a respawn, which is POD-3767's separate case.";
} else {
  for (const mode of MODES) {
    console.log(`\n=== mode: ${mode} ===`);
    const stateFile = path.join(outDir, `child-state-${mode}.json`);
    try {
      fs.rmSync(stateFile, { force: true });
    } catch {}
    const r = await sh(bins.parent, [mode, bins.child], { IPC_EXEC_CHILD_STATE: stateFile });
    const line = r.out.split(/\r?\n/).find((l) => l.startsWith("EXPERIMENT_RESULT "));
    (results.modes as Record<string, unknown>)[mode] = line
      ? JSON.parse(line.slice("EXPERIMENT_RESULT ".length))
      : { failedStage: "no-result-line", exitCode: r.code, tail: r.out.slice(-2000) };
    console.log(r.out.trim());
  }
}

// --- verdicts -------------------------------------------------------------
type Verdict = {
  armed: boolean;
  reason: string;
  fdSurvived: boolean | null;
  channelUsable: boolean | null;
  childSawCrash: boolean | null;
  controlFdSurvived: boolean | null;
};

function verdict(m: Record<string, unknown> | undefined): Verdict {
  const blank: Verdict = {
    armed: false,
    reason: "did not run",
    fdSurvived: null,
    channelUsable: null,
    childSawCrash: null,
    controlFdSurvived: null,
  };
  if (!m) return blank;
  if (m.skipped) return { ...blank, reason: String(m.skipped) };
  if (m.failedStage) return { ...blank, reason: String(m.failedStage) };

  const gen1 = (m.gen1 ?? {}) as Record<string, unknown>;
  const child = (m.child ?? {}) as { after?: Record<string, unknown> | null };
  const after = child.after ?? null;
  const atExec = ((m.child as { atExec?: { beats?: number } })?.atExec ?? null) as {
    beats?: number;
  } | null;

  // An answer is only worth reading if all three arming conditions held: the channel
  // worked before the exec, the exec really was in place (same pid), and the child is
  // still alive afterwards. Any of those failing makes "the channel is dead" say
  // nothing about exec.
  const childAlive = after !== null && (after.beats as number) > (atExec?.beats ?? -1);
  if (m.preExecFailed || gen1.preExecRoundTrip !== true)
    return { ...blank, reason: "channel never worked before the exec" };
  if (m.pidUnchanged !== true) return { ...blank, reason: "pid changed — not an in-place exec" };
  if (!childAlive)
    return { ...blank, reason: "child was not alive after the exec — nothing to attribute" };

  const fd = m.channelFd as { survived: boolean };
  const rt = m.roundTrip as { ok?: boolean; sameChild?: boolean };
  const ctl = m.controlFd as { survived: boolean };
  return {
    armed: true,
    reason: "",
    fdSurvived: fd.survived,
    channelUsable: rt?.ok === true && rt?.sameChild === true,
    childSawCrash: after !== null && after.disconnectedAfterMs != null,
    controlFdSurvived: ctl.survived,
  };
}

// Keyed by MODES, not by `string`: every mode below is looked up by name, and a
// `Record<string, Verdict>` would make each of those reads possibly-undefined.
const verdicts = Object.fromEntries(
  MODES.map((m) => [m, verdict((results.modes as Record<string, Record<string, unknown>>)[m])]),
) as Record<(typeof MODES)[number], Verdict>;
results.verdicts = verdicts;
results.finishedAt = new Date().toISOString();

fs.writeFileSync(path.join(outDir, "result.json"), `${JSON.stringify(results, null, 2)}\n`);

function cell(v: boolean | null, yes: string, no: string): string {
  return v === null ? "n/a" : v ? yes : no;
}

const headline = (() => {
  if (process.platform === "win32") return "**n/a — win32 has no execve.** See the note in result.json.";
  const raw = verdicts["raw-execve"];
  const bun = verdicts["bun-execve"];
  if (!raw.armed && !bun.armed) return `**inconclusive** — ${bun.reason || raw.reason}`;
  const parts: string[] = [];
  if (bun.armed)
    parts.push(
      `via \`process.execve\`: **${bun.channelUsable ? "SURVIVES" : "channel is LOST"}**${
        bun.childSawCrash ? " (and the child sees a disconnect)" : ""
      }`,
    );
  if (raw.armed)
    parts.push(
      `via libc \`execve\` with FD_CLOEXEC cleared: **${raw.channelUsable ? "SURVIVES and round-trips with the same child" : "channel is LOST"}**`,
    );
  return parts.join("; ");
})();

const md = [
  `### ipc-exec — \`${process.platform}/${process.arch}\` (bun ${Bun.version}, ${results.runner})`,
  "",
  `Can the supervisor keep its children across an in-place exec? ${headline}`,
  "",
  "| mode | armed | parent's channel fd | channel usable after exec | control fd | child saw a crash |",
  "| --- | --- | --- | --- | --- | --- |",
  ...MODES.map((m) => {
    const v = verdicts[m];
    return `| \`${m}\` | ${v.armed ? "✅" : `❌ ${v.reason}`} | ${cell(v.fdSurvived, "✅ survived", "❌ closed")} | ${cell(
      v.channelUsable,
      "✅ round-trip ok",
      "❌ no",
    )} | ${cell(v.controlFdSurvived, "✅ survived", "❌ closed")} | ${cell(v.childSawCrash, "⚠️ yes", "no")} |`;
  }),
  "",
  "`raw-execve-cloexec` is the control: same libc exec, FD_CLOEXEC left set. It must",
  "LOSE the fd for `raw-execve`'s survival to be attributable to clearing the bit.",
  "",
  "<details><summary>raw result.json</summary>",
  "",
  "```json",
  JSON.stringify(results, null, 2),
  "```",
  "",
  "</details>",
].join("\n");

console.log(`\n${md}`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
