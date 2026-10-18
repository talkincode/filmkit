"""colab-comfy/v1 -- VM setup: pinned ComfyUI + custom nodes + weights (mirrors ref2va-kit/setup.py).

Imported by fk_runner.py (python standard library only). `run_setup()` is idempotent within a
session via FK_ROOT/setup.done (contains the manifest sha). Tests use FK_FAKE_SETUP=1, which
skips git/pip/hf entirely and takes `env` from the JSON file in FK_FAKE_ENV (or a built-in one).
"""
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time

# Values read from secrets.env; redacted from everything this module reports. Never logged.
_SECRET_VALUES = set()
_REDACT_PATTERNS = [
    (re.compile(r"hf_[A-Za-z0-9]{30,}"), "hf_***"),
    (re.compile(r"Bearer\s+\S+"), "Bearer ***"),
    (re.compile(r"ya29\.[\w-]+"), "ya29.***"),
    (re.compile(r"([?&](?:token|access_token|authuser_token|colab-runtime-proxy-token))=[^&\s]+"), r"\1=***"),
]


class SetupError(Exception):
    pass


class SetupAborted(Exception):
    pass


def redact(text):
    text = str(text)
    for v in _SECRET_VALUES:
        if v:
            text = text.replace(v, "***")
    for pat, rep in _REDACT_PATTERNS:
        text = pat.sub(rep, text)
    return text


def read_secrets(path):
    """Read KEY=VALUE lines then delete the file. Returns the dict; values are never logged."""
    secrets = {}
    if not os.path.isfile(path):
        return secrets
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            secrets[k.strip()] = v.strip().strip("'\"")
    os.remove(path)
    _SECRET_VALUES.update(v for v in secrets.values() if len(v) >= 6)
    return secrets


def weight_plan(manifest, models_dir):
    """Group manifest weights into one `hf download` per (repo, revision, local-dir).

    `file` is the path inside the HF repo. `hf download` recreates that path under --local-dir, so a
    file with a directory part ("vae/x.safetensors") goes to <models>; a bare file name
    ("x.safetensors") goes to <models>/<subdir> (loras). Returns (groups, expected) where expected
    is [(absolute_path, bytes, sha256)].
    """
    groups = {}
    expected = []
    for w in manifest.get("weights", []):
        rel = w["file"]
        if rel.startswith("/") or ".." in rel.split("/"):
            raise SetupError("unsafe weight path in manifest: %r" % rel)
        local_dir = models_dir if "/" in rel else os.path.join(models_dir, w["subdir"])
        groups.setdefault((w["repo"], w["revision"], local_dir), []).append(rel)
        expected.append((os.path.join(local_dir, rel), w["bytes"], w.get("sha256")))
    return groups, expected


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _run(cmd, log, deadline, should_abort, env=None, cwd=None):
    """Run cmd (list), append output to the log file, poll for deadline/abort. Returns rc."""
    log.write(("+ " + redact(" ".join(cmd)) + "\n").encode())
    log.flush()
    proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                            env=env, cwd=cwd)
    while True:
        try:
            return proc.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            pass
        if should_abort():
            proc.kill()
            proc.wait()
            raise SetupAborted("abort requested during setup")
        if time.time() > deadline:
            proc.kill()
            proc.wait()
            raise SetupError("setup timeout: " + redact(" ".join(cmd)[:200]))


def _tail(path, n=1500):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - n))
            return redact(f.read().decode("utf-8", "replace"))
    except OSError:
        return ""


