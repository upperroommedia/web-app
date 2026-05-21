#!/usr/bin/env bash

set -euo pipefail

SSH_TARGET="${PROCESS_AUDIO_HETZNER_SSH_TARGET:-}"
REMOTE_DIR="${PROCESS_AUDIO_HETZNER_REMOTE_DIR:-/opt/upperroom/process-audio-hetzner}"

if [[ -z "$SSH_TARGET" ]]; then
  echo "PROCESS_AUDIO_HETZNER_SSH_TARGET is required" >&2
  exit 64
fi

ssh "$SSH_TARGET" "bash -s -- '$REMOTE_DIR'" <<'REMOTE_SCRIPT'
set -euo pipefail

REMOTE_DIR="$1"
PROFILE_HOME="${REMOTE_DIR}/state/shared-browser-profile"
PROFILE_DIR="${PROFILE_HOME}/.config/google-chrome"
REFRESH_CONTROL_DIR="${REMOTE_DIR}/state/browser-refresh-control"
USER_NAME="ytauth"
NOVNC_PROXY_BIN=""

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg sqlite3 xvfb x11vnc openbox novnc websockify dbus-x11 xauth

install -d -m 0755 /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/google-chrome.gpg ]]; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
fi

cat >/etc/apt/sources.list.d/google-chrome.list <<'EOF'
deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main
EOF

apt-get update
apt-get install -y google-chrome-stable

if ! id -u "$USER_NAME" >/dev/null 2>&1; then
  useradd --uid 1000 --home-dir "$PROFILE_HOME" --create-home --shell /bin/bash "$USER_NAME"
fi

chmod 755 "$REMOTE_DIR" "${REMOTE_DIR}/state"
install -d -o "$USER_NAME" -g "$USER_NAME" \
  "$PROFILE_HOME" \
  "$PROFILE_HOME/.config" \
  "$PROFILE_HOME/.config/google-chrome" \
  "$PROFILE_HOME/.cache" \
  "$PROFILE_HOME/.local/share/applications" \
  "$PROFILE_HOME/.dbus/session-bus" \
  "$PROFILE_HOME/.vnc" \
  "$REFRESH_CONTROL_DIR"
chown -R "$USER_NAME:$USER_NAME" "$PROFILE_HOME"
chown -R "$USER_NAME:$USER_NAME" "$REFRESH_CONTROL_DIR"

if command -v novnc_proxy >/dev/null 2>&1; then
  NOVNC_PROXY_BIN="$(command -v novnc_proxy)"
elif [[ -x /usr/share/novnc/utils/novnc_proxy ]]; then
  NOVNC_PROXY_BIN="/usr/share/novnc/utils/novnc_proxy"
else
  echo "Unable to locate novnc_proxy" >&2
  exit 1
fi

cat >/usr/local/bin/process-audio-browser-auth-launch-chrome <<EOF
#!/usr/bin/env bash
set -euo pipefail
export HOME="$PROFILE_HOME"
export DISPLAY=:99
export XDG_CONFIG_HOME="$PROFILE_HOME/.config"
export XDG_CACHE_HOME="$PROFILE_HOME/.cache"
exec /usr/bin/dbus-launch --exit-with-session \
  /usr/bin/google-chrome-stable \
    --no-first-run \
    --no-default-browser-check \
    --password-store=basic \
    --disable-crash-reporter \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port=9222 \
    --user-data-dir="$PROFILE_DIR" \
    --disable-features=Translate,MediaRouter \
    --disable-dev-shm-usage \
    https://www.youtube.com/
EOF
chmod 0755 /usr/local/bin/process-audio-browser-auth-launch-chrome

cat >/usr/local/bin/process-audio-browser-auth-refresh-watcher <<EOF
#!/usr/bin/env python3
import fcntl
import json
import os
import subprocess
import time

PROFILE_HOME = "$PROFILE_HOME"
PROFILE_DIR = "$PROFILE_DIR"
REFRESH_CONTROL_DIR = "$REFRESH_CONTROL_DIR"
USER_NAME = "$USER_NAME"
COOKIE_DB_PATH = os.path.join(PROFILE_DIR, "Default", "Cookies")
LOCK_PATH = os.path.join(REFRESH_CONTROL_DIR, ".refresh.lock")
STALE_FILE_SECONDS = 60 * 60


def cookie_stats():
    try:
        stats = os.stat(COOKIE_DB_PATH)
        return {"exists": True, "mtimeMs": stats.st_mtime_ns / 1_000_000, "size": stats.st_size}
    except FileNotFoundError:
        return {"exists": False, "mtimeMs": None, "size": None}


