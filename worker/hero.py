"""Strata hero renders on Modal: Blender Cycles on an L4.

One function, `render(glb, settings)`, takes the model.glb that worker/job.ts builds
from a design (src/core/hero.ts) and returns the PNG that worker/hero_render.py renders
from it. It holds no engine code, so it only needs deploying again when hero_render.py
or this file changes; the strata-cloud app (worker/app.py) builds the GLB, calls this
by name, stores the PNG and counts the day's renders.

Deploy from the repo root:
    modal deploy worker/hero.py
"""

from __future__ import annotations

import json
import subprocess
import tempfile
import time
from pathlib import Path

import modal

APP_NAME = "strata-hero"
SCRIPT = "/app/hero_render.py"
# The longest one render may take (api/_lib/geoJob.ts HERO_MAX_SECONDS): the most a render can cost.
MAX_SECONDS = 300

image = (
    modal.Image.debian_slim(python_version="3.13")
    # what the bpy module needs to start without a display
    .apt_install("libxrender1", "libxi6", "libxkbcommon0", "libsm6", "libgl1", "libxxf86vm1", "libxfixes3", "libegl1", "libgomp1")
    .pip_install("bpy==5.2.2")
    .add_local_file(Path(__file__).parent / "hero_render.py", SCRIPT)
)

app = modal.App(APP_NAME)


@app.function(image=image, gpu="L4", cpu=4, memory=16384, timeout=MAX_SECONDS, max_containers=1)
def render(glb: bytes, settings: dict) -> dict:
    started = time.time()
    width, height = int(settings.get("width", 0)), int(settings.get("height", 0))
    if not (64 <= width <= 2400 and 64 <= height <= 2400):
        return {"ok": False, "error": "picture size out of range"}
    with tempfile.TemporaryDirectory() as d:
        model, out, cfg = Path(d, "model.glb"), Path(d, "hero.png"), Path(d, "settings.json")
        model.write_bytes(glb)
        cfg.write_text(json.dumps(settings))
        proc = subprocess.run(
            ["python", SCRIPT, "--", str(model), str(out), str(cfg)],
            capture_output=True,
            text=True,
            timeout=MAX_SECONDS - 20,
        )
        lines = [l for l in proc.stdout.splitlines() if l.startswith("{")]
        if proc.returncode != 0 or not out.exists():
            tail = [l for l in (proc.stderr or proc.stdout).splitlines() if l.strip()][-3:]
            return {"ok": False, "error": " / ".join(tail)[:300] or f"Blender exited with code {proc.returncode}"}
        info = json.loads(lines[-1]) if lines else {}
        return {"ok": True, "png": out.read_bytes(), "device": info.get("device", "?"), "seconds": round(time.time() - started, 2)}