def _git_pin(repo, commit, dest, run):
    if not os.path.isdir(os.path.join(dest, ".git")):
        run(["git", "clone", "-q", "--no-checkout", "--depth", "1", repo, dest])
    run(["git", "-C", dest, "fetch", "-q", "--depth", "1", "origin", commit])
    run(["git", "-C", dest, "checkout", "-q", commit])
    head = subprocess.run(["git", "-C", dest, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    if head != commit:
        raise SetupError("%s is at %s, manifest pins %s" % (dest, head, commit))


_ENV_PROBE = r"""
import json, platform
out = {"python": platform.python_version(), "torch": None, "cuda": None, "comfyKitchen": None}
try:
    import torch
    out["torch"] = torch.__version__
    out["cuda"] = torch.version.cuda
except Exception:
    pass
try:
    from importlib import metadata
    out["comfyKitchen"] = metadata.version("comfy-kitchen")
except Exception:
    pass
print("FKENV " + json.dumps(out))
"""


def _gpu():
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=name,driver_version,memory.total",
                            "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=20)
        if r.returncode == 0 and r.stdout.strip():
            name, driver, mem = [p.strip() for p in r.stdout.strip().splitlines()[0].split(",")]
            return {"name": name, "driver": driver, "memoryMiB": int(float(mem))}
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


def fake_env(manifest):
    """Env used when FK_FAKE_SETUP=1: FK_FAKE_ENV (JSON path) wins, else a built-in fake."""
    path = os.environ.get("FK_FAKE_ENV")
    if path:
        with open(path) as f:
            return json.load(f)
    return {
        "gpu": {"name": "FAKE GPU", "driver": "0.0", "memoryMiB": 0},
        "python": platform.python_version(), "torch": "fake", "cuda": "fake", "comfyKitchen": "fake",
        "comfyui": dict(manifest.get("comfyui", {})),
        "customNodes": [dict(n) for n in manifest.get("customNodes", [])],
        "weights": [{"repo": w["repo"], "file": w["file"], "revision": w["revision"],
                     "sha256": w.get("sha256"), "bytes": w["bytes"], "verified": "fake"}
                    for w in manifest.get("weights", [])],
    }


def run_setup(root, manifest, manifest_sha, limits, comfy_dir, should_abort=lambda: False,
              on_phase=lambda name: None):
    """Returns {"env": {...}, "setup": {startedAt, finishedAt, pipSec, downloadSec}}. Raises SetupError/SetupAborted."""
    started = time.time()
    logs = os.path.join(root, "logs")
    os.makedirs(logs, exist_ok=True)
    secrets = read_secrets(os.path.join(root, "secrets.env"))  # read + deleted even in fake mode
    timing = {"startedAt": started, "finishedAt": 0, "pipSec": 0, "downloadSec": 0}

    if os.environ.get("FK_FAKE_SETUP") == "1":
        timing["finishedAt"] = time.time()
        return {"env": fake_env(manifest), "setup": timing}

    deadline = started + float(limits.get("setupTimeoutSec", 1800))
    done_file = os.path.join(root, "setup.done")
    models = os.path.join(comfy_dir, "models")
    parent = os.path.dirname(comfy_dir.rstrip("/")) or "/"
    with open(os.path.join(logs, "setup.log"), "ab") as log:
        def run(cmd, env=None, cwd=None):
            rc = _run(cmd, log, deadline, should_abort, env=env, cwd=cwd)
            if rc != 0:
                log.flush()
                raise SetupError("command failed (rc=%d): %s\n%s" % (
                    rc, redact(" ".join(cmd)[:200]), _tail(os.path.join(logs, "setup.log"))))

        already = False
        try:
            with open(done_file) as f:
                already = f.read().strip() == manifest_sha and os.path.isdir(comfy_dir)
        except OSError:
            pass

        if not already:
            # Disk check first (spec lists it after pip): failing before a 10-minute install is cheaper.
            need = float(manifest.get("diskFreeGB", 0))
            free = shutil.disk_usage(parent).free / 1e9
            if free < need:
                raise SetupError("not enough disk: %.1f GB free, manifest needs %.1f GB" % (free, need))

            _git_pin(manifest["comfyui"]["repo"], manifest["comfyui"]["commit"], comfy_dir, run)
            for node in manifest.get("customNodes", []):
                name = node["repo"].rstrip("/").split("/")[-1].removesuffix(".git")
                _git_pin(node["repo"], node["commit"], os.path.join(comfy_dir, "custom_nodes", name), run)

            t = time.time()
            run([sys.executable, "-m", "pip", "install", "-q", "-r", os.path.join(comfy_dir, "requirements.txt")])
            # Pinned by the manifest when `pip` is given, else unpinned like the proven kit.
            run([sys.executable, "-m", "pip", "install", "-q", "-U"]
                + list(manifest.get("pip", ["huggingface_hub", "hf_xet", "hf_transfer"])))
            timing["pipSec"] = round(time.time() - t, 1)

            hf_env = dict(os.environ)
            hf_env.update(secrets)  # HF token only reaches the hf subprocesses, not ComfyUI
            hf_env["HF_XET_HIGH_PERFORMANCE"] = "1"
            hf_env["HF_HUB_ENABLE_HF_TRANSFER"] = "1"
            groups, expected = weight_plan(manifest, models)
            t = time.time()
            procs = []
            for (repo, rev, local_dir), files in groups.items():
                os.makedirs(local_dir, exist_ok=True)
                cmd = ["hf", "download", repo] + files + ["--revision", rev, "--local-dir", local_dir]
                log.write(("+ " + " ".join(cmd) + "\n").encode())
                log.flush()
                procs.append((cmd, subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT,
                                                    stdin=subprocess.DEVNULL, env=hf_env)))
            try:
                while any(p.poll() is None for _, p in procs):
                    time.sleep(0.5)
                    if should_abort():
                        raise SetupAborted("abort requested during setup")
                    if time.time() > deadline:
                        raise SetupError("setup timeout during weight download")
            finally:
                for _, p in procs:
                    if p.poll() is None:
                        p.kill()
            bad = [" ".join(c[:4]) for c, p in procs if p.returncode != 0]
            if bad:
                raise SetupError("hf download failed: %s\n%s" % (bad, _tail(os.path.join(logs, "setup.log"))))
            timing["downloadSec"] = round(time.time() - t, 1)

            for path, size, _sha in expected:
                if not os.path.isfile(path) or os.path.getsize(path) != size:
                    got = os.path.getsize(path) if os.path.isfile(path) else "missing"
                    raise SetupError("weight size mismatch: %s expected %d got %s" % (path, size, got))
            with open(done_file, "w") as f:
                f.write(manifest_sha)

        # Verification + env are recomputed every run (cheap unless verifySha256 is on).
        _groups, expected = weight_plan(manifest, models)
        verified = []
        for w, (path, size, sha) in zip(manifest.get("weights", []), expected):
            if not os.path.isfile(path) or os.path.getsize(path) != size:
                raise SetupError("weight missing or wrong size: %s" % path)
            how = "size"
            if manifest.get("verifySha256"):
                if _sha256(path) != sha:
                    raise SetupError("weight sha256 mismatch: %s" % path)
                how = "sha256"
            verified.append({"repo": w["repo"], "file": w["file"], "revision": w["revision"],
                             "sha256": sha, "bytes": size, "verified": how})

        probe = subprocess.run([sys.executable, "-c", _ENV_PROBE], capture_output=True, text=True, timeout=120)
        info = {}
        for line in probe.stdout.splitlines():
            if line.startswith("FKENV "):
                info = json.loads(line[6:])

        def head(path):
            return subprocess.run(["git", "-C", path, "rev-parse", "HEAD"], capture_output=True,
                                  text=True).stdout.strip()
        env = {
            "gpu": _gpu(),
            "python": info.get("python"), "torch": info.get("torch"), "cuda": info.get("cuda"),
            "comfyKitchen": info.get("comfyKitchen"),
            "comfyui": {"repo": manifest["comfyui"]["repo"], "commit": head(comfy_dir)},
            "customNodes": [{"repo": n["repo"], "commit": head(os.path.join(
                comfy_dir, "custom_nodes", n["repo"].rstrip("/").split("/")[-1].removesuffix(".git")))}
                for n in manifest.get("customNodes", [])],
            "weights": verified,
        }
    timing["finishedAt"] = time.time()
    return {"env": env, "setup": timing}


if __name__ == "__main__":  # standalone: python fk_setup.py  (FK_ROOT as usual)
    _root = os.environ.get("FK_ROOT", "/content/fk")
    with open(os.path.join(_root, "jobs.json")) as _f:
        _jobs = json.load(_f)
    _res = run_setup(_root, _jobs["manifest"], _jobs.get("manifestSha256", ""), _jobs.get("limits", {}),
                     os.environ.get("FK_COMFY_DIR", os.path.join(os.path.dirname(_root.rstrip("/")), "ComfyUI")))
    print(json.dumps(_res))
