import os


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CODE_DIR = os.path.dirname(SCRIPT_DIR)
PROJECT_DIR = os.path.dirname(CODE_DIR)

DEFAULT_CSV_DIR = os.path.join(CODE_DIR, "data", "csv")
DEFAULT_CSV_PATH = os.path.join(DEFAULT_CSV_DIR, "ac_mag.csv")
DEFAULT_FALLBACK_CSV_PATH = os.path.join(DEFAULT_CSV_DIR, "ac_mag_moon.csv")
DEFAULT_PARAMS_PATH = os.path.join(CODE_DIR, "data", "best_params.json")
DEFAULT_H5_PATH = os.path.join(
    PROJECT_DIR,
    "광공해",
    "VNP46A3.A2026001.h30v05.002.2026041165901.h5",
)
DEFAULT_DEM_PATH = os.path.join(PROJECT_DIR, "한반도", "한반도90m_GRS80.img")

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
