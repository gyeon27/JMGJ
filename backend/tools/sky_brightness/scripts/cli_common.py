import os


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TOOL_DIR = os.path.dirname(SCRIPT_DIR)
BACKEND_DIR = os.path.dirname(os.path.dirname(TOOL_DIR))
APP_DIR = os.path.join(BACKEND_DIR, "src", "app")
MODEL_DIR = os.path.join(APP_DIR, "services", "sky_brightness_model")

DEFAULT_CSV_DIR = os.path.join(MODEL_DIR, "data", "csv")
DEFAULT_CSV_PATH = os.path.join(DEFAULT_CSV_DIR, "ac_mag.csv")
DEFAULT_FALLBACK_CSV_PATH = os.path.join(DEFAULT_CSV_DIR, "ac_mag_moon.csv")
DEFAULT_PARAMS_PATH = os.path.join(MODEL_DIR, "data", "best_params.json")
DEFAULT_H5_PATH = os.getenv("BLACK_MARBLE_H5_PATH", "")
DEFAULT_DEM_PATH = os.getenv("DEM_RASTER_PATH", "")

DEFAULT_RADIUS_KM = 30.0
DEFAULT_KEEP_RADIANCE_FRACTION = 0.99
DEFAULT_MIN_PIXELS = 50
DEFAULT_MAX_PIXELS = 10000


def add_data_args(
    parser,
    *,
    csv_default=DEFAULT_CSV_PATH,
    csv_aliases=("--csv",),
    include_csv=True,
):
    if include_csv:
        parser.add_argument(*csv_aliases, dest="csv", default=csv_default)
    parser.add_argument("--h5", default=DEFAULT_H5_PATH)
    parser.add_argument("--dem", default=DEFAULT_DEM_PATH)
    parser.add_argument("--radius-km", type=float, default=DEFAULT_RADIUS_KM)
    parser.add_argument(
        "--keep-radiance-fraction",
        type=float,
        default=DEFAULT_KEEP_RADIANCE_FRACTION,
    )
    parser.add_argument("--min-pixels", type=int, default=DEFAULT_MIN_PIXELS)
    parser.add_argument("--max-pixels", type=int, default=DEFAULT_MAX_PIXELS)

