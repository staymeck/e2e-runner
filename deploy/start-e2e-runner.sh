#!/bin/bash
# Host entrypoint for e2e-runner under launchd / systemd.
# launchd and systemd do NOT load ~/.zshrc or ~/.bash_profile, so nvm/ANDROID_HOME/PATH must be set
# here explicitly — every job the service spawns (perfect-qa, build-apk.py) inherits this environment.
#
# Install:
#   chmod +x deploy/start-e2e-runner.sh
#   cp .env.example .env && $EDITOR .env   # fill in every value — see .env.example for what each means
#   npm ci && npm run build
#   # then point the plist/service at this script (see com.perfect.e2e-runner.plist / e2e-runner.service)
#
# Prefer `exec` at the end so signals (SIGTERM) reach the Node process directly — that is what lets
# the service's own graceful shutdown (cancels running jobs, waits up to 10s) actually run instead of
# being killed by a wrapper shell first.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- The service's own required/optional variables (E2E_SERVICE_*, E2E_DETOX_*, ...) ---
# Never hardcoded here: one file, edited once per host. See .env.example at the repo root.
ENV_FILE="${E2E_RUNNER_ENV_FILE:-$REPO_ROOT/.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: env file not found: $ENV_FILE (copy .env.example to .env and fill it in, or set E2E_RUNNER_ENV_FILE)" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

# --- nvm (Node >=22.13 — see package.json's engines) ---
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
elif command -v brew >/dev/null 2>&1 && [[ -s "$(brew --prefix nvm)/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$(brew --prefix nvm)/nvm.sh"
else
  echo "ERROR: nvm.sh not found (set NVM_DIR, or install nvm)" >&2
  exit 1
fi
nvm use --silent 22

# --- Android / adb (device status + every real job needs this) ---
if [[ -z "${ANDROID_HOME:-}" ]]; then
  if [[ -d "$HOME/Library/Android/sdk" ]]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
  elif [[ -d "$HOME/Android/Sdk" ]]; then
    export ANDROID_HOME="$HOME/Android/Sdk"
  fi
fi
if [[ -z "${ANDROID_HOME:-}" || ! -d "$ANDROID_HOME" ]]; then
  echo "ERROR: ANDROID_HOME not found (set it in $ENV_FILE)" >&2
  exit 1
fi
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

# --- Python + PyYAML + python-dotenv (build-apk.py, shelled out to by every build job) ---
# Lives inside the catalog's own installed orchestrator (E2E_DETOX_RUNNER_DIR, from .env) — not
# this repo, which never depends on the orchestrator itself. Same reasoning as the old orchestrator
# API's launcher: install once, then hard-fail at boot if it still does not import, so a missing
# dependency surfaces here — not mid-build, hours later.
PYTHON_BIN="${ORCH_PYTHON:-python3}"
REQUIREMENTS_FILE="${E2E_DETOX_RUNNER_DIR:-}/node_modules/@perfect/e2e-orchestrator/scripts/requirements.txt"
if ! "$PYTHON_BIN" -c "import yaml, dotenv" >/dev/null 2>&1; then
  if [[ -f "$REQUIREMENTS_FILE" ]]; then
    echo "[start-e2e-runner] Installing Python requirements into $PYTHON_BIN"
    "$PYTHON_BIN" -m pip install --quiet --disable-pip-version-check -r "$REQUIREMENTS_FILE"
  fi
fi
if ! "$PYTHON_BIN" -c "import yaml, dotenv" >/dev/null 2>&1; then
  echo "ERROR: python deps missing (yaml, dotenv) in $PYTHON_BIN — pip install -r <orchestrator>/scripts/requirements.txt" >&2
  exit 1
fi

cd "$REPO_ROOT"

if [[ ! -f dist/main.js ]]; then
  echo "ERROR: dist/main.js not found — run 'npm ci && npm run build' first" >&2
  exit 1
fi

echo "[start-e2e-runner] repo=$REPO_ROOT"
echo "[start-e2e-runner] node=$(command -v node) ($(node -v))"
echo "[start-e2e-runner] python=$PYTHON_BIN ($("$PYTHON_BIN" -V 2>&1))"
echo "[start-e2e-runner] ANDROID_HOME=$ANDROID_HOME"
echo "[start-e2e-runner] envFile=$ENV_FILE"

exec node dist/main.js
