# colab-comfy/v1 -- kick: extract the uploaded bundle and start the runner in the background.
#
# Sent through `colab exec`, i.e. executed as a cell inside the IPython kernel (M0 F2):
#   * must return within seconds, must NOT call sys.exit() (IPython shows SystemExit as an error);
#   * success is decided by the single `FKSTATUS {json}` line on stdout, never by exit code (A1).
# Python standard library only. Names are `_fk`-prefixed because the cell shares the kernel namespace.
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time


def _fk_emit(obj):
    print("FKSTATUS " + json.dumps(obj, separators=(",", ":")), flush=True)


def _fk_pid_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:  # a finished child of this kernel stays a zombie until reaped: treat as dead
        with open("/proc/%d/stat" % pid) as f:
            if f.read().rsplit(")", 1)[1].split()[0] == "Z":
                return False
    except (OSError, IndexError):
        pass
    return True


def _fk_read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _fk_safe_extract(bundle, dest):
    """Extract regular files and directories only; reject absolute paths, `..`, links, devices."""
    dest_real = os.path.realpath(dest)
    with tarfile.open(bundle, "r:*") as tf:
        members = tf.getmembers()
        for m in members:
            name = m.name.replace("\\", "/")
            if name.startswith("/") or ".." in name.split("/"):
                raise ValueError("unsafe path in bundle: %r" % m.name)
            target = os.path.realpath(os.path.join(dest, name))
            if target != dest_real and not target.startswith(dest_real + os.sep):
                raise ValueError("bundle member escapes the root: %r" % m.name)
            if not (m.isfile() or m.isdir()):
                raise ValueError("unsupported bundle member type: %r" % m.name)
        for m in members:  # all members validated: nothing was written for a rejected bundle
            target = os.path.join(dest, m.name)
            if m.isdir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with tf.extractfile(m) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
            os.chmod(target, (m.mode & 0o777) | 0o600)  # keeps secrets.env at 0600
    return len(members)


def _fk_kick():
    root = os.environ.get("FK_ROOT", "/content/fk")
    for sub in ("", "out", "logs", "inputs", "vm"):  # A4: dirs exist before any upload/extract
        os.makedirs(os.path.join(root, sub), exist_ok=True)
    pid_file = os.path.join(root, "runner.pid")
    status_file = os.path.join(root, "status.json")

    pid = None
    try:
        with open(pid_file) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        pass
    if pid is not None and _fk_pid_alive(pid):
        return {"ok": True, "kicked": False, "reason": "runner-alive", "pid": pid}
    status = _fk_read_json(status_file)
    if status is not None:  # a previous runner already ran: never re-run generations (no retry rule)
        return {"ok": True, "kicked": False, "reason": "runner-finished", "phase": status.get("phase")}

    bundle = os.path.join(root, "bundle.tar.gz")
    if not os.path.isfile(bundle):
        return {"ok": False, "error": "bundle not found: " + bundle}
    n = _fk_safe_extract(bundle, root)
    runner = os.path.join(root, "vm", "fk_runner.py")
    if not os.path.isfile(runner):
        return {"ok": False, "error": "bundle has no vm/fk_runner.py"}

    with open(os.path.join(root, "host.heartbeat"), "a"):
        pass
    os.utime(os.path.join(root, "host.heartbeat"), None)
    env = dict(os.environ)
    env["FK_ROOT"] = root
    cmd = [sys.executable, "-u", runner]
    popen_kw = {}
    if shutil.which("setsid"):  # M0 F3: `setsid nohup` survives restart-kernel
        cmd = ["setsid", "nohup"] + cmd
    else:  # macOS (tests): same detachment via start_new_session
        cmd = ["nohup"] + cmd
        popen_kw["start_new_session"] = True
    log = open(os.path.join(root, "logs", "runner.log"), "ab")
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                            cwd=root, env=env, close_fds=True, **popen_kw)
    log.close()
    with open(pid_file, "w") as f:
        f.write(str(proc.pid))
    time.sleep(0.2)
    return {"ok": True, "kicked": True, "pid": proc.pid, "extracted": n}


try:
    _fk_emit(_fk_kick())
except BaseException as _fk_e:  # noqa: BLE001 - IPython cell: report, never raise
    _fk_emit({"ok": False, "error": "%s: %s" % (type(_fk_e).__name__, _fk_e)})
