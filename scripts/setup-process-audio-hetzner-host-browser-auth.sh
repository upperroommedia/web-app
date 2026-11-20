#!/usr/bin/env bash

set -euo pipefail

SSH_TARGET="${PROCESS_AUDIO_HETZNER_SSH_TARGET:-}"
REMOTE_DIR="${PROCESS_AUDIO_HETZNER_REMOTE_DIR:-/opt/upperroom/process-audio-hetzner}"

if [[ "${1:-}" == --render-staging-broker ]]; then
  python3 - "${BASH_SOURCE[0]}" "$REMOTE_DIR" <<'RENDER_PY'
import json
import re
import sys
from pathlib import Path

source, remote = sys.argv[1:]
if not re.fullmatch(r"/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*", remote):
    raise SystemExit("Invalid dedicated staging broker path")
begin = "cat >/usr/local/bin/process-audio-browser-auth-mint-pot <<'PYTHON'\n"
broker = Path(source).read_text().split(begin)[1].split("\nPYTHON\n", 1)[0]
for name, value in {
    "REFRESH_CONTROL_DIR": remote + "/state/staging/tmp/temporal-youtube-po",
    "PROFILE_DIR": remote + "/state/shared-browser-profile/.config/google-chrome",
    "BROWSER_USER": "ytauth",
}.items():
    broker = broker.replace('"__' + name + '__"', json.dumps(value))
broker = broker.replace("SEALED_ONLY = False", "SEALED_ONLY = True")
compile(broker, "staging-browser-po-broker", "exec")
print(broker)
RENDER_PY
  exit
fi

if [[ -z "$SSH_TARGET" ]]; then
  echo "PROCESS_AUDIO_HETZNER_SSH_TARGET is required" >&2
  exit 64
fi

ssh "$SSH_TARGET" "bash -s -- '$REMOTE_DIR'" <<'REMOTE_SCRIPT'
set -euo pipefail

REMOTE_DIR="$1"
PROFILE_HOME="${REMOTE_DIR}/state/shared-browser-profile"
PROFILE_DIR="${PROFILE_HOME}/.config/google-chrome"
RUNTIME_HOME="/home/ytauth"
REFRESH_CONTROL_DIR="${REMOTE_DIR}/state/browser-refresh-control"
USER_NAME="ytauth"
NOVNC_PROXY_BIN=""

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg sqlite3 xvfb x11vnc openbox novnc websockify dbus-x11 xauth python3-websocket

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
  "$RUNTIME_HOME" \
  "$RUNTIME_HOME/.config" \
  "$RUNTIME_HOME/.cache" \
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
# Chrome 136+ disables the remote debugging port when the supplied user data
# directory is also the browser's default profile path. Keep runtime state in
# a separate home while explicitly retaining the persistent auth profile.
export HOME="$RUNTIME_HOME"
export DISPLAY=:99
export XDG_CONFIG_HOME="$RUNTIME_HOME/.config"
export XDG_CACHE_HOME="$RUNTIME_HOME/.cache"
exec /usr/bin/dbus-launch --exit-with-session \
  /usr/bin/google-chrome-stable \
    --no-first-run \
    --no-default-browser-check \
    --password-store=basic \
    --disable-crash-reporter \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port=9222 \
    --remote-allow-origins=http://localhost \
    --user-data-dir="$PROFILE_DIR" \
    --disable-features=Translate,MediaRouter \
    --disable-dev-shm-usage \
    https://www.youtube.com/
EOF
chmod 0755 /usr/local/bin/process-audio-browser-auth-launch-chrome

cat >/usr/local/bin/process-audio-browser-auth-mint-pot <<'PYTHON'
#!/usr/bin/env python3
"""Mint session-bound YouTube GVS PO tokens through the authenticated Chrome."""
import fcntl
import hashlib
import json
import os
import pwd
import re
import secrets
import signal
import socket
import stat
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import websocket

