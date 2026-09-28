#!/bin/zsh
# 工单记录小工具 · 一键启动
# 双击运行：自动检查依赖、启动本地服务、打开浏览器

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${SCRIPT_DIR}/code"
PORT=4173
URL="http://127.0.0.1:${PORT}"

# 定位 Node（PATH 优先，兼容从 Finder 启动时 PATH 不完整的情况）
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "/usr/local/bin/node" ]; then
  NODE_BIN="/usr/local/bin/node"
elif [ -x "/opt/homebrew/bin/node" ]; then
  NODE_BIN="/opt/homebrew/bin/node"
else
  echo "未找到 Node.js，请先安装 Node.js 后重试。"
  read -k 1 "REPLY?按任意键关闭窗口..."
  exit 1
fi

cd "$PROJECT_DIR" || {
  echo "找不到项目目录：$PROJECT_DIR"
  read -k 1 "REPLY?按任意键关闭窗口..."
  exit 1
}

# 首次运行自动安装依赖
if [ ! -d node_modules ]; then
  echo "首次运行，正在安装依赖..."
  npm install || {
    echo "依赖安装失败，请检查网络后重试。"
    read -k 1 "REPLY?按任意键关闭窗口..."
    exit 1
  }
fi

# 服务已在运行：直接打开浏览器
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "服务已在运行，打开浏览器：$URL"
  open "$URL"
  exit 0
fi

# 本地识别提示：Ollama 未运行时不阻塞启动
if ! curl -sS --max-time 2 "http://127.0.0.1:11434/api/version" >/dev/null 2>&1; then
  echo "提示：Ollama 未运行。使用“本地 Ollama”识别前，请先打开 Ollama 应用。"
fi

echo "正在启动本地服务..."
"$NODE_BIN" server.js &
SERVER_PID=$!

# 等待服务就绪（最多 15 秒）
READY=0
for i in {1..30}; do
  if curl -sS --max-time 1 "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if [ "$READY" = "1" ]; then
  echo "工单记录已启动：$URL"
  open "$URL"
  echo ""
  echo "本窗口保持打开时服务运行中，关闭窗口或按 Ctrl+C 即可停止。"
else
  echo "服务启动失败，请查看上方日志。"
  read -k 1 "REPLY?按任意键关闭窗口..."
fi

wait "$SERVER_PID"