def refresh_browser():
    subprocess.run(["/usr/bin/systemctl", "start", "process-audio-browser-auth.target"], check=True)
    env = os.environ.copy()
    env.update(
        {
            "HOME": PROFILE_HOME,
            "DISPLAY": ":99",
            "XDG_CONFIG_HOME": os.path.join(PROFILE_HOME, ".config"),
            "XDG_CACHE_HOME": os.path.join(PROFILE_HOME, ".cache"),
        }
    )
    refresh_url = f"https://www.youtube.com/?process_audio_refresh={int(time.time())}"
    subprocess.run(
        [
            "/usr/sbin/runuser",
            "-u",
            USER_NAME,
            "--",
            "/usr/bin/google-chrome-stable",
            "--user-data-dir=" + PROFILE_DIR,
            "--new-tab",
            refresh_url,
        ],
        check=True,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(5)

def process_request(request_path: str):
    with open(LOCK_PATH, "a+", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        before = cookie_stats()
        result_path = request_path.replace(".request.json", ".result.json")
        try:
            refresh_browser()
            payload = {
                "ok": True,
                "before": before,
                "after": cookie_stats(),
            }
        except subprocess.CalledProcessError as exc:
            payload = {
                "ok": False,
                "before": before,
                "after": cookie_stats(),
                "error": f"refresh command failed with exit code {exc.returncode}",
            }
        except Exception as exc:  # noqa: BLE001
            payload = {
                "ok": False,
                "before": before,
                "after": cookie_stats(),
                "error": str(exc),
            }
        with open(result_path, "w", encoding="utf-8") as result_file:
            json.dump(payload, result_file)
        try:
            os.remove(request_path)
        except FileNotFoundError:
            pass

def cleanup_stale_files():
    now = time.time()
    for file_name in os.listdir(REFRESH_CONTROL_DIR):
        if not (file_name.endswith(".request.json") or file_name.endswith(".result.json")):
            continue
        file_path = os.path.join(REFRESH_CONTROL_DIR, file_name)
        try:
            if now - os.stat(file_path).st_mtime > STALE_FILE_SECONDS:
                os.remove(file_path)
        except FileNotFoundError:
            pass
        except Exception:
            pass


if __name__ == "__main__":
    os.makedirs(REFRESH_CONTROL_DIR, exist_ok=True)
    while True:
        cleanup_stale_files()
        request_files = sorted(
            file_name
            for file_name in os.listdir(REFRESH_CONTROL_DIR)
            if file_name.endswith(".request.json")
        )
        if not request_files:
            time.sleep(0.5)
            continue

        for file_name in request_files:
          process_request(os.path.join(REFRESH_CONTROL_DIR, file_name))
EOF
chmod 0755 /usr/local/bin/process-audio-browser-auth-refresh-watcher

cat >/etc/systemd/system/process-audio-browser-xvfb.service <<EOF
[Unit]
Description=Process Audio browser auth Xvfb
PartOf=process-audio-browser-auth.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :99 -screen 0 1440x900x24 -nolisten tcp -ac
Restart=on-failure

[Install]
WantedBy=process-audio-browser-auth.target
EOF

cat >/etc/systemd/system/process-audio-browser-openbox.service <<EOF
[Unit]
Description=Process Audio browser auth Openbox
After=process-audio-browser-xvfb.service
Requires=process-audio-browser-xvfb.service
PartOf=process-audio-browser-auth.target

[Service]
User=$USER_NAME
Environment=HOME=$PROFILE_HOME
Environment=DISPLAY=:99
ExecStart=/usr/bin/openbox
Restart=on-failure

[Install]
WantedBy=process-audio-browser-auth.target
EOF

cat >/etc/systemd/system/process-audio-browser-x11vnc.service <<EOF
[Unit]
Description=Process Audio browser auth x11vnc
After=process-audio-browser-xvfb.service
Requires=process-audio-browser-xvfb.service
PartOf=process-audio-browser-auth.target

[Service]
Type=simple
ExecStart=/usr/bin/x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -nopw
Restart=on-failure

[Install]
WantedBy=process-audio-browser-auth.target
EOF

cat >/etc/systemd/system/process-audio-browser-novnc.service <<EOF
[Unit]
Description=Process Audio browser auth noVNC
After=process-audio-browser-x11vnc.service
Requires=process-audio-browser-x11vnc.service
PartOf=process-audio-browser-auth.target

[Service]
Type=simple
ExecStart=$NOVNC_PROXY_BIN --listen 127.0.0.1:3010 --vnc 127.0.0.1:5900
Restart=on-failure

[Install]
WantedBy=process-audio-browser-auth.target
EOF

cat >/etc/systemd/system/process-audio-browser-refresh.service <<EOF
[Unit]
Description=Process Audio browser auth refresh watcher
After=process-audio-browser-chrome.service
Requires=process-audio-browser-chrome.service
PartOf=process-audio-browser-auth.target

[Service]
Type=simple
ExecStart=/usr/local/bin/process-audio-browser-auth-refresh-watcher
Restart=always
RestartSec=5

[Install]
WantedBy=process-audio-browser-auth.target
EOF

cat >/etc/systemd/system/process-audio-browser-chrome.service <<EOF
[Unit]
Description=Process Audio browser auth Chrome
After=process-audio-browser-openbox.service
Requires=process-audio-browser-openbox.service
PartOf=process-audio-browser-auth.target

[Service]
User=$USER_NAME
Environment=HOME=$PROFILE_HOME
Environment=DISPLAY=:99
Environment=XDG_CONFIG_HOME=$PROFILE_HOME/.config
Environment=XDG_CACHE_HOME=$PROFILE_HOME/.cache
ExecStart=/usr/local/bin/process-audio-browser-auth-launch-chrome
Restart=always
RestartSec=5

[Install]
WantedBy=process-audio-browser-auth.target
EOF

cat >/etc/systemd/system/process-audio-browser-auth.target <<'EOF'
[Unit]
Description=Process Audio browser auth stack
Wants=process-audio-browser-xvfb.service
Wants=process-audio-browser-openbox.service
Wants=process-audio-browser-x11vnc.service
Wants=process-audio-browser-novnc.service
Wants=process-audio-browser-chrome.service
Wants=process-audio-browser-refresh.service

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable process-audio-browser-xvfb.service process-audio-browser-openbox.service process-audio-browser-x11vnc.service process-audio-browser-novnc.service process-audio-browser-chrome.service process-audio-browser-refresh.service process-audio-browser-auth.target
systemctl restart process-audio-browser-auth.target

echo "Host browser auth setup complete."
echo "Profile home: $PROFILE_HOME"
echo "Chrome user data dir: $PROFILE_DIR"
echo "Chrome refresh control dir: $REFRESH_CONTROL_DIR"
REMOTE_SCRIPT

echo "Configured host-native browser auth on ${SSH_TARGET}"
