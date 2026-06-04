import argparse
import os

import pandas as pd


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CODE_DIR = os.path.dirname(SCRIPT_DIR)
from cli_common import DEFAULT_CSV_DIR, DEFAULT_CSV_PATH

DEFAULT_SOURCE = DEFAULT_CSV_PATH
DEFAULT_TRAIN = os.path.join(DEFAULT_CSV_DIR, "ac_mag_train.csv")
DEFAULT_EVAL = os.path.join(DEFAULT_CSV_DIR, "ac_mag_eval.csv")


def split_stratified(df: pd.DataFrame, eval_every: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    train_parts = []
    eval_parts = []

    for _, group in df.groupby(["time", "zen"], sort=False):
        group = group.reset_index(drop=True)
        eval_mask = ((group.index + 1) % eval_every) == 0
        eval_parts.append(group[eval_mask])
        train_parts.append(group[~eval_mask])

    train_df = pd.concat(train_parts, ignore_index=True)
    eval_df = pd.concat(eval_parts, ignore_index=True)
    return train_df, eval_df


def main() -> None:
    parser = argparse.ArgumentParser(description="Split ac_mag.csv into train/eval CSV files.")
    parser.add_argument("--csv", "--source", dest="csv", default=DEFAULT_SOURCE)
    parser.add_argument("--train", default=DEFAULT_TRAIN)
    parser.add_argument("--eval", default=DEFAULT_EVAL)
    parser.add_argument(
        "--eval-every",
        type=int,
        default=4,
        help="Put every Nth row within each time group into eval set.",
    )
    args = parser.parse_args()

    if args.eval_every < 2:
        raise ValueError("--eval-every must be at least 2.")

    df = pd.read_csv(args.csv)
    required = {"time", "lat", "lon", "zen", "az", "actual_mag"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Missing columns: {sorted(missing)}")

    train_df, eval_df = split_stratified(df, args.eval_every)

    train_df.to_csv(args.train, index=False, encoding="utf-8")
    eval_df.to_csv(args.eval, index=False, encoding="utf-8")

    print(f"source: {args.csv} ({len(df)} rows)")
    print(f"train : {args.train} ({len(train_df)} rows)")
    print(f"eval  : {args.eval} ({len(eval_df)} rows)")


if __name__ == "__main__":
    main()
