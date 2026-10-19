"""Strata cloud jobs (Boost) on Modal.

One CPU function, `run_job`, runs a job with the same TypeScript engine as the app
(worker/dist/job.mjs, bundled from src/ by `npx tsx worker/build.ts`), plus a small
web API the Vercel routes in api/geo.ts call with a Modal proxy auth token:

    GET  /health            engine build of this deploy
    POST /jobs              spawn a job, returns {"id"}
    GET  /jobs/{id}         running (with progress) / done / failed / cancelled
    POST /jobs/{id}/cancel
    GET  /usage             this month's job count, an estimate from job seconds, and the
                            workspace's billed cost when the plan has billing reports

Deploy from the repo root (after building the bundle):
    npx tsx worker/build.ts && modal deploy worker/app.py

Needs a Modal secret named "strata-cloud" holding RENDER_CACHE_READ_WRITE_TOKEN (the
Vercel Blob token the results are written with). The web API URL goes into Vercel as
MODAL_GEO_URL, and a proxy auth token as MODAL_KEY / MODAL_SECRET.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import threading
import time
from pathlib import Path

import modal

APP_NAME = "strata-cloud"
JOB_BUNDLE = "/app/job.mjs"
BUNDLE = Path(__file__).parent / "dist" / "job.mjs"
# One 2-core container with 4 GB, at Modal's 17 Oct 2026 rates.
RATE_PER_SECOND = 0.000035
MONTHLY_GRANT_USD = 30.0

image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.12")
    .pip_install("fastapi[standard]==0.115.12")
    .add_local_file(BUNDLE, JOB_BUNDLE)
)

app = modal.App(APP_NAME)
map_cache = modal.Volume.from_name("strata-map-cache", create_if_missing=True)
# Progress of running jobs, keyed by call id; job seconds per month for the usage estimate.
progress = modal.Dict.from_name("strata-job-progress", create_if_missing=True)
usage_log = modal.Dict.from_name("strata-job-usage", create_if_missing=True)
secret = modal.Secret.from_name("strata-cloud")

# Exit codes of job.mjs
EXIT_BAD_REQUEST = 2
EXIT_OUT_OF_DATE = 3


def _month() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m")


@app.function(
    image=image,
    cpu=2,
    memory=4096,
    timeout=600,
    max_containers=2,
    volumes={"/cache": map_cache},
    secrets=[secret],
)
def run_job(request: dict) -> dict:
    call_id = modal.current_function_call_id()
    started = time.time()
    proc = subprocess.Popen(
        ["node", JOB_BUNDLE],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env={**os.environ, "STRATA_MAP_CACHE": os.environ.get("STRATA_MAP_CACHE", "/cache")},
    )
    errors: list[str] = []

    def read_progress() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            line = line.strip()
            if line.startswith("@progress "):
                parts = line.split(" ", 2)
                try:
                    progress[call_id] = {"progress": float(parts[1]), "stage": parts[2] if len(parts) > 2 else ""}
                except (ValueError, IndexError):
                    pass
            elif line:
                # never log the request or environment; job.mjs only writes its own messages here
                errors.append(line)

    reader = threading.Thread(target=read_progress, daemon=True)
    reader.start()
    assert proc.stdin is not None and proc.stdout is not None
    proc.stdin.write(json.dumps(request))
    proc.stdin.close()
    out = proc.stdout.read()
    code = proc.wait()
    reader.join(timeout=5)
    map_cache.commit()
    seconds = time.time() - started
    month = _month()
    prev = usage_log.get(month, {"jobs": 0, "seconds": 0.0})
    usage_log[month] = {"jobs": prev["jobs"] + 1, "seconds": prev["seconds"] + seconds}
    progress.pop(call_id, None)

    message = errors[-1].removeprefix("error: ") if errors else f"job exited with code {code}"
    if code == EXIT_OUT_OF_DATE:
        return {"ok": False, "reason": "out-of-date", "error": message}
    if code == EXIT_BAD_REQUEST:
        return {"ok": False, "reason": "failed", "error": message}
    if code != 0:
        return {"ok": False, "reason": "failed", "error": message}
    result = json.loads(out.strip().splitlines()[-1])
    return {"ok": True, **result, "seconds": round(seconds, 2)}


_engine: str | None = None


def _bundle_engine() -> str:
    global _engine
    if _engine is None:
        _engine = subprocess.run(["node", JOB_BUNDLE, "--engine"], capture_output=True, text=True, check=True).stdout.strip()
    return _engine


@app.function(image=image, max_containers=1)
@modal.asgi_app(requires_proxy_auth=True)
def api():
    from fastapi import Body, FastAPI, HTTPException

    web = FastAPI()

    @web.get("/health")
    def health() -> dict:
        return {"ok": True, "app": APP_NAME, "engine": _bundle_engine()}

    @web.post("/jobs")
    def submit(request: dict = Body(...)) -> dict:
        call = run_job.spawn(request)
        progress[call.object_id] = {"progress": 0.0, "stage": "queued"}
        return {"id": call.object_id}

    @web.get("/jobs/{call_id}")
    def status(call_id: str) -> dict:
        if not call_id.startswith("fc-"):
            raise HTTPException(status_code=400, detail="Invalid job id")
        call = modal.FunctionCall.from_id(call_id)
        try:
            result = call.get(timeout=0)
        except TimeoutError:
            p = progress.get(call_id, {"progress": 0.0, "stage": "queued"})
            if p.get("cancelled"):
                return {"id": call_id, "status": "cancelled"}
            return {"id": call_id, "status": "running", "progress": p.get("progress", 0.0), "stage": p.get("stage", "")}
        except modal.exception.InputCancellation:
            return {"id": call_id, "status": "cancelled"}
        except Exception as e:  # the job crashed: say how, briefly
            return {"id": call_id, "status": "failed", "reason": "failed", "error": str(e)[:300] or type(e).__name__}
        if not result.get("ok"):
            return {"id": call_id, "status": "failed", "reason": result.get("reason", "failed"), "error": result.get("error", "")}
        return {"id": call_id, "status": "done", "key": result["key"], "px": result.get("px"), "ms": result.get("ms")}

    @web.post("/jobs/{call_id}/cancel")
    def cancel(call_id: str) -> dict:
        if not call_id.startswith("fc-"):
            raise HTTPException(status_code=400, detail="Invalid job id")
        modal.FunctionCall.from_id(call_id).cancel()
        progress[call_id] = {"cancelled": True}
        return {"id": call_id, "status": "cancelled"}

    @web.get("/usage")
    def usage() -> dict:
        month = _month()
        logged = usage_log.get(month, {"jobs": 0, "seconds": 0.0})
        out = {
            "month": month,
            "jobs": logged["jobs"],
            "seconds": round(logged["seconds"], 1),
            "estimateUsd": round(logged["seconds"] * RATE_PER_SECOND, 4),
            "grantUsd": MONTHLY_GRANT_USD,
            # the whole workspace (depth from photo too), which is what the grant covers
            "workspaceUsd": None,
        }
        try:
            start = dt.datetime.now(dt.timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
            items = modal.billing.workspace_billing_report(start=start, resolution="d")
            out["workspaceUsd"] = round(float(sum(i["cost"] for i in items)), 4)
        except Exception:
            # billing reports are not on every plan; the estimate stands
            pass
        return out

    return web
