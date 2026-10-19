# latentsync-colab/v1 -- mkdirs: create LS_ROOT and subdirs BEFORE `colab upload` (upload 500s on a missing
# parent dir, colab-comfy M0 A4). Runs as an IPython cell via `colab exec`: fast, no sys.exit, one FKSTATUS line.
import json
import os


def _ls_emit(obj):
    print("FKSTATUS " + json.dumps(obj, separators=(",", ":")), flush=True)


try:
    _ls_root = "/content/ls"
    for _ls_sub in ("", "out", "logs", "inputs", "vm"):
        os.makedirs(os.path.join(_ls_root, _ls_sub), exist_ok=True)
    _ls_emit({"ok": True, "root": _ls_root})
except BaseException as _ls_e:  # noqa: BLE001
    _ls_emit({"ok": False, "error": "%s: %s" % (type(_ls_e).__name__, _ls_e)})
