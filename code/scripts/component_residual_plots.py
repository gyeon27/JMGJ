import argparse
import os
import sys

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CODE_DIR = os.path.dirname(SCRIPT_DIR)
if CODE_DIR not in sys.path:
    sys.path.insert(0, CODE_DIR)

from core.calculator import run_pipeline
from evaluator import (
    CSV_FILE_PATH,
    DEM_IMG_PATH,
    H5_FILE_PATH,
    build_config,
    load_params,
    preload_cases,
)
from cli_common import DEFAULT_CSV_DIR, DEFAULT_PARAMS_PATH, add_data_args


def radiance_from_mag(mag: float) -> float:
    return float(10.0 ** ((12.59 - mag) / 2.5) / 683.0)


def build_component_table(cases: list[dict], params: dict, y_mode: str) -> pd.DataFrame:
    rows = []

    for case in cases:
        config = build_config(case, params)
        components = run_pipeline(
            observer_coordinates=case["observer_coordinates"],
            observer_angles=case["observer_angles"],
            moon_angles=case["moon_angles"],
            pixel_data=case["pixel_data"],
            dem_data=case["dem_data"],
            config=config,
            precalc_moon_shield=case["moon_shield_deg"],
            max_radius_km=case.get("radius_km", 30.0),
            return_components=True,
        )

        pred_radiance = float(components["total"])
        if pred_radiance <= 0 or not np.isfinite(pred_radiance):
            continue

        actual_mag = float(case["actual_mag"])
        pred_mag = 12.59 - 2.5 * np.log10(pred_radiance * 683.0)
        actual_radiance = radiance_from_mag(actual_mag)

        if y_mode == "mag":
            residual = actual_mag - pred_mag
        else:
            residual = actual_radiance - pred_radiance

        rows.append(
            {
                "row_no": case["row_no"],
                "time": case.get("time", ""),
                "actual_mag": actual_mag,
                "pred_mag": pred_mag,
                "actual_radiance": actual_radiance,
                "pred_radiance": pred_radiance,
                "residual": residual,
                "I_ml": float(components["I_ml_final"]),
                "I_cloud": float(components["I_cloud_final"]),
                "I_art": float(components["I_art_final"]),
                "I_bg": float(components["I_bg_final"]),
                "cloud_fraction": float(config.cloud_fraction),
                "cloud_effect_fraction": float(
                    getattr(config, "cloud_effect_fraction", config.cloud_fraction)
                ),
            }
        )

    return pd.DataFrame(rows)


def plot_component_residuals(df: pd.DataFrame, output_path: str, y_mode: str) -> None:
    components = [
        ("I_ml", "Moonlight component", "log"),
        ("I_cloud", "Cloud-reflection component", "log"),
        ("I_art", "Artificial-light component", "log"),
        ("cloud_effect_fraction", "Effective cloud fraction", "linear"),
    ]
    y_label = "I_actual - I_pred" if y_mode == "radiance" else "Actual mag - Pred mag"

    fig, axes = plt.subplots(1, 4, figsize=(19, 4.8), constrained_layout=True)
    for ax, (column, title, x_scale) in zip(axes, components):
        x = df[column].to_numpy(dtype=float)
        y = df["residual"].to_numpy(dtype=float)
        valid = np.isfinite(x) & np.isfinite(y)

        plot_x = np.maximum(x[valid], 1e-30) if x_scale == "log" else x[valid]
        ax.scatter(plot_x, y[valid], s=28, alpha=0.75)
        ax.axhline(0.0, color="black", linewidth=1.0, alpha=0.7)
        if x_scale == "log":
            ax.set_xscale("log")
        else:
            ax.set_xlim(-0.03, 1.03)
        ax.set_xlabel(column)
        ax.set_ylabel(y_label)
        ax.set_title(title)
        ax.grid(True, which="both", alpha=0.25)

        if np.sum(valid) >= 2:
            corr_x = np.log10(np.maximum(x[valid], 1e-30)) if x_scale == "log" else x[valid]
            corr_label = "r(log x,y)" if x_scale == "log" else "r(x,y)"
            if np.nanstd(corr_x) == 0.0 or np.nanstd(y[valid]) == 0.0:
                corr_text = f"{corr_label} = n/a"
            else:
                corr = np.corrcoef(corr_x, y[valid])[0, 1]
                corr_text = f"{corr_label} = {corr:+.3f}"
            ax.text(
                0.04,
                0.94,
                corr_text,
                transform=ax.transAxes,
                va="top",
                fontsize=9,
            )

    fig.suptitle("Residual vs Model Components", fontsize=13)
    fig.savefig(output_path, dpi=180)
    plt.close(fig)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Plot I_ml, I_cloud, and I_art against residual I_actual - I_pred."
    )
    parser.add_argument("--params", default=DEFAULT_PARAMS_PATH)
    add_data_args(parser, csv_default=CSV_FILE_PATH)
    parser.add_argument("--y-mode", choices=("radiance", "mag"), default="radiance")
    parser.add_argument(
        "--output",
        default=os.path.join(CODE_DIR, "data", "component_residual_plots.png"),
    )
    parser.add_argument(
        "--table-output",
        default=os.path.join(DEFAULT_CSV_DIR, "component_residuals.csv"),
    )
    args = parser.parse_args()

    params = load_params(args.params) if args.params and os.path.exists(args.params) else {}
    cases = preload_cases(
        args.csv,
        args.h5,
        args.dem,
        args.radius_km,
        args.keep_radiance_fraction,
        args.min_pixels,
        args.max_pixels,
    )

    df = build_component_table(cases, params, args.y_mode)
    if df.empty:
        raise RuntimeError("No valid rows to plot.")

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    df.to_csv(args.table_output, index=False, encoding="utf-8-sig")
    plot_component_residuals(df, args.output, args.y_mode)

    print(f"rows: {len(df)}")
    print(f"plot saved: {args.output}")
    print(f"table saved: {args.table_output}")


if __name__ == "__main__":
    main()
