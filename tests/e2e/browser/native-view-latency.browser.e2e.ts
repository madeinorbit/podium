/**
 * First-open and warm Chat -> CLI latency measurement (POD-3091).
 *
 * This runs on the browser harness's owned state root and fixture Codex process.
 * It measures the browser/terminal boundary without reading or writing the
 * operator instance. Set PODIUM_NATIVE_VIEW_BENCH_OUT to retain the JSON report.
 */
import { writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { RELAY } from "./_harness";

interface SwitchMark {
  name: string;
  atMs: number;
  meta?: Record<string, string | number | boolean>;
}

interface SwitchTrace {
  switchId: string;
  mode: "chat" | "native" | "unknown";
  cold: boolean;
  totalMs: number;
  timedOut: boolean;
  marks: SwitchMark[];
}

type TraceWindow = Window & {
  __podiumSwitchTraces?: { recent(): SwitchTrace[] };
  __podiumTerminalDiagnostics?: { snapshot(): unknown[] };
};

const outputPath = process.env.PODIUM_NATIVE_VIEW_BENCH_OUT?.trim();
const warmSamples = Number(
  process.env.PODIUM_NATIVE_VIEW_BENCH_WARM_SAMPLES ?? 8
);

async function traceCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as TraceWindow).__podiumSwitchTraces?.recent().length ?? 0
  );
}

async function waitForTrace(
  page: Page,
  after: number,
  mode: "chat" | "native"
): Promise<SwitchTrace> {
  await page.waitForFunction(
    ({ count, expectedMode }) => {
      const traces =
        (window as TraceWindow).__podiumSwitchTraces?.recent() ?? [];
      return traces.length > count && traces.at(-1)?.mode === expectedMode;
    },
    { count: after, expectedMode: mode },
    { timeout: 15_000 }
  );
  return page.evaluate(
    () =>
      (window as TraceWindow).__podiumSwitchTraces
        ?.recent()
        .at(-1) as SwitchTrace
  );
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return (
    ordered[
      Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)
    ] ?? null
  );
}

test("measures first and repeated Codex CLI opens", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() =>
    localStorage.setItem("podium.panelModeDefault", "chat")
  );
  await page.goto(`/?server=${RELAY}&e2e=1&switchTrace=1`);
  await page.waitForFunction(
    () => !document.querySelector(".app-loading"),
    undefined,
    {
      timeout: 45_000,
    }
  );
  const repoDialog = page.getByRole("dialog", { name: "Find repositories" });
  if (await repoDialog.isVisible().catch(() => false)) {
    await repoDialog.getByRole("button", { name: "Close" }).click();
  }
  const releaseDialog = page.getByRole("dialog", {
    name: "Development release proposal",
  });
  if (await releaseDialog.isVisible().catch(() => false)) {
    await releaseDialog.getByRole("button", { name: "Hide" }).click();
  }

  // Fresh harness state has no issue row to enter. Use the current first-mission
  // path rather than the legacy workspace helper: it creates the issue, session
  // and Codex-shaped fixture through the same controls a first-time user sees.
  const firstTask = page
    .getByRole("button", { name: "Start first task" })
    .last();
  if (await firstTask.isVisible().catch(() => false)) await firstTask.click();
  const mission = page.getByRole("textbox", {
    name: "What do you want to work on?",
  });
  await mission.fill("Measure native view latency");
  await page
    .getByTestId("cold-start-field")
    .getByRole("button", { name: "Agent", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Codex", exact: true }).click();
  await page.getByRole("button", { name: "Start work", exact: true }).click();

  const chat = page
    .getByRole("tab", { name: "Chat", exact: true })
    .locator("visible=true");
  const cli = page
    .getByRole("tab", { name: "CLI", exact: true })
    .locator("visible=true");
  await expect(chat).toBeVisible({ timeout: 30_000 });
  await expect(cli).toBeVisible({ timeout: 30_000 });
  if ((await chat.getAttribute("aria-selected")) !== "true") await chat.click();
  await expect(chat).toHaveAttribute("aria-selected", "true");

  // Let AppShell's first-idle renderer prefetch finish. The first measured click
  // still owns xterm construction, PTY attach, fit, render and focus readiness.
  await page.waitForTimeout(2_500);

  const firstStart = await traceCount(page);
  await cli.click();
  await expect(cli).toHaveAttribute("aria-selected", "true");
  const firstCliOpen = await waitForTrace(page, firstStart, "native");

  const warm: SwitchTrace[] = [];
  for (let index = 0; index < warmSamples; index += 1) {
    let count = await traceCount(page);
    await chat.click();
    await expect(chat).toHaveAttribute("aria-selected", "true");
    await waitForTrace(page, count, "chat");

    count = await traceCount(page);
    await cli.click();
    await expect(cli).toHaveAttribute("aria-selected", "true");
    warm.push(await waitForTrace(page, count, "native"));
  }

  const terminalDiagnostics = await page.evaluate(
    () => (window as TraceWindow).__podiumTerminalDiagnostics?.snapshot() ?? []
  );
  const warmMs = warm
    .filter((trace) => !trace.timedOut)
    .map((trace) => trace.totalMs);
  const report = {
    measuredAt: new Date().toISOString(),
    fixture: "isolated browser harness; Codex-shaped keyecho process",
    viewport: { width: 1440, height: 900 },
    firstCliOpen,
    warmCliOpen: {
      requested: warmSamples,
      completed: warmMs.length,
      p50Ms: percentile(warmMs, 0.5),
      p90Ms: percentile(warmMs, 0.9),
      maxMs: warmMs.length > 0 ? Math.max(...warmMs) : null,
      traces: warm,
    },
    terminalDiagnostics,
  };

  await testInfo.attach("native-view-latency.json", {
    body: Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
    contentType: "application/json",
  });
  if (outputPath)
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  expect(firstCliOpen.timedOut).toBe(false);
  expect(
    firstCliOpen.marks.some((mark) => mark.name === "term:interactable")
  ).toBe(true);
  expect(warmMs).toHaveLength(warmSamples);
  console.log(
    `native view: first=${Math.round(firstCliOpen.totalMs)}ms ` +
      `warm p50=${Math.round(percentile(warmMs, 0.5) ?? 0)}ms ` +
      `p90=${Math.round(percentile(warmMs, 0.9) ?? 0)}ms ` +
      `max=${Math.round(Math.max(...warmMs))}ms`
  );
});
