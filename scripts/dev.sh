#!/usr/bin/env bash
# filmbench 开发启动器：检查依赖 → 备好 demo 项目 → 拉起桌面端
#   bash scripts/dev.sh                 # 用 demo-project 打开
#   bash scripts/dev.sh --project DIR   # 打开指定项目
#   bash scripts/dev.sh --check         # 只做环境自检，不启动
#   bash scripts/dev.sh --reset         # 重建 demo-project 再启动
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT="$ROOT/demo-project"
CHECK_ONLY=0
RESET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    --reset) RESET=1; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "未知参数 $1"; exit 1 ;;
  esac
done

say() { printf '\033[2m·\033[0m %s\n' "$1"; }
die() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

command -v bun >/dev/null || die "缺少 bun（https://bun.sh）"
say "bun $(bun -v)"

if command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null; then
  say "ffmpeg $(ffmpeg -version | head -1 | awk '{print $3}')"
else
  echo "⚠ 没有 ffmpeg/ffprobe：出片会失败（brew install ffmpeg）"
fi

[[ -d node_modules ]] || { say "安装依赖…"; bun install; }
[[ -d apps/desktop/node_modules/electron ]] || { say "安装 electron…"; bun install; }

ELECTRON_BIN="$ROOT/apps/desktop/node_modules/.bin/electron"
[[ -x "$ELECTRON_BIN" ]] || die "electron 未安装：cd $ROOT && bun install"

if ! ls "$ROOT"/node_modules/.bun/electron@*/node_modules/electron/dist/Electron.app >/dev/null 2>&1; then
  cat >&2 <<EOF
✗ Electron 二进制没有下载完整（常见于 bun install 被中断）。补一次：
  cd $ROOT/node_modules/.bun/electron@*/node_modules/electron
  rm -rf dist path.txt
  curl -fsSL -o /tmp/electron.zip https://github.com/electron/electron/releases/download/v33.4.11/electron-v33.4.11-darwin-arm64.zip
  mkdir -p dist && unzip -q /tmp/electron.zip -d dist
  printf 'Electron.app/Contents/MacOS/Electron' > path.txt
EOF
  exit 1
fi
say "electron 就绪"

if [[ $RESET -eq 1 ]]; then
  say "重建 $PROJECT"
  rm -rf "$PROJECT"
fi

if [[ ! -d "$PROJECT/journal" ]]; then
  say "生成 demo 项目 $PROJECT"
  bun packages/cli/src/cli.ts demo "$PROJECT" >/dev/null
fi
say "项目 ${PROJECT} · cli $(bun packages/cli/src/cli.ts --version 2>/dev/null || echo v0)"

if [[ $CHECK_ONLY -eq 1 ]]; then
  say "环境自检通过"
  exit 0
fi

say "启动界面…"
cd "$ROOT/apps/desktop"
FILMBENCH_PROJECT="$PROJECT" exec bun run dev
