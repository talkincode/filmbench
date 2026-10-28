// Electron 主进程：spawn 一个 Bun engine 子进程，把渲染层的请求转成一行 JSON。
// 为什么不在主进程里直接跑 core：core 用 bun:sqlite，Electron 的 Node 跑不了；
// 而且长任务崩了不该带走窗口。
import { app, BrowserWindow, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const projectDir = resolve(process.env.FILMBENCH_PROJECT ?? process.cwd());

let child = null;
let rpc = null;
let seq = 0;
const pending = new Map();

function startEngine() {
  child = spawn(process.env.FILMBENCH_BUN ?? "bun", [join(repo, "packages/cli/src/engine.ts"), projectDir], {
    cwd: repo,
    stdio: ["pipe", "pipe", "pipe"],
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
  });
  child.stderr.on("data", (d) => console.error(String(d).trimEnd()));
  child.on("exit", (code) => {
    for (const p of pending.values()) p.reject(new Error(`engine 退出（${code}）`));
    pending.clear();
  });
  rpc = (cmd, args = {}) =>
    new Promise((resolveP, rejectP) => {
      const id = ++seq;
      pending.set(id, { resolve: resolveP, reject: rejectP });
      child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    title: "filmbench",
    backgroundColor: "#ece5d7",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(join(here, "renderer/index.html"));
}

app.whenReady().then(async () => {
  startEngine();
  ipcMain.handle("rpc", async (_e, { cmd, args }) => rpc(cmd, args));
  ipcMain.handle("storyboardPath", () => join(projectDir, "build/storyboard.html"));
  ipcMain.handle("reveal", (_e, p) => import("electron").then(({ shell }) => shell.openPath(p)));
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  child?.kill();
  if (process.platform !== "darwin") app.quit();
});
