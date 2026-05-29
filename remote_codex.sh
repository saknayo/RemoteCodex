#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env"
  set +a
fi

APP_PORT="${APP_PORT:-3000}"
PUBLIC_HOST="${PUBLIC_HOST:-}"
PUBLIC_USER="${PUBLIC_USER:-root}"
PUBLIC_PORT="${PUBLIC_PORT:-13000}"
LOCAL_HOST="${LOCAL_HOST:-127.0.0.1}"

STATE_DIR="${STATE_DIR:-/tmp/remote_codex}"
APP_PID_FILE="$STATE_DIR/app.pid"
TUNNEL_PID_FILE="$STATE_DIR/tunnel.pid"
APP_LOG="$STATE_DIR/app.log"
TUNNEL_LOG="$STATE_DIR/tunnel.log"

mkdir -p "$STATE_DIR"

is_running() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  local file="$1"
  [[ -f "$file" ]] && tr -d '[:space:]' < "$file" || true
}

find_app_pids() {
  ps -eo pid=,args= | awk '$0 ~ /(^| )node server\.js$/ && $0 !~ /awk/ {print $1}'
}

find_tunnel_pids() {
  ps -eo pid=,args= | awk -v public_port="$PUBLIC_PORT" -v local_host="$LOCAL_HOST" -v app_port="$APP_PORT" -v public_host="$PUBLIC_HOST" -v public_user="$PUBLIC_USER" '
    $0 ~ /autossh/ &&
    index($0, "-R 0.0.0.0:" public_port ":" local_host ":" app_port) &&
    index($0, public_user "@" public_host) &&
    $0 !~ /awk/ {print $1}
  '
}

start_app() {
  local pid
  pid="$(read_pid "$APP_PID_FILE")"
  if is_running "$pid"; then
    echo "app already running: $pid"
    return
  fi

  local existing
  existing="$(find_app_pids | head -n 1)"
  if [[ -n "$existing" ]]; then
    echo "$existing" > "$APP_PID_FILE"
    echo "app already running: $existing"
    return
  fi

  rm -f "$APP_PID_FILE"
  setsid bash -c 'cd "$1" && echo $$ > "$2" && exec node server.js > "$3" 2>&1' \
    bash "$PROJECT_DIR" "$APP_PID_FILE" "$APP_LOG" >/dev/null 2>&1 &
  sleep 0.2
  echo "app started: $(read_pid "$APP_PID_FILE")"
  echo "app log: $APP_LOG"
}

start_tunnel() {
  if [[ -z "$PUBLIC_HOST" ]]; then
    echo "PUBLIC_HOST is required. Set it in .env or export it before running start." >&2
    exit 1
  fi

  local pid
  pid="$(read_pid "$TUNNEL_PID_FILE")"
  if is_running "$pid"; then
    echo "tunnel already running: $pid"
    return
  fi

  local existing
  existing="$(find_tunnel_pids | head -n 1)"
  if [[ -n "$existing" ]]; then
    echo "$existing" > "$TUNNEL_PID_FILE"
    echo "tunnel already running: $existing"
    return
  fi

  rm -f "$TUNNEL_PID_FILE"
  setsid bash -c 'echo $$ > "$1"; exec autossh -M 0 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -N -R "$2" "$3" > "$4" 2>&1' \
    bash \
    "$TUNNEL_PID_FILE" \
    "0.0.0.0:${PUBLIC_PORT}:${LOCAL_HOST}:${APP_PORT}" \
    "${PUBLIC_USER}@${PUBLIC_HOST}" \
    "$TUNNEL_LOG" >/dev/null 2>&1 &
  sleep 0.2
  echo "tunnel started: $(read_pid "$TUNNEL_PID_FILE")"
  echo "tunnel log: $TUNNEL_LOG"
}

stop_by_pid_file() {
  local name="$1"
  local file="$2"
  local pid
  pid="$(read_pid "$file")"
  if is_running "$pid"; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    if is_running "$pid"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    echo "$name stopped: $pid"
  fi
  rm -f "$file"
}

stop_app() {
  stop_by_pid_file "app" "$APP_PID_FILE"
  local pids
  pids="$(find_app_pids)"
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs -r kill 2>/dev/null || true
    sleep 1
    find_app_pids | xargs -r kill -9 2>/dev/null || true
    echo "stopped remaining app process(es)"
  fi
}

stop_tunnel() {
  stop_by_pid_file "tunnel" "$TUNNEL_PID_FILE"
  local pids
  pids="$(find_tunnel_pids)"
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs -r kill 2>/dev/null || true
    sleep 1
    find_tunnel_pids | xargs -r kill -9 2>/dev/null || true
    echo "stopped remaining tunnel process(es)"
  fi
}

status_one() {
  local name="$1"
  local file="$2"
  local fallback="$3"
  local pid
  pid="$(read_pid "$file")"
  if is_running "$pid"; then
    echo "$name: running ($pid)"
  elif [[ -n "$fallback" ]]; then
    echo "$fallback" > "$file"
    echo "$name: running ($fallback)"
  else
    echo "$name: stopped"
  fi
}

status() {
  status_one "app" "$APP_PID_FILE" "$(find_app_pids | head -n 1)"
  status_one "tunnel" "$TUNNEL_PID_FILE" "$(find_tunnel_pids | head -n 1)"
  echo "local:  http://${LOCAL_HOST}:${APP_PORT}"
  if [[ -n "$PUBLIC_HOST" ]]; then
    echo "public: http://${PUBLIC_HOST}:${PUBLIC_PORT}"
  else
    echo "public: not configured (set PUBLIC_HOST in .env)"
  fi
}

case "${1:-status}" in
  start)
    start_app
    start_tunnel
    status
    ;;
  stop)
    stop_tunnel
    stop_app
    status
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    status
    ;;
  logs)
    echo "--- app log: $APP_LOG"
    tail -n 80 "$APP_LOG" 2>/dev/null || true
    echo "--- tunnel log: $TUNNEL_LOG"
    tail -n 80 "$TUNNEL_LOG" 2>/dev/null || true
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac
