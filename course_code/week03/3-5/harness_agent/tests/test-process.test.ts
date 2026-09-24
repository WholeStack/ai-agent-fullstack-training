import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { executeTestProcess } from "../src/test-process.js";

// POSIX signal delivery and reaping run outside Vitest's clock; wait for the
// child's ready file instead of assuming a startup delay or using fake timers.
async function waitForPids(file: string): Promise<number[]> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try { return JSON.parse(await readFile(file, "utf8")) as number[]; } catch { await delay(20); }
  }
  throw new Error("Child process did not become ready");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

describe.skipIf(process.platform === "win32")("owned test process group", () => {
  it("waits for a TERM-resistant descendant to be killed and reaped before cancellation settles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "test-process-"));
    const pidFile = path.join(root, "pids.json");
    const script = path.join(root, "parent.cjs");
    const leaf = `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`;
    await writeFile(script, `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      process.on('SIGTERM', () => {});
      child.once('message', () => writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.pid, child.pid])));
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    const running = executeTestProcess(process.execPath, [script], {
      cwd: root, signal: controller.signal, terminateGraceMs: 60,
    });
    try {
      const pids = await waitForPids(pidFile);
      controller.abort();
      const result = await running;
      expect(result.cancelled).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.signal).toBe("SIGKILL");
      expect(pids.map(alive)).toEqual([false, false]);
    } finally {
      controller.abort();
      await running.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("does not report a successful exit while a child remains alive after its parent exits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "test-orphan-"));
    const pidFile = path.join(root, "pids.json");
    const leaf = `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);`;
    const script = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      child.once('message', () => { writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([child.pid])); process.exit(0); });
    `;
    try {
      const result = await executeTestProcess(process.execPath, ["-e", script], {
        cwd: root, terminateGraceMs: 60, timeoutMs: 5_000,
      });
      const [pid] = await waitForPids(pidFile);
      expect(result.exitCode).toBe(0);
      expect(alive(pid)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
