"""Fake `google.colab.runtime` for tests (never talks to Google).

unassign() marks the fake Colab session as released: it writes the epoch-ms to
$FAKE_COLAB_RELEASE_FILE if set, else to $FAKE_COLAB_SESSION_DIR/released. The fake `colab` CLI then
stops listing the session (M0 F5: the VM is gone, `sessions` prints it as pruned).
"""
import os
import time


def unassign():
    path = os.environ.get("FAKE_COLAB_RELEASE_FILE")
    if not path:
        d = os.environ.get("FAKE_COLAB_SESSION_DIR")
        if not d:
            raise RuntimeError("fake google.colab.runtime: neither FAKE_COLAB_RELEASE_FILE nor FAKE_COLAB_SESSION_DIR is set")
        path = os.path.join(d, "released")
    with open(path, "w") as f:
        f.write(str(int(time.time() * 1000)))
