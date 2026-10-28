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
# Same idea as the old orchestrator API's launcher (deploy/start-perfect-qa-api.sh, removed in
# STA-39): a dedicated named virtualenv, not whatever bare `python3` happens to be on PATH, so the
# host's own Python installs are never touched. Default env name is "e2e-runner-env" (ORCH_PYTHON_ENV
# overrides it); ORCH_PYTHON itself always wins if set, same as before.
PYTHON_ENV_NAME="${ORCH_PYTHON_ENV:-e2e-runner-env}"

resolve_python() {
  if [[ -n "${ORCH_PYTHON:-}" && -x "${ORCH_PYTHON}" ]]; then
    echo "$ORCH_PYTHON"
    return 0
  fi

  if command -v pyenv >/dev/null 2>&1; then
    local pyenv_prefix
    pyenv_prefix="$(pyenv prefix "$PYTHON_ENV_NAME" 2>/dev/null || true)"
    if [[ -n "$pyenv_prefix" && -x "$pyenv_prefix/bin/python3" ]]; then
      echo "$pyenv_prefix/bin/python3"
      return 0
    fi
  fi

  local candidate
  for candidate in \
    "$HOME/.virtualenvs/$PYTHON_ENV_NAME/bin/python3" \
    "$HOME/miniconda3/envs/$PYTHON_ENV_NAME/bin/python3" \
    "$HOME/anaconda3/envs/$PYTHON_ENV_NAME/bin/python3" \
    "/opt/homebrew/Caskroom/miniconda/base/envs/$PYTHON_ENV_NAME/bin/python3"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  # Nothing named exists yet: create it with the stdlib's own venv (no pyenv/conda required).
  local venv_dir="$HOME/.virtualenvs/$PYTHON_ENV_NAME"
  echo "[start-e2e-runner] Creating virtualenv '$PYTHON_ENV_NAME' at $venv_dir" >&2
  python3 -m venv "$venv_dir"
  echo "$venv_dir/bin/python3"
}

PYTHON_BIN="$(resolve_python)"
if [[ -z "$PYTHON_BIN" || ! -x "$PYTHON_BIN" ]]; then
  echo "ERROR: could not resolve or create a python3 for env '$PYTHON_ENV_NAME'" >&2
  exit 1
fi
export VIRTUAL_ENV="$(cd "$(dirname "$PYTHON_BIN")/.." && pwd)"
export PATH="$(dirname "$PYTHON_BIN"):$PATH"

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
export ORCH_PYTHON="$PYTHON_BIN"

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
