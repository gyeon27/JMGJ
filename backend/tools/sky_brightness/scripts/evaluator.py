import argparse
import json
import os
import sys
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT_DIR)))
SRC_DIR = os.path.join(BACKEND_DIR, "src")
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

import numpy as np
import pandas as pd
import rasterio

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CODE_DIR = os.path.dirname(SCRIPT_DIR)
if CODE_DIR not in sys.path:
    sys.path.insert(0, CODE_DIR)

from app.services.sky_brightness_model.core.calculator import calculate_directional_shielding, prepare_pixel_geometry, run_pipeline
from app.services.sky_brightness_model.core.config import (
    DEFAULT_ART_SCALE,
    EnvironmentConfig,
    FIXED_GAMMA,
    FIXED_G,
    FIXED_OMEGA_A,
    FIXED_Q,
    FIXED_Q_DIRECT,
    FIXED_RHO_ALBEDO,
    DEFAULT_MOON_TRANSMISSION_SCALE,
)
from app.services.sky_brightness_model.core.data_loader import environment_query, load_pixel_data_from_h5
from cli_common import (
    DEFAULT_CSV_PATH,
    DEFAULT_DEM_PATH,
    DEFAULT_FALLBACK_CSV_PATH,
    DEFAULT_H5_PATH,
    add_data_args,
)

CSV_FILE_PATH = DEFAULT_CSV_PATH
H5_FILE_PATH = DEFAULT_H5_PATH
DEM_IMG_PATH = DEFAULT_DEM_PATH


def magnitude_from_radiance(radiance: float) -> float:
    if radiance <= 0 or not np.isfinite(radiance):
        return np.nan
    return 12.59 - 2.5 * np.log10(radiance * 683)


def angular_separation_deg(angle_a: tuple[float, float], angle_b: tuple[float, float]) -> float:
    z1, az1 = np.radians(angle_a)
    z2, az2 = np.radians(angle_b)
    cos_sep = np.cos(z1) * np.cos(z2) + np.sin(z1) * np.sin(z2) * np.cos(az1 - az2)
    return float(np.degrees(np.arccos(np.clip(cos_sep, -1.0, 1.0))))


def load_params(path: str | None) -> dict:
    if not path:
        return {}

    with open(path, "r", encoding="utf-8") as f:
        params = json.load(f)

    if not isinstance(params, dict):
        raise ValueError("Parameter file must contain a JSON object.")

    return params


def build_config(row_data: dict, params: dict) -> EnvironmentConfig:
    blended = {
        "gamma": params.get("gamma", FIXED_GAMMA),
        "omega_a": params.get("omega_a", FIXED_OMEGA_A),
        "g": params.get("g", FIXED_G),
        "ms_a": params.get("ms_a"),
        "ms_b": params.get("ms_b"),
    }

    return EnvironmentConfig(
        aod=row_data["aod"],
        cloud_fraction=row_data["cloud_fraction"],
        cloud_base_h=row_data["cloud_base_h"],
        seeing=row_data["seeing"],
        moonlight=row_data["moonlight"],
        moon_phase_angle_deg=row_data.get("moon_phase_angle", 180.0),
        moon_cloud_transmission=row_data.get("moon_cloud_transmission", 1.0),
        moon_transmission_scale=params.get(
            "moon_transmission_scale", DEFAULT_MOON_TRANSMISSION_SCALE
        ),
        art_scale=params.get("art_scale", DEFAULT_ART_SCALE),
        gamma=blended["gamma"],
        omega_a=blended["omega_a"],
        g=blended["g"],
        Q=params.get("Q", FIXED_Q),
        q=params.get("q", FIXED_Q_DIRECT),
        ms_a=blended["ms_a"],
        ms_b=blended["ms_b"],
        rho_albedo=params.get("rho_albedo", FIXED_RHO_ALBEDO),
    )


def preload_cases(
    csv_path: str,
    h5_path: str,
    dem_path: str,
    radius_km: float,
    keep_radiance_fraction: float = 0.99,
    min_pixels: int = 50,
    max_pixels: int = 200,
) -> list[dict]:
    cases = []
    df = pd.read_csv(csv_path)

    with rasterio.open(dem_path) as src:
        dem_data = (src.read(1), src.transform)

    for i, row in df.iterrows():
        try:
            lat = float(row["lat"])
            lon = float(row["lon"])
            zen = float(row["zen"])
            az = float(row["az"])
            actual_mag = float(row["actual_mag"])
            time_str = str(row["time"])

            if not np.isfinite([lat, lon, zen, az, actual_mag]).all():
                print(f"[skip] row {i + 1}: invalid numeric value")
                continue

            observer_coordinates = (lat, lon)
            observer_angles = (zen, az)

            aod, cloud_fraction, cloud_base_h, seeing, moonlight, moon_angles, moon_phase_angle, moon_cloud_transmission = environment_query(
                time_str, lat, lon
            )

            pixel_data = load_pixel_data_from_h5(
                h5_path, observer_coordinates, max_radius_km=radius_km
            )
            pixel_data = prepare_pixel_geometry(
                pixel_data,
                observer_coordinates,
                max_radius_km=radius_km,
                dem_data=dem_data,
                keep_radiance_fraction=keep_radiance_fraction,
                min_pixels=min_pixels,
                max_pixels=max_pixels,
            )
            if not pixel_data:
                print(f"[skip] row {i + 1}: no satellite pixels")
                continue

            moon_shield_deg = calculate_directional_shielding(
                observer_coordinates,
                moon_angles[1],
                dem_data[0],
                dem_data[1],
                max_dist_km=30.0,
            )

            cases.append(
                {
                    "row_no": i + 1,
                    "time": time_str,
                    "actual_mag": actual_mag,
                    "observer_coordinates": observer_coordinates,
                    "observer_angles": observer_angles,
                    "moon_angles": moon_angles,
                    "pixel_data": pixel_data,
                    "dem_data": dem_data,
                    "moon_shield_deg": moon_shield_deg,
                    "aod": aod,
                    "cloud_fraction": cloud_fraction,
                    "cloud_base_h": cloud_base_h,
                    "seeing": seeing,
                    "moonlight": moonlight,
                    "moon_phase_angle": moon_phase_angle,
                    "moon_cloud_transmission": moon_cloud_transmission,
                    "radius_km": radius_km,
                }
            )
            print(f"[load] row {i + 1}: ready")
        except Exception as exc:
            print(f"[skip] row {i + 1}: {exc}")

    return cases


