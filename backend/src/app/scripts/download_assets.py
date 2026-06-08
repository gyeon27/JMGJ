"""Download optional large data assets for the sky-brightness backend.

The Black Marble H5 and DEM raster are intentionally not committed to Git.
In production, set *_URL and *_PATH environment variables. This script downloads
missing files once into the mounted persistent disk before FastAPI starts.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


CHUNK_SIZE = 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 120
ASSETS = (
    {
        "name": "Black Marble H5",
        "url_env": "BLACK_MARBLE_H5_URL",
        "path_env": "BLACK_MARBLE_H5_PATH",
        "min_bytes_env": "BLACK_MARBLE_H5_MIN_BYTES",
    },
    {
        "name": "DEM raster",
        "url_env": "DEM_RASTER_URL",
        "path_env": "DEM_RASTER_PATH",
        "min_bytes_env": "DEM_RASTER_MIN_BYTES",
    },
)


def read_env_file() -> None:
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return

    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def parse_positive_int(value: str | None, default: int) -> int:
    if not value:
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def existing_file_is_usable(path: Path, min_bytes: int) -> bool:
    return path.exists() and path.is_file() and path.stat().st_size >= min_bytes


def download_file(url: str, destination: Path, min_bytes: int) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)

    headers = {"User-Agent": "JMGJ-asset-downloader/1.0"}
    token = os.getenv("GITHUB_RELEASE_TOKEN") or os.getenv("GITHUB_TOKEN")
    if token and "github.com" in url:
        headers["Authorization"] = f"Bearer {token}"

    request = Request(url, headers=headers)
    temp_path: Path | None = None
    started_at = time.monotonic()

    try:
        with tempfile.NamedTemporaryFile(
            delete=False,
            dir=str(destination.parent),
            prefix=f".{destination.name}.",
            suffix=".part",
        ) as temp_file:
            temp_path = Path(temp_file.name)
            with urlopen(request, timeout=DEFAULT_TIMEOUT_SECONDS) as response:
                shutil.copyfileobj(response, temp_file, length=CHUNK_SIZE)

        size = temp_path.stat().st_size
        if size < min_bytes:
            raise RuntimeError(
                f"Downloaded file is too small: {size} bytes < {min_bytes} bytes"
            )

        temp_path.replace(destination)
        elapsed = time.monotonic() - started_at
        print(
            f"[assets] Downloaded {destination} ({size / 1024 / 1024:.1f} MB) "
            f"in {elapsed:.1f}s",
            flush=True,
        )
    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink(missing_ok=True)


def ensure_asset(asset: dict[str, str]) -> None:
    url = os.getenv(asset["url_env"], "").strip()
    path_value = os.getenv(asset["path_env"], "").strip()
    min_bytes = parse_positive_int(os.getenv(asset["min_bytes_env"]), 1)

    if not path_value:
        print(f"[assets] {asset['name']}: {asset['path_env']} is not set; skipping")
        return

    path = Path(path_value)
    if existing_file_is_usable(path, min_bytes):
        print(f"[assets] {asset['name']}: using cached file at {path}")
        return

    if not url:
        print(
            f"[assets] {asset['name']}: file is missing and {asset['url_env']} is not set; "
            "the backend will use the non-asset fallback"
        )
        return

    print(f"[assets] {asset['name']}: downloading to {path}", flush=True)
    download_file(url, path, min_bytes)


def main() -> int:
    read_env_file()
    failures: list[str] = []

    for asset in ASSETS:
        try:
            ensure_asset(asset)
        except (HTTPError, URLError, TimeoutError, OSError, RuntimeError) as exc:
            failures.append(f"{asset['name']}: {exc}")

    if failures:
        for failure in failures:
            print(f"[assets] ERROR {failure}", file=sys.stderr)
        if os.getenv("REQUIRE_SKY_ASSETS", "").lower() in {"1", "true", "yes"}:
            return 1
        print("[assets] Continuing without full Black Marble + DEM assets")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
