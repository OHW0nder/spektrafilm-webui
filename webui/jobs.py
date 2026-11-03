"""Very small file-backed job store for full-resolution renders.

One render at a time: the pipeline saturates all cores and a 24 MP frame is
memory-heavy on a 13 GiB shared-memory APU, so concurrency buys nothing.
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from typing import Any

_LOCK = threading.Lock()


class JobStore:
    def __init__(self, directory: str) -> None:
        self._dir = directory
        os.makedirs(self._dir, exist_ok=True)

    def create(self, **meta: Any) -> dict[str, Any]:
        job = {
            "id": uuid.uuid4().hex[:12],
            "status": "queued",
            "created": time.time(),
            "finished": None,
            "error": None,
            "output": None,
            "engine": "python-f64",
            **meta,
        }
        self._write(job)
        return job

    def update(self, job_id: str, **fields: Any) -> dict[str, Any]:
        job = self.get(job_id)
        job.update(fields)
        self._write(job)
        return job

    def get(self, job_id: str) -> dict[str, Any]:
        path = self._path(job_id)
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def exists(self, job_id: str) -> bool:
        return os.path.exists(self._path(job_id))

    def list_recent(self, limit: int = 20) -> list[dict[str, Any]]:
        entries = []
        for name in os.listdir(self._dir):
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(self._dir, name), "r", encoding="utf-8") as handle:
                    entries.append(json.load(handle))
            except (OSError, json.JSONDecodeError):
                continue
        entries.sort(key=lambda job: job.get("created", 0), reverse=True)
        return entries[:limit]

    def _write(self, job: dict[str, Any]) -> None:
        tmp = self._path(job["id"]) + ".tmp"
        with _LOCK:
            with open(tmp, "w", encoding="utf-8") as handle:
                json.dump(job, handle)
            os.replace(tmp, self._path(job["id"]))

    def _path(self, job_id: str) -> str:
        safe = "".join(ch for ch in job_id if ch.isalnum())
        return os.path.join(self._dir, f"{safe}.json")
