# latentsync-colab/v1 -- abort: create /content/ls/abort; the runner kills its current step and ends `aborted`.
import json
import os

try:
    os.makedirs("/content/ls", exist_ok=True)
    with open("/content/ls/abort", "w") as _ls_f:
        _ls_f.write("abort\n")
    print("FKSTATUS " + json.dumps({"ok": True, "abort": True}), flush=True)
except BaseException as _ls_e:  # noqa: BLE001
    print("FKSTATUS " + json.dumps({"ok": False, "error": "%s: %s" % (type(_ls_e).__name__, _ls_e)}), flush=True)
