#!/usr/bin/env bash
set -euo pipefail

if [ -x /opt/homebrew/opt/openjdk/bin/java ]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk
  export PATH="$JAVA_HOME/bin:$PATH"
fi

current_major="$(node -p 'process.versions.node.split(`.`)[0]')"
if [ "$current_major" != "22" ]; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1090
    source "$HOME/.nvm/nvm.sh"
    if ! nvm use 22 >/dev/null 2>&1; then
      echo "Node 22 is required. Install/use it before running this command." >&2
      exit 1
    fi
  else
    echo "Node 22 is required. Run 'nvm use 22' before using this repo." >&2
    exit 1
  fi
fi

load_dotenv_file() {
  local env_file="$1"
  [ -f "$env_file" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ''|\#*) continue ;;
    esac

    if [[ "$line" != *=* ]]; then
      continue
    fi

    local key="${line%%=*}"
    local value="${line#*=}"
    export "$key=$value"
  done < "$env_file"
}

load_dotenv_file ".env"
load_dotenv_file ".env.local"

exec "$@"
