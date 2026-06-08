# Render Black Marble + DEM assets

The Black Marble H5 and DEM raster are large runtime assets. Do not commit them
to Git. Upload them as GitHub Release assets, then let the backend download them
to a Render persistent disk when the service starts.

## GitHub Release assets

Create a release in `gyeon27/JMGJ`, for example:

- Tag: `data-assets-2026-06`
- Asset: `black-marble.h5`
- Asset: `korea-dem.img`

The URLs should look like:

```text
https://github.com/gyeon27/JMGJ/releases/download/data-assets-2026-06/black-marble.h5
https://github.com/gyeon27/JMGJ/releases/download/data-assets-2026-06/korea-dem.img
```

## Render disk

Attach a persistent disk to the backend service.

Recommended mount path:

```text
/var/data
```

## Render environment variables

```env
BLACK_MARBLE_H5_PATH=/var/data/black_marble/black-marble.h5
DEM_RASTER_PATH=/var/data/dem/korea-dem.img
BLACK_MARBLE_H5_URL=https://github.com/gyeon27/JMGJ/releases/download/data-assets-2026-06/black-marble.h5
DEM_RASTER_URL=https://github.com/gyeon27/JMGJ/releases/download/data-assets-2026-06/korea-dem.img
BLACK_MARBLE_H5_MIN_BYTES=100000000
DEM_RASTER_MIN_BYTES=100000000
REQUIRE_SKY_ASSETS=false
```

Set `REQUIRE_SKY_ASSETS=true` only if the backend must fail when either asset is
missing. Keeping it `false` lets the sky-brightness endpoint fall back to
Meteoblue/Bortle while the assets are unavailable.

## Render commands

Build command:

```bash
pip install -r requirements.txt
```

Start command:

```bash
python scripts/download_assets.py && uvicorn main:app --host 0.0.0.0 --port $PORT
```

Use `backend/src/app` as the Render root directory for these commands.

