#!/usr/bin/env bash
set -euo pipefail

if [ -x /opt/homebrew/opt/openjdk/bin/java ]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk
  export PATH="$JAVA_HOME/bin:$PATH"
fi

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null
else
  current_major="$(node -p 'process.versions.node.split(`.`)[0]')"
  if [ "$current_major" != "22" ]; then
    echo "Node 22 is required. Run 'nvm use 22' before using this repo." >&2
    exit 1
  fi
fi

exec "$@"
