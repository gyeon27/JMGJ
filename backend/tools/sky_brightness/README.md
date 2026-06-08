# Sky Brightness Model Tools

This directory contains research and evaluation scripts for the Black Marble +
DEM sky-brightness model. Runtime code lives under:

```text
backend/src/app/services/sky_brightness_model/
  core/
    config.py
    data_loader.py
    calculator.py
  data/csv/
    ac_mag.csv
    ac_mag_moon.csv
    component_residuals.csv
```

The FastAPI endpoint imports the runtime model through the normal application
package:

```python
from app.services.sky_brightness_model.core.calculator import run_pipeline
```

The large Black Marble H5 and DEM raster files are not stored in Git. Configure
their paths through environment variables:

```env
BLACK_MARBLE_H5_PATH=/tmp/jmgj-assets/black_marble/black-marble.h5
DEM_RASTER_PATH=/tmp/jmgj-assets/dem/korea-dem.img
```

## Scripts

Run scripts from `backend/tools/sky_brightness/scripts`.

```powershell
python evaluator.py --params path\to\best_params.json
python optimizer.py --trials 100 --max-pixels 10000
python kfold_evaluator.py --trials 30 --group-by date
python component_residual_plots.py --y-mode radiance
python main.py --max-pixels 10000
```

Common defaults are defined in `scripts/cli_common.py`.

## Common Arguments

| Argument | Default | Meaning |
| --- | --- | --- |
| `--csv` | `backend/src/app/services/sky_brightness_model/data/csv/ac_mag.csv` | observation CSV |
| `--h5` | `BLACK_MARBLE_H5_PATH` | Black Marble H5 file |
| `--dem` | `DEM_RASTER_PATH` | DEM raster file |
| `--radius-km` | `30.0` | search radius around observer |
| `--keep-radiance-fraction` | `0.99` | retained cumulative radiance fraction |
| `--min-pixels` | `50` | minimum number of pixels |
| `--max-pixels` | `10000` | maximum number of pixels |

