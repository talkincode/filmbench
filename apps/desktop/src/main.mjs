// Electron 主进程：spawn 一个 Bun engine 子进程，把渲染层的请求转成一行 JSON。
// 为什么不在主进程里直接跑 core：core 用 bun:sqlite，Electron 的 Node 跑不了；
// 而且长任务崩了不该带走窗口。
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");

/* —— 启动参数：--project <dir> --shot <id> —— */
// Electron 会把自己的开关插到前面并重排 argv，所以只认 --name=value 形式
function argOf(name, argv = process.argv) {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) {
    const next = argv[i + 1];
    return next && !next.startsWith("--") ? next : undefined;
  }
  return undefined;
}

/* —— 最近项目 —— */
const recentFile = () => join(app.getPath("userData"), "recent-projects.json");

function readRecent() {
  try {
    return JSON.parse(readFileSync(recentFile(), "utf8"));
  } catch {
    return [];
  }
}

function rememberProject(dir, extra = {}) {
  const items = readRecent().filter((p) => p.dir !== dir);
  items.unshift({ dir, ...extra, at: new Date().toISOString() });
  mkdirSync(dirname(recentFile()), { recursive: true });
  writeFileSync(recentFile(), JSON.stringify(items.slice(0, 12), null, 2));
}

function resolveProject(explicit) {
  const candidates = [explicit, process.env.FILMBENCH_PROJECT, process.cwd(), join(repo, "demo-project")];
  for (const c of candidates) {
    if (c && existsSync(join(resolve(c), "journal"))) return resolve(c);
  }
  return resolve(process.env.FILMBENCH_PROJECT ?? process.cwd());
}

let projectDir = resolveProject(argOf("project"));
let focusShot = argOf("shot") ?? null;
let mainWindow = null;

/* —— engine 子进程 —— */
let child = null;
let seq = 0;
const pending = new Map();

let engineRestarts = 0;
let quitting = false;

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
    child = null;
    // 引擎崩了就把界面晾成空白是最糟的体验：自动拉起，并告诉渲染层发生了什么
    if (!quitting && engineRestarts < 20) {
      engineRestarts += 1;
      console.error(`engine 退出（${code}），重启第 ${engineRestarts} 次`);
      mainWindow?.webContents.send("engine-restarted", { code, attempt: engineRestarts });
      setTimeout(() => {
        if (!child && !quitting) startEngine();
      }, 600);
    }
  });
}

const rpc = async (cmd, args = {}) =>
  new Promise((res, rej) => {
    // 进程刚崩、还没被拉起来时，这里等一下它，而不是直接把错误甩给界面
    if (!child) {
      startEngine();
      const t0 = Date.now();
      const wait = setInterval(() => {
        if (child) {
          clearInterval(wait);
          send();
        } else if (Date.now() - t0 > 4000) {
          clearInterval(wait);
          rej(new Error("engine 未启动（重启失败）"));
        }
      }, 50);
      function send() {
        const id = ++seq;
        pending.set(id, { resolve: res, reject: rej });
        child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
      }
      return;
    }
    const id = ++seq;
    pending.set(id, { resolve: res, reject: rej });
    child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
  });

/* —— 窗口 —— */
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1080,
    minHeight: 700,
    title: "filmbench",
    backgroundColor: "#ece5d7",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setTitle(`filmbench — ${projectDir.split("/").pop()}`);
  await mainWindow.loadFile(join(here, "renderer/index.html"));
  mainWindow.once("ready-to-show", () => {
    if (focusShot) {
      mainWindow.webContents.send("focus-shot", focusShot);
      focusShot = null;
    }
  });
}

/* —— 单实例：再次 `filmbench ui --shot x` 时聚焦已有窗口 —— */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const project = argOf("project", argv) ?? null;
    const shot = argOf("shot", argv) ?? null;
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (project) mainWindow.webContents.send("open-project", { project, shot });
      else if (shot) mainWindow.webContents.send("focus-shot", shot);
    }
  });

  app.whenReady().then(async () => {
    rememberProject(projectDir);
    startEngine();
    await createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  child?.kill();
  if (process.platform !== "darwin") app.quit();
});

/* —— IPC —— */
ipcMain.handle("rpc", async (_e, { cmd, args }) => rpc(cmd, { ...args, project: projectDir }));

ipcMain.handle("project", () => ({ dir: projectDir, name: projectDir.split("/").pop() }));

ipcMain.handle("projects", () => {
  const items = readRecent();
  return items.map((p) => ({
    ...p,
    exists: existsSync(join(p.dir, "journal")),
    current: p.dir === projectDir,
  }));
});

ipcMain.handle("pick-project", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择 filmbench 项目目录（包含 journal/）",
    properties: ["openDirectory", "createDirectory"],
    defaultPath: projectDir,
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const dir = resolve(result.filePaths[0]);
  if (!existsSync(join(dir, "journal"))) {
    const create = await dialog.showMessageBox(mainWindow, {
      type: "question",
      message: "这个目录还不是 filmbench 项目",
      detail: `没有找到 journal/。要在这里初始化一个新项目吗？\n${dir}`,
      buttons: ["初始化", "取消"],
      defaultId: 0,
      cancelId: 1,
    });
    if (create.response !== 0) return null;
    const init = spawn(process.env.FILMBENCH_BUN ?? "bun", [join(repo, "packages/cli/src/cli.ts"), "init", dir], {
      cwd: repo,
      stdio: "ignore",
    });
    await new Promise((r) => init.on("exit", r));
  }
  projectDir = dir;
  rememberProject(dir);
  mainWindow.setTitle(`filmbench — ${dir.split("/").pop()}`);
  return { dir, name: dir.split("/").pop() };
});

ipcMain.handle("use-project", (_e, dir) => {
  if (!existsSync(join(dir, "journal"))) throw new Error(`不是项目目录: ${dir}`);
  projectDir = resolve(dir);
  rememberProject(projectDir);
  mainWindow.setTitle(`filmbench — ${projectDir.split("/").pop()}`);
  return { dir: projectDir, name: projectDir.split("/").pop() };
});

/* 截图：抓当前页面为 PNG（dataURL） */
ipcMain.handle("capture", async () => {
  const image = await mainWindow.webContents.capturePage();
  return `data:image/png;base64,${image.toPNG().toString("base64")}`;
});

ipcMain.handle("clipboard-image", (_e, dataUrl) => {
  const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, "");
  clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(base64, "base64")));
  return true;
});

ipcMain.handle("clipboard-text", (_e, text) => {
  clipboard.writeText(String(text));
  return true;
});

ipcMain.handle("open-path", (_e, p) => shell.openPath(String(p)));
ipcMain.handle("reveal", (_e, p) => shell.showItemInFolder(String(p)));
