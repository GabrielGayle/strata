"""Strata cloud jobs (Boost) on Modal.

One CPU function, `run_job`, runs a job (terrain, pack or nest) with the same TypeScript engine as the app
(worker/dist/job.mjs, bundled from src/ by `npx tsx worker/build.ts`), plus a small
web API the Vercel routes in api/geo.ts call with a Modal proxy auth token:

    GET  /health            engine build of this deploy
    POST /jobs              spawn a job, returns {"id"}
    GET  /jobs/{id}         running (with progress) / done / failed / cancelled
    POST /jobs/{id}/cancel
    GET  /usage             this month's job count, an estimate from job seconds, and the
                            workspace's billed cost when the plan has billing reports

A hero job (`run_hero`) builds the design's model.glb with the same bundle, has the
strata-hero app (worker/hero.py, an L4) render it with Blender, and stores the PNG. At
most HERO_DAILY_LIMIT renders start each UTC day; a render already in the cloud cache
never reaches here, so it is free.

Deploy from the repo root (after building the bundle):
    npx tsx worker/build.ts && modal deploy worker/hero.py && modal deploy worker/app.py

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
# Hero renders (api/_lib/geoJob.ts has the same numbers): an L4 with 4 cores and 16 GB.
HERO_APP = "strata-hero"
HERO_DAILY_LIMIT = 10
HERO_RATE_PER_SECOND = 0.00031
HERO_TYPICAL_SECONDS = 150

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
# Hero renders started per UTC day, for the daily limit.
hero_daily = modal.Dict.from_name("strata-hero-daily", create_if_missing=True)
secret = modal.Secret.from_name("strata-cloud")

# Exit codes of job.mjs
EXIT_BAD_REQUEST = 2
EXIT_OUT_OF_DATE = 3


def _month() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m")


def _day() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


def _log_usage(seconds: float, cost: float | None = None) -> None:
    month = _month()
    prev = usage_log.get(month, {"jobs": 0, "seconds": 0.0, "heroUsd": 0.0})
    usage_log[month] = {
        "jobs": prev["jobs"] + 1,
        "seconds": prev["seconds"] + seconds,
        # hero renders are billed at the GPU rate, so they are added up in dollars
        "heroUsd": prev.get("heroUsd", 0.0) + (cost or 0.0),
    }


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
    _log_usage(seconds)
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


def _node(args: list[str], stdin: str | None = None, call_id: str | None = None) -> tuple[int, str, list[str]]:
    """Run job.mjs; returns its exit code, its last stdout line and its error lines."""
    proc = subprocess.run(["node", JOB_BUNDLE, *args], input=stdin, capture_output=True, text=True)
    errors = [l.strip().removeprefix("error: ") for l in proc.stderr.splitlines() if l.strip() and not l.startswith("@progress ")]
    lines = proc.stdout.strip().splitlines()
    return proc.returncode, (lines[-1] if lines else ""), errors


@app.function(image=image, cpu=2, memory=4096, timeout=600, max_containers=2, secrets=[secret])
def run_hero(request: dict) -> dict:
    """A hero render: model.glb from the design here, Blender on the strata-hero GPU app, the PNG into the store."""
    import tempfile

    call_id = modal.current_function_call_id()
    started = time.time()
    rendered = False
    try:
        with tempfile.TemporaryDirectory() as d:
            progress[call_id] = {"progress": 0.05, "stage": "building the model"}
            code, out, errors = _node(["--hero-dir", d], json.dumps(request))
            message = errors[-1] if errors else f"job exited with code {code}"
            if code == EXIT_OUT_OF_DATE:
                return {"ok": False, "reason": "out-of-date", "error": message}
            if code != 0:
                return {"ok": False, "reason": "failed", "error": message}
            built = json.loads(out)
            with open(f"{d}/settings.json") as f:
                settings = json.load(f)
            with open(f"{d}/model.glb", "rb") as f:
                glb = f.read()
            render = modal.Function.from_name(HERO_APP, "render")
            gpu_started = time.time()
            child = render.spawn(glb, settings)
            progress[call_id] = {"progress": 0.2, "stage": "rendering", "child": child.object_id}
            while True:
                try:
                    result = child.get(timeout=2)
                    break
                except TimeoutError:
                    done = min(1.0, (time.time() - gpu_started) / HERO_TYPICAL_SECONDS)
                    progress[call_id] = {"progress": round(0.2 + 0.7 * done, 2), "stage": "rendering", "child": child.object_id}
            # billed from the moment it was asked for, start-up included
            gpu_seconds = time.time() - gpu_started
            rendered = True
            if not result.get("ok"):
                return {"ok": False, "reason": "failed", "error": f"Blender: {result.get('error', 'failed')}", "gpuSeconds": gpu_seconds}
            progress[call_id] = {"progress": 0.95, "stage": "saving"}
            with open(f"{d}/hero.png", "wb") as f:
                f.write(result["png"])
            code, _, errors = _node(["--store", built["key"], f"{d}/hero.png"])
            if code != 0:
                return {"ok": False, "reason": "failed", "error": errors[-1] if errors else "could not store the render"}
            seconds = time.time() - started
            cost = (seconds - gpu_seconds) * RATE_PER_SECOND + gpu_seconds * HERO_RATE_PER_SECOND
            # the whole render, CPU and GPU, goes in as dollars
            _log_usage(0.0, cost)
            return {
                "ok": True,
                "key": built["key"],
                "meta": built.get("meta") or {},
                "fingerprint": built.get("fingerprint"),
                "device": result.get("device"),
                "seconds": round(seconds, 2),
                "gpuSeconds": round(gpu_seconds, 2),
                "costUsd": round(cost, 4),
            }
    finally:
        progress.pop(call_id, None)
        if not rendered:
            # nothing reached the GPU: give the day's render back
            day = _day()
            hero_daily[day] = max(0, hero_daily.get(day, 1) - 1)


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
    from fastapi.responses import JSONResponse

    web = FastAPI()

    @web.get("/health")
    def health() -> dict:
        return {"ok": True, "app": APP_NAME, "engine": _bundle_engine()}

    @web.post("/jobs")
    def submit(request: dict = Body(...)):
        if request.get("kind") == "hero":
            day = _day()
            started = hero_daily.get(day, 0)
            if started >= HERO_DAILY_LIMIT:
                return JSONResponse(
                    status_code=429,
                    content={"error": f"{HERO_DAILY_LIMIT} hero renders a day: the next one can start tomorrow (UTC)", "reason": "limit"},
                )
            hero_daily[day] = started + 1
            call = run_hero.spawn(request)
            progress[call.object_id] = {"progress": 0.0, "stage": "queued"}
            return {"id": call.object_id}
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
        seconds = float(result.get("seconds") or 0)
        out = {
            "id": call_id,
            "status": "done",
            "key": result["key"],
            "px": result.get("px"),
            "ms": result.get("ms"),
            "meta": result.get("meta") or {},
            # what this one job cost: CPU seconds at the same rate as /usage, a hero render's GPU time at the L4 rate
            "seconds": seconds,
            "costUsd": result["costUsd"] if "costUsd" in result else round(seconds * RATE_PER_SECOND, 5),
        }
        if result.get("fingerprint"):
            out["fingerprint"] = result["fingerprint"]
        return out

    @web.post("/jobs/{call_id}/cancel")
    def cancel(call_id: str) -> dict:
        if not call_id.startswith("fc-"):
            raise HTTPException(status_code=400, detail="Invalid job id")
        modal.FunctionCall.from_id(call_id).cancel()
        child = progress.get(call_id, {}).get("child")
        if child:
            # a hero render's GPU call goes too
            modal.FunctionCall.from_id(child).cancel()
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
            "estimateUsd": round(logged["seconds"] * RATE_PER_SECOND + logged.get("heroUsd", 0.0), 4),
            "grantUsd": MONTHLY_GRANT_USD,
            "heroToday": hero_daily.get(_day(), 0),
            "heroLimit": HERO_DAILY_LIMIT,
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
