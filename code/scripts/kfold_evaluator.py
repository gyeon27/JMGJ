import argparse
import json
import os
import re
import sys
from collections import Counter

import numpy as np
import optuna
import pandas as pd

CODE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(CODE_DIR)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from evaluator import evaluate, preload_cases
from cli_common import DEFAULT_CSV_PATH, add_data_args
from core.config import (
    ART_SCALE_RANGE,
    FIXED_GAMMA,
    FIXED_G,
    FIXED_OMEGA_A,
    FIXED_Q,
    FIXED_Q_DIRECT,
    FIXED_RHO_ALBEDO,
    MOON_TRANSMISSION_SCALE_RANGE,
    MS_A_RANGE,
    MS_B_RANGE,
)


DEFAULT_SOURCE = DEFAULT_CSV_PATH


def suggest_ms_params(trial: optuna.Trial) -> dict:
    return {
        "ms_a": trial.suggest_float("ms_a", *MS_A_RANGE),
        "ms_b": trial.suggest_float("ms_b", *MS_B_RANGE),
        "moon_transmission_scale": trial.suggest_float(
            "moon_transmission_scale", *MOON_TRANSMISSION_SCALE_RANGE
        ),
        "art_scale": trial.suggest_float("art_scale", *ART_SCALE_RANGE),
    }


def make_params(trial: optuna.Trial) -> dict:
    params = suggest_ms_params(trial)

    params["gamma"] = FIXED_GAMMA
    params["omega_a"] = FIXED_OMEGA_A
    params["g"] = FIXED_G
    params["Q"] = FIXED_Q
    params["q"] = FIXED_Q_DIRECT
    params["rho_albedo"] = FIXED_RHO_ALBEDO
    return params


def metrics_from_results(results: list[dict]) -> dict:
    diffs = np.array([r["diff"] for r in results if np.isfinite(r["diff"])], dtype=float)
    if len(diffs) == 0:
        return {"n": 0, "mse": np.nan, "rmse": np.nan, "bias": np.nan, "mae": np.nan}

    mse = float(np.mean(diffs**2))
    return {
        "n": int(len(diffs)),
        "mse": mse,
        "rmse": float(np.sqrt(mse)),
        "bias": float(np.mean(diffs)),
        "mae": float(np.mean(np.abs(diffs))),
    }


def print_metrics(label: str, metrics: dict) -> None:
    print(
        f"{label:<5} | n={metrics['n']:>3} | "
        f"MSE={metrics['mse']:.5f} | RMSE={metrics['rmse']:.5f} | "
        f"Bias={metrics['bias']:+.5f} | MAE={metrics['mae']:.5f}"
    )


def objective_for_cases(train_cases: list[dict]):
    def objective(trial: optuna.Trial) -> float:
        params = make_params(trial)
        results = evaluate(train_cases, params)
        metrics = metrics_from_results(results)
        return metrics["mse"] if np.isfinite(metrics["mse"]) else float("inf")

    return objective


def group_series(df: pd.DataFrame, group_by: str) -> pd.Series:
    times = pd.to_datetime(df["time"])
    if group_by == "date-hour":
        return times.dt.strftime("%Y-%m-%d_%H")
    return times.dt.date.astype(str)


