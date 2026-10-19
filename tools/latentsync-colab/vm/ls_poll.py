# latentsync-colab/v1 -- poll: touch the host heartbeat, print status.json on one FKSTATUS line.
# If the runner's watchdog left release.request, print "releasing": true FIRST, then unassign from kernel code
# (verified path, colab-comfy M0 F5); the host then goes straight to stop + verify.
import json
import os
import sys


def _ls_emit(obj):
    print("FKSTATUS " + json.dumps(obj, separators=(",", ":")), flush=True)


def _ls_poll():
    root = "/content/ls"
    hb = os.path.join(root, "host.heartbeat")
    open(hb, "a").close()
    os.utime(hb, None)
    try:
        with open(os.path.join(root, "status.json")) as f:
            st = json.load(f)
    except FileNotFoundError:
        st = {"ok": False, "error": "status.json not written yet"}
    try:
        with open(os.path.join(root, "runner.pid")) as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
        with open("/proc/%d/stat" % pid) as f:
            st["runnerAlive"] = f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except (OSError, ValueError, IndexError):
        st["runnerAlive"] = False
    if os.path.exists(os.path.join(root, "release.request")):
        st["releasing"] = True
    return st


_ls_status = None
try:
    _ls_status = _ls_poll()
    _ls_emit(_ls_status)
    if _ls_status.get("releasing"):
        from google.colab import runtime
        runtime.unassign()
except BaseException as _ls_e:  # noqa: BLE001
    if _ls_status is not None and _ls_status.get("releasing"):
        print("ls_poll: unassign failed: %s: %s" % (type(_ls_e).__name__, _ls_e), file=sys.stderr)
    else:
        _ls_emit({"ok": False, "error": "%s: %s" % (type(_ls_e).__name__, _ls_e)})
