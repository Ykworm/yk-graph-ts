#!/usr/bin/env bash
# yk-graph-ts 开发启停
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PID_FILE="$ROOT/data/yk-graph-ts.pid"
LOG_FILE="$ROOT/data/yk-graph-ts.log"
mkdir -p "$ROOT/data"

cmd="${1:-}"
case "$cmd" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "already running pid=$(cat "$PID_FILE")"
      exit 0
    fi
    if [ ! -f configs/yk-graph-ts.yaml ] && [ -f configs/yk-graph-ts.example.yaml ]; then
      cp configs/yk-graph-ts.example.yaml configs/yk-graph-ts.yaml
      echo "created configs/yk-graph-ts.yaml from example"
    fi
    nohup npx tsx src/index.ts --config configs/yk-graph-ts.yaml >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    echo "started pid=$! log=$LOG_FILE"
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
      rm -f "$PID_FILE"
      echo "stopped"
    else
      echo "not running"
    fi
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "running pid=$(cat "$PID_FILE")"
      # 服务唯一读的地址变量是 YK_GRAPH_ADDR（形如 :8702），取端口做健康检查；未设则默认 8702
      graph_port="${YK_GRAPH_ADDR##*:}"
      graph_port="${graph_port:-8702}"
      curl -s "http://127.0.0.1:${graph_port}/v1/health" || true
      echo
    else
      echo "not running"
    fi
    ;;
  *)
    echo "usage: $0 start|stop|status"
    exit 1
    ;;
esac
