#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
npm_path="$(command -v npm)"
node_dir="$(dirname "$(command -v node)")"
agent_path="$HOME/Library/LaunchAgents/local.remnote-tts.plugin.plist"
log_dir="$HOME/Library/Logs/remnote-tts"

mkdir -p "$(dirname "$agent_path")" "$log_dir"

python3 - "$agent_path" "$repo_dir/plugin" "$npm_path" "$node_dir" "$log_dir" <<'PY'
import plistlib
import sys

agent_path, plugin_dir, npm_path, node_dir, log_dir = sys.argv[1:]
with open(agent_path, "wb") as file:
    plistlib.dump({
        "Label": "local.remnote-tts.plugin",
        "ProgramArguments": [npm_path, "run", "dev"],
        "WorkingDirectory": plugin_dir,
        "EnvironmentVariables": {
            "PATH": f"{node_dir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        },
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "StandardOutPath": f"{log_dir}/plugin.log",
        "StandardErrorPath": f"{log_dir}/plugin-error.log",
    }, file)
PY

launchctl bootout "gui/$(id -u)" "$agent_path" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$agent_path"
printf 'Plugin starts now and after login: http://localhost:8080\nLogs: %s\n' "$log_dir"