CONTROL_DIR = "__REFRESH_CONTROL_DIR__"
PROFILE_DIR = "__PROFILE_DIR__"
BROWSER_USER = "__BROWSER_USER__"
SEALED_ONLY = False
SEALED_REQUEST = re.compile(r"pot-[a-f0-9]{32}\.sealed-pot\.request")
COOKIE_DIGEST = re.compile(r"[a-f0-9]{64}")
MAX_COOKIE_BYTES = 32 * 1024 * 1024
LOCK_PATH = os.path.join(CONTROL_DIR, ".pot.lock")
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def http_json(path, method="GET", port=9222, timeout=15):
    request = urllib.request.Request(f"http://127.0.0.1:{port}" + path, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=timeout) as response:
        data = response.read(65537)
        if len(data) > 65536:
            raise RuntimeError("Invalid Chrome response")
        return json.loads(data)


def cdp(ws, message_id, method, params=None, deadline=None):
    ws.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
    while True:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Owned Chrome command timed out")
            ws.settimeout(remaining)
        response = json.loads(ws.recv())
        if response.get("id") != message_id:
            continue
        if "error" in response:
            raise RuntimeError(response["error"].get("message", "DevTools command failed"))
        return response.get("result", {})


def mint_token(video_id, port=9222, sealed=False):
    target = None
    ws = None
    try:
        target = http_json(
            "/json/new?" + urllib.parse.quote("https://www.youtube.com/watch?v=" + video_id, safe=""),
            "PUT", port, 10 if sealed else 15,
        )
        if sealed:
            page_id = target.get("id", "")
            if not isinstance(page_id, str) or not re.fullmatch(r"[A-Fa-f0-9]{32}", page_id):
                raise RuntimeError("Invalid owned Chrome target")
            socket_url = f"ws://127.0.0.1:{port}/devtools/page/{page_id}"
        else:
            socket_url = target["webSocketDebuggerUrl"]
        ws = websocket.create_connection(socket_url, timeout=8 if sealed else 20, origin="http://localhost")
        cdp(ws, 1, "Page.enable", deadline=time.monotonic() + 3 if sealed else None)
        time.sleep(6)
        expression = """(async () => {
          const clientFactory = window.top['havuokmhhs-0']?.bevasrs?.wpc;
          if (!clientFactory) return null;
          const client = await clientFactory();
          return client.mws({ c: '%s', mc: false, me: false });
        })()""" % video_id
        result = cdp(
            ws, 2, "Runtime.evaluate",
            {"expression": expression, "awaitPromise": True, "returnByValue": True},
            deadline=time.monotonic() + 8 if sealed else None,
        )
        token = result.get("result", {}).get("value")
        if not isinstance(token, str) or len(token) < 100:
            raise RuntimeError("Chrome did not return a usable YouTube PO token")
        return token
    finally:
        if ws:
            ws.close()
        try:
            if target:
                http_json("/json/close/" + target["id"], "GET" if sealed else "PUT", port, 2 if sealed else 15)
        except Exception:
            pass



def copy_sealed_cookies(destination, expected):
    """Only the configured host Chrome database can seed an owned browser."""
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
    root = os.open(PROFILE_DIR, flags)
    try:
        profile = os.open("Default", flags, dir_fd=root)
        try:
            fd = os.open("Cookies", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=profile)
            with os.fdopen(fd, "rb") as source:
                before = os.fstat(source.fileno())
                if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_COOKIE_BYTES:
                    raise RuntimeError("Cookie snapshot unavailable")
                digest = hashlib.sha256()
                size = 0
                with open(destination, "xb") as output:
                    while True:
                        block = source.read(65536)
                        if not block:
                            break
                        size += len(block)
                        if size > before.st_size:
                            raise RuntimeError("Cookie snapshot changed")
                        digest.update(block)
                        output.write(block)
                after = os.fstat(source.fileno())
                if size != before.st_size or before.st_mtime_ns != after.st_mtime_ns or before.st_ctime_ns != after.st_ctime_ns:
                    raise RuntimeError("Cookie snapshot changed")
                if not secrets.compare_digest(digest.hexdigest(), expected):
                    raise RuntimeError("Cookie snapshot changed")
        finally:
            os.close(profile)
    finally:
        os.close(root)


