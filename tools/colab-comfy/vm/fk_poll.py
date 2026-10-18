# colab-comfy/v1 -- poll: touch the host heartbeat and print status.json on one `FKSTATUS` line.
# Runs as an IPython cell via `colab exec` (see fk_kick.py header): fast, no sys.exit, one line.
#
# Self-release fallback: when the runner's watchdog fired it left FK_ROOT/release.request (the detached
# runner's own runtime.unassign() is unverified). This cell then prints its line with "releasing": true
# FIRST and only afterwards calls google.colab.runtime.unassign(), which is verified from kernel code (M0 F5).
# The host treats `releasing: true` as "session ending" and goes straight to STOP/VERIFY.
import json
import os
import sys


def _fk_emit(obj):
    print("FKSTATUS " + json.dumps(obj, separators=(",", ":")), flush=True)


def _fk_runner_alive(root):
    try:
        with open(os.path.join(root, "runner.pid")) as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
    except (OSError, ValueError):
        return False
    try:
        with open("/proc/%d/stat" % pid) as f:
            if f.read().rsplit(")", 1)[1].split()[0] == "Z":
                return False
    except (OSError, IndexError):
        pass
    return True


def _fk_poll():
    root = os.environ.get("FK_ROOT", "/content/fk")
    hb = os.path.join(root, "host.heartbeat")
    with open(hb, "a"):
        pass
    os.utime(hb, None)
    try:
        with open(os.path.join(root, "status.json")) as f:
            status = json.load(f)
    except FileNotFoundError:
        status = {"ok": False, "error": "status.json not written yet"}
    status["runnerAlive"] = _fk_runner_alive(root)  # additive field: lets the host see a dead runner
    if os.path.exists(os.path.join(root, "release.request")):
        status["releasing"] = True
    return status


def _fk_unassign():
    # Only reached after the FKSTATUS line was flushed. A failure is reported on stderr, never raised:
    # the host still stops the session itself.
    from google.colab import runtime

    runtime.unassign()


_fk_status = None  # the kernel namespace is shared by all cells: never trust a leftover from an earlier poll
try:
    _fk_status = _fk_poll()
    _fk_emit(_fk_status)
    if _fk_status.get("releasing"):
        _fk_unassign()
except BaseException as _fk_e:  # noqa: BLE001
    if _fk_status is not None and _fk_status.get("releasing"):
        print("fk_poll: unassign failed: %s: %s" % (type(_fk_e).__name__, _fk_e), file=sys.stderr)
    else:
        _fk_emit({"ok": False, "error": "%s: %s" % (type(_fk_e).__name__, _fk_e)})