def evaluate(cases: list[dict], params: dict) -> list[dict]:
    results = []

    for case in cases:
        config = build_config(case, params)
        radiance = run_pipeline(
            observer_coordinates=case["observer_coordinates"],
            observer_angles=case["observer_angles"],
            moon_angles=case["moon_angles"],
            pixel_data=case["pixel_data"],
            dem_data=case["dem_data"],
            config=config,
            precalc_moon_shield=case["moon_shield_deg"],
            max_radius_km=case.get("radius_km", 30.0),
        )
        pred_mag = magnitude_from_radiance(radiance)
        diff = pred_mag - case["actual_mag"]

        results.append(
            {
                "row_no": case["row_no"],
                "time": case.get("time", ""),
                "pred_mag": pred_mag,
                "actual_mag": case["actual_mag"],
                "diff": diff,
                "radiance": radiance,
                "moon_sep_deg": angular_separation_deg(case["observer_angles"], case["moon_angles"]),
                "moon_phase_angle": case.get("moon_phase_angle", np.nan),
                "moon_cloud_transmission": case.get("moon_cloud_transmission", np.nan),
                "cloud_fraction": config.cloud_fraction,
                "cloud_effect_fraction": getattr(config, "cloud_effect_fraction", config.cloud_fraction),
                "cloud_base_h": config.cloud_base_h,
                "H_max": config.H_max,
                "Q": config.Q,
                "q": config.q,
                "rho_albedo": config.rho_albedo,
            }
        )

    return results


def print_report(results: list[dict]) -> None:
    valid = [r for r in results if np.isfinite(r["diff"])]
    if not valid:
        print("No valid evaluation results.")
        return

    diffs = np.array([r["diff"] for r in valid], dtype=float)
    mse = float(np.mean(diffs**2))
    rmse = float(np.sqrt(mse))
    bias = float(np.mean(diffs))
    mae = float(np.mean(np.abs(diffs)))

    print()
    print(f"{'No':<5} | {'Time':<16} | {'Pred':>9} | {'Actual':>9} | {'Diff':>9} | {'MoonSep':>7} | {'C':>5} | {'Ce':>5} | {'Hmax':>6} | {'q':>5}")
    print("-" * 106)
    for r in valid:
        print(
            f"{r['row_no']:<5} | "
            f"{str(r.get('time', '')):<16} | "
            f"{r['pred_mag']:>9.4f} | "
            f"{r['actual_mag']:>9.4f} | "
            f"{r['diff']:>+9.4f} | "
            f"{r['moon_sep_deg']:>7.2f} | "
            f"{r['cloud_fraction']:>5.2f} | "
            f"{r['cloud_effect_fraction']:>5.2f} | "
            f"{r['H_max']:>6.2f} | "
            f"{r['q']:>5.2f}"
        )
    print("-" * 106)
    print(f"MSE : {mse:.5f}")
    print(f"RMSE: {rmse:.5f}")
    print(f"Bias: {bias:+.5f}")
    print(f"MAE : {mae:.5f}")
    print(f"Check: bias^2 <= MSE -> {bias * bias:.5f} <= {mse:.5f}")

    grouped = {}
    for r in valid:
        time_key = str(r.get("time", ""))[:13]
        grouped.setdefault(time_key, []).append(r["diff"])

    if grouped:
        print()
        print("Time-group bias:")
        for time_key in sorted(grouped):
            group_diffs = np.array(grouped[time_key], dtype=float)
            group_mse = float(np.mean(group_diffs**2))
            print(
                f"{time_key:<13} | n={len(group_diffs):>3} | "
                f"MSE={group_mse:.5f} | Bias={np.mean(group_diffs):+.5f} | "
                f"MAE={np.mean(np.abs(group_diffs)):.5f}"
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate light pollution model predictions.")
    parser.add_argument("--params", help="JSON file containing model parameters.", default=None)
    parser.add_argument("--fallback-csv", default=DEFAULT_FALLBACK_CSV_PATH)
    add_data_args(parser)
    args = parser.parse_args()

    params = load_params(args.params)
    print(f"Parameters: {params if params else 'EnvironmentConfig defaults'}")

    csv_path = args.csv if os.path.exists(args.csv) else args.fallback_csv
    if csv_path != args.csv:
        print(f"Evaluation CSV not found; fallback: {csv_path}")

    cases = preload_cases(
        csv_path,
        args.h5,
        args.dem,
        args.radius_km,
        args.keep_radiance_fraction,
        args.min_pixels,
        args.max_pixels,
    )
    results = evaluate(cases, params)
    print_report(results)


if __name__ == "__main__":
    main()

