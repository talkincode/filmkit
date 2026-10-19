# latentsync-colab/v1 -- kick: extract the uploaded bundle and start vm/ls_runner.py detached (setsid nohup,
# survives restart-kernel, colab-comfy M0 F3). IPython cell via `colab exec`: returns in seconds, no sys.exit,
# success ONLY from the FKSTATUS line (exec rc is always 0, A1). Refuses to start a second runner or to re-run
# after a finished one (no-retry rule). Standard library only; names `_ls`-prefixed (shared kernel namespace).
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time


def _ls_emit(obj):
    print("FKSTATUS " + json.dumps(obj, separators=(",", ":")), flush=True)


def _ls_alive(pid):
    try:
        os.kill(pid, 0)
        with open("/proc/%d/stat" % pid) as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except (OSError, IndexError):
        return False


def _ls_extract(bundle, dest):
    dest_real = os.path.realpath(dest)
    with tarfile.open(bundle, "r:*") as tf:
        members = tf.getmembers()
        for m in members:
            name = m.name.replace("\\", "/")
            target = os.path.realpath(os.path.join(dest, name))
            if name.startswith("/") or ".." in name.split("/") or not (m.isfile() or m.isdir()) or \
                    (target != dest_real and not target.startswith(dest_real + os.sep)):
                raise ValueError("unsafe bundle member: %r" % m.name)
        tf.extractall(dest)
    return len(members)


def _ls_kick():
    root = "/content/ls"
    pid_file, status_file = os.path.join(root, "runner.pid"), os.path.join(root, "status.json")
    try:
        with open(pid_file) as f:
            pid = int(f.read().strip())
        if _ls_alive(pid):
            return {"ok": True, "kicked": False, "reason": "runner-alive", "pid": pid}
    except (OSError, ValueError):
        pass
    if os.path.exists(status_file):
        return {"ok": True, "kicked": False, "reason": "runner-finished"}
    bundle = os.path.join(root, "bundle.tar.gz")
    if not os.path.isfile(bundle):
        return {"ok": False, "error": "bundle not found: " + bundle}
    n = _ls_extract(bundle, root)
    runner = os.path.join(root, "vm", "ls_runner.py")
    if not os.path.isfile(runner):
        return {"ok": False, "error": "bundle has no vm/ls_runner.py"}
    open(os.path.join(root, "host.heartbeat"), "a").close()
    os.utime(os.path.join(root, "host.heartbeat"), None)
    cmd = ["setsid", "nohup", sys.executable, "-u", runner] if shutil.which("setsid") else [sys.executable, "-u", runner]
    log = open(os.path.join(root, "logs", "runner.log"), "ab")
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, cwd=root,
                            close_fds=True, start_new_session=not shutil.which("setsid"))
    log.close()
    with open(pid_file, "w") as f:
        f.write(str(proc.pid))
    time.sleep(0.2)
    return {"ok": True, "kicked": True, "pid": proc.pid, "extracted": n}


try:
    _ls_emit(_ls_kick())
except BaseException as _ls_e:  # noqa: BLE001
    _ls_emit({"ok": False, "error": "%s: %s" % (type(_ls_e).__name__, _ls_e)})
