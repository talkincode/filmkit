# colab-comfy/v1 -- mkdirs: create FK_ROOT and its subdirectories (A4: `colab upload` fails with a 500 when the
# remote parent dir is missing, so the host runs this via `colab exec` BEFORE uploading the bundle).
# Runs as an IPython cell: fast, no sys.exit, one FKSTATUS line.
import json
import os


def _fk_emit(obj):
    print("FKSTATUS " + json.dumps(obj, separators=(",", ":")), flush=True)


try:
    _fk_root = os.environ.get("FK_ROOT", "/content/fk")
    for _fk_sub in ("", "out", "logs", "inputs", "vm"):
        os.makedirs(os.path.join(_fk_root, _fk_sub), exist_ok=True)
    _fk_emit({"ok": True, "root": _fk_root})
except BaseException as _fk_e:  # noqa: BLE001
    _fk_emit({"ok": False, "error": "%s: %s" % (type(_fk_e).__name__, _fk_e)})
