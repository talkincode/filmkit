# colab-comfy/v1 -- abort: create FK_ROOT/abort; the runner interrupts ComfyUI and ends in phase `aborted`.
# Runs as an IPython cell via `colab exec` (see fk_kick.py header).
import json
import os


def _fk_emit(obj):
    print("FKSTATUS " + json.dumps(obj, separators=(",", ":")), flush=True)


def _fk_abort():
    root = os.environ.get("FK_ROOT", "/content/fk")
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(root, "abort"), "w") as f:
        f.write("abort\n")
    return {"ok": True, "abort": True}


try:
    _fk_emit(_fk_abort())
except BaseException as _fk_e:  # noqa: BLE001
    _fk_emit({"ok": False, "error": "%s: %s" % (type(_fk_e).__name__, _fk_e)})