def stop_owned_browser(browser):
    try:
        os.killpg(browser.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        browser.poll()
        try:
            os.killpg(browser.pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    try:
        os.killpg(browser.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    browser.wait(timeout=3)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.killpg(browser.pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.05)
    raise RuntimeError("Owned Chrome drain unconfirmed")


def mint_sealed_token(video_id, digest, workspace):
    # Keep writable clone, crash data and cache outside the resident profile.
    profile = os.path.join(workspace, "chrome")
    default = os.path.join(profile, "Default")
    cookies = os.path.join(default, "Cookies")
    os.makedirs(default, mode=0o700)
    copy_sealed_cookies(cookies, digest)
    identity = pwd.getpwnam(BROWSER_USER)
    uid, gid = identity.pw_uid, identity.pw_gid
    if uid == 0 or gid == 0:
        raise RuntimeError("Invalid Chrome user")
    browser_identity = {}
    if os.geteuid() == 0:
        browser_identity = dict(user=BROWSER_USER, group=gid, extra_groups=[])
    elif (os.geteuid(), os.getegid()) != (uid, gid):
        raise RuntimeError("Unexpected browser service user")
    # Transfer the outer directory last when a root-owned service prepared it.
    for file in (cookies, default, profile, workspace):
        os.chmod(file, 0o600 if file == cookies else 0o700)
        if browser_identity:
            os.chown(file, uid, gid)
    environment = {
        "PATH": "/usr/bin:/bin", "HOME": workspace, "TMPDIR": workspace,
        "XDG_CONFIG_HOME": os.path.join(workspace, "config"),
        "XDG_CACHE_HOME": os.path.join(workspace, "cache"),
    }
    browser = subprocess.Popen(
        [
            "/usr/bin/google-chrome-stable", "--headless=new", "--no-first-run",
            "--no-default-browser-check", "--password-store=basic", "--disable-breakpad",
            "--disable-crash-reporter", "--disable-crashpad-for-testing", "--disable-dev-shm-usage",
            "--disable-background-networking", "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=0", "--remote-allow-origins=http://localhost",
            f"--user-data-dir={profile}", "about:blank",
        ],
        env=environment, start_new_session=True, **browser_identity,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 8
        endpoint = os.path.join(profile, "DevToolsActivePort")
        while time.monotonic() < deadline and browser.poll() is None:
            try:
                fd = os.open(endpoint, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                with os.fdopen(fd, "rb") as details:
                    if not stat.S_ISREG(os.fstat(details.fileno()).st_mode):
                        raise ValueError("Invalid owned Chrome endpoint")
                    fields = details.read(256).decode("ascii").splitlines()
                if len(fields) == 2 and re.fullmatch(r"/devtools/browser/[a-f0-9-]{36}", fields[1]):
                    port = int(fields[0])
                    if 1024 <= port <= 65535:
                        discovered = http_json("/json/version", port=port, timeout=2)
                        if discovered.get("webSocketDebuggerUrl") == f"ws://127.0.0.1:{port}{fields[1]}":
                            return mint_token(video_id, port, sealed=True)
            except (OSError, ValueError):
                pass
            time.sleep(0.1)
        raise RuntimeError("Owned Chrome did not start")
    finally:
        stop_owned_browser(browser)


def process_sealed_request(request_path):
    base = request_path.removesuffix(".request")
    claim_path, result_path = base + ".claimed", base + ".result"
    if os.path.lexists(claim_path) or os.path.lexists(result_path):
        return
    try:
        os.rename(request_path, claim_path)
    except FileNotFoundError:
        return
    output = {"ok": False}
    try:
        fd = os.open(claim_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as request:
            if not stat.S_ISREG(os.fstat(request.fileno()).st_mode):
                raise ValueError("Invalid owned request")
            payload = json.loads(request.read(1024))
        if not isinstance(payload, dict) or set(payload) != {"videoId", "cookieDigest"}:
            raise ValueError("Invalid owned request")
        video_id, digest = payload["videoId"], payload["cookieDigest"]
        if not isinstance(video_id, str) or not VIDEO_ID_RE.fullmatch(video_id):
            raise ValueError("Invalid video ID")
        if not isinstance(digest, str) or not COOKIE_DIGEST.fullmatch(digest):
            raise ValueError("Invalid cookie digest")
        with tempfile.TemporaryDirectory(prefix="process-audio-sealed-chrome-") as workspace:
            token = mint_sealed_token(video_id, digest, workspace)
        if not re.fullmatch(r"[A-Za-z0-9_=-]{100,16384}", token):
            raise RuntimeError("Invalid token")
        output = {"ok": True, "videoId": video_id, "cookieDigest": digest, "poToken": token}
    except Exception:
        pass
    pending = result_path + ".pending"
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as result:
        json.dump(output, result)
        owner = os.stat(CONTROL_DIR)
        os.fchown(result.fileno(), owner.st_uid, owner.st_gid)
    os.replace(pending, result_path)
    os.remove(claim_path)

def process_request(request_path):
    result_path = request_path.replace(".pot.request.json", ".pot.result.json")
    try:
        with open(request_path, encoding="utf-8") as request_file:
            payload = json.load(request_file)
        video_id = payload.get("videoId", "")
        if not isinstance(video_id, str) or not VIDEO_ID_RE.fullmatch(video_id):
            raise ValueError("Invalid YouTube video ID")
        with open(LOCK_PATH, "a+", encoding="utf-8") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            token = mint_token(video_id)
        result = {"ok": True, "poToken": token, "videoId": video_id}
    except Exception as exc:
        result = {"ok": False, "error": str(exc)}
    with open(result_path, "w", encoding="utf-8") as result_file:
        json.dump(result, result_file)
    try:
        os.remove(request_path)
    except FileNotFoundError:
        pass


if SEALED_ONLY:
    identity = pwd.getpwnam(BROWSER_USER)
    if (os.geteuid(), os.getegid()) != (identity.pw_uid, identity.pw_gid):
        raise RuntimeError("Unexpected staging broker user")
    mailbox = os.stat(CONTROL_DIR, follow_symlinks=False)
    if (
        not stat.S_ISDIR(mailbox.st_mode)
        or (mailbox.st_uid, mailbox.st_gid, stat.S_IMODE(mailbox.st_mode)) != (identity.pw_uid, identity.pw_gid, 0o700)
        or not os.access("/usr/bin/google-chrome-stable", os.X_OK)
    ):
        raise RuntimeError("Staging browser broker prerequisites unavailable")
    endpoint = os.environ["NOTIFY_SOCKET"]
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notify:
        notify.sendto(b"READY=1", "\0" + endpoint[1:] if endpoint.startswith("@") else endpoint)

while True:
    try:
        if SEALED_ONLY:
            files = os.listdir(CONTROL_DIR)
            for name in files:
                if re.fullmatch(r"pot-[a-f0-9]{32}\.sealed-pot\.result(?:\.pending)?", name):
                    file = os.path.join(CONTROL_DIR, name)
                    try:
                        if time.time() - os.lstat(file).st_mtime > 120:
                            os.unlink(file)
                    except FileNotFoundError:
                        pass
            for request_name in sorted(name for name in files if SEALED_REQUEST.fullmatch(name)):
                process_sealed_request(os.path.join(CONTROL_DIR, request_name))
        else:
            request_names = sorted(name for name in os.listdir(CONTROL_DIR) if name.endswith(".pot.request.json"))
            for request_name in request_names:
                process_request(os.path.join(CONTROL_DIR, request_name))
    except Exception:
        pass
    time.sleep(0.25)
PYTHON
sed -i -e "s|__REFRESH_CONTROL_DIR__|$REFRESH_CONTROL_DIR|g" \
  -e "s|__PROFILE_DIR__|$PROFILE_DIR|g" -e "s|__BROWSER_USER__|$USER_NAME|g" \
  /usr/local/bin/process-audio-browser-auth-mint-pot
chmod 0755 /usr/local/bin/process-audio-browser-auth-mint-pot

cat >/usr/local/bin/process-audio-browser-auth-refresh-watcher <<EOF
#!/usr/bin/env python3
import fcntl
import json
import os
import re
import subprocess
import time

PROFILE_HOME = "$PROFILE_HOME"
PROFILE_DIR = "$PROFILE_DIR"
REFRESH_CONTROL_DIR = "$REFRESH_CONTROL_DIR"
USER_NAME = "$USER_NAME"
COOKIE_DB_PATH = os.path.join(PROFILE_DIR, "Default", "Cookies")
LOCK_PATH = os.path.join(REFRESH_CONTROL_DIR, ".refresh.lock")
STALE_FILE_SECONDS = 60 * 60
TRACKED_REQUEST = re.compile(
    r"refresh-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.request\.json"
)


def sync_control_directory():
    fd = os.open(REFRESH_CONTROL_DIR, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


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
        base_path = request_path.removesuffix(".request.json")
        result_path = base_path + ".result.json"
        tracked = TRACKED_REQUEST.fullmatch(os.path.basename(request_path)) is not None
        active_path = request_path
        if tracked:
            active_path = base_path + ".claimed.json"
            if os.path.lexists(active_path) or os.path.lexists(result_path):
                return
            try:
                os.rename(request_path, active_path)
            except FileNotFoundError:
                return
            # A restart must never pick up this request for a second refresh.
            sync_control_directory()
        before = cookie_stats()
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
        output_path = result_path + ".pending" if tracked else result_path
        with open(output_path, "x" if tracked else "w", encoding="utf-8") as result_file:
            json.dump(payload, result_file)
            if tracked:
                result_file.flush()
                os.fsync(result_file.fileno())
        if tracked:
            os.replace(output_path, result_path)
            sync_control_directory()
        try:
            os.remove(active_path)
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
            if file_name.endswith(".request.json") and not file_name.endswith(".pot.request.json")
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
Environment=HOME=$RUNTIME_HOME
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

cat >/etc/systemd/system/process-audio-browser-pot.service <<EOF
[Unit]
Description=Process Audio authenticated browser PO token broker
After=process-audio-browser-chrome.service
Requires=process-audio-browser-chrome.service
PartOf=process-audio-browser-auth.target

[Service]
Type=simple
ExecStart=/usr/local/bin/process-audio-browser-auth-mint-pot
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
Environment=XDG_CONFIG_HOME=$RUNTIME_HOME/.config
Environment=XDG_CACHE_HOME=$RUNTIME_HOME/.cache
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
Wants=process-audio-browser-pot.service

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable process-audio-browser-xvfb.service process-audio-browser-openbox.service process-audio-browser-x11vnc.service process-audio-browser-novnc.service process-audio-browser-chrome.service process-audio-browser-refresh.service process-audio-browser-pot.service process-audio-browser-auth.target
systemctl restart process-audio-browser-auth.target

echo "Host browser auth setup complete."
echo "Profile home: $PROFILE_HOME"
echo "Chrome user data dir: $PROFILE_DIR"
echo "Chrome refresh control dir: $REFRESH_CONTROL_DIR"
REMOTE_SCRIPT

echo "Configured host-native browser auth on ${SSH_TARGET}"