def safe_name(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z_-]+", "_", value)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run leave-one-day-out validation with Optuna re-training per held-out date."
    )
    add_data_args(parser, csv_default=DEFAULT_SOURCE, csv_aliases=("--csv", "--source"))
    parser.add_argument("--trials", type=int, default=30)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--save-params", action="store_true")
    parser.add_argument(
        "--group-by",
        choices=("date", "date-hour"),
        default="date",
        help="Fold grouping key. date-hour separates observations from the same date by hour.",
    )
    args = parser.parse_args()

    df = pd.read_csv(args.csv)
    groups = group_series(df, args.group_by)
    csv_group_counts = Counter(groups)
    csv_groups = sorted(csv_group_counts)

    if len(csv_groups) < 2:
        raise ValueError("Leave-one-group-out requires at least two observation groups.")

    row_groups = {i + 1: group_value for i, group_value in enumerate(groups)}

    print()
    print("=" * 86)
    print(
        f"Preloading all rows once | rows: {len(df)} | "
        f"group-by: {args.group_by} | CSV groups: {len(csv_groups)}"
    )
    for group_value in csv_groups:
        print(f"  CSV {group_value}: {csv_group_counts[group_value]} rows")
    print("=" * 86)
    all_cases = preload_cases(
        args.csv,
        args.h5,
        args.dem,
        args.radius_km,
        args.keep_radiance_fraction,
        args.min_pixels,
        args.max_pixels,
    )
    for case in all_cases:
        case["fold_group"] = row_groups.get(case["row_no"])

    all_cases = [case for case in all_cases if case.get("fold_group")]
    loaded_group_counts = Counter(case["fold_group"] for case in all_cases)
    unique_groups = sorted(loaded_group_counts)

    if len(unique_groups) < 2:
        raise ValueError("Leave-one-group-out requires at least two loaded observation groups.")

    cases_by_group = {
        group_value: [case for case in all_cases if case["fold_group"] == group_value]
        for group_value in unique_groups
    }

    print()
    print("=" * 86)
    print(
        f"Loaded cases by group | rows: {len(all_cases)} | "
        f"group-by: {args.group_by} | folds: {len(unique_groups)}"
    )
    for group_value in unique_groups:
        print(f"  fold group {group_value}: {loaded_group_counts[group_value]} cases")
    print("=" * 86)

    fold_metrics = []

    for fold_no, heldout_group in enumerate(unique_groups, start=1):
        test_cases = cases_by_group[heldout_group]
        train_cases = [
            case
            for group_value in unique_groups
            if group_value != heldout_group
            for case in cases_by_group[group_value]
        ]

        print()
        print("=" * 86)
        print(
            f"Fold {fold_no}/{len(unique_groups)} | hold-out group: {heldout_group} | "
            f"train cases: {len(train_cases)} | test cases: {len(test_cases)}"
        )
        print("=" * 86)

        sampler = optuna.samplers.TPESampler(seed=args.seed)
        study = optuna.create_study(direction="minimize", sampler=sampler)
        study.optimize(objective_for_cases(train_cases), n_trials=args.trials, show_progress_bar=False)

        best_params = dict(study.best_params)
        best_params["gamma"] = FIXED_GAMMA
        best_params["omega_a"] = FIXED_OMEGA_A
        best_params["g"] = FIXED_G
        best_params["Q"] = FIXED_Q
        best_params["q"] = FIXED_Q_DIRECT
        best_params["rho_albedo"] = FIXED_RHO_ALBEDO

        if args.save_params:
            params_path = os.path.join(ROOT_DIR, "data", f"lodo_params_{safe_name(heldout_group)}.json")
            with open(params_path, "w", encoding="utf-8") as f:
                json.dump(best_params, f, ensure_ascii=False, indent=2)
            print(f"params saved: {params_path}")

        train_results = evaluate(train_cases, best_params)
        test_results = evaluate(test_cases, best_params)
        train_metrics = metrics_from_results(train_results)
        test_metrics = metrics_from_results(test_results)
        fold_metrics.append({"group": heldout_group, "train": train_metrics, "test": test_metrics})

        print(f"best train MSE from Optuna: {study.best_value:.5f}")
        print(f"best params: {best_params}")
        print_metrics("train", train_metrics)
        print_metrics("test", test_metrics)

    valid_tests = [m["test"] for m in fold_metrics if m["test"]["n"] > 0]
    mses = np.array([m["mse"] for m in valid_tests], dtype=float)
    rmses = np.array([m["rmse"] for m in valid_tests], dtype=float)
    biases = np.array([m["bias"] for m in valid_tests], dtype=float)
    maes = np.array([m["mae"] for m in valid_tests], dtype=float)

    print()
    print("=" * 86)
    print("Leave-one-group-out test summary")
    print("=" * 86)
    print(f"folds: {len(valid_tests)}")
    print(f"MSE : {np.mean(mses):.5f} ± {np.std(mses):.5f}")
    print(f"RMSE: {np.mean(rmses):.5f} ± {np.std(rmses):.5f}")
    print(f"Bias: {np.mean(biases):+.5f} ± {np.std(biases):.5f}")
    print(f"MAE : {np.mean(maes):.5f} ± {np.std(maes):.5f}")


if __name__ == "__main__":
    main()
