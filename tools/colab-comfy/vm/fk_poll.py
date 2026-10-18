# colab-comfy/v1 -- poll: touch the host heartbeat and print status.json on one `FKSTATUS` line.
# Runs as an IPython cell via `colab exec` (see fk_kick.py header): fast, no sys.exit, one line.
import json
import os


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
        return {"ok": False, "error": "status.json not written yet", "runnerAlive": _fk_runner_alive(root)}
    status["runnerAlive"] = _fk_runner_alive(root)  # additive field: lets the host see a dead runner
    return status


try:
    _fk_emit(_fk_poll())
except BaseException as _fk_e:  # noqa: BLE001
    _fk_emit({"ok": False, "error": "%s: %s" % (type(_fk_e).__name__, _fk_e)})
