import json
import os
import argparse
import sys
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT_DIR)))
SRC_DIR = os.path.join(BACKEND_DIR, "src")
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)
import optuna
import numpy as np
import pandas as pd
import rasterio

CODE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if CODE_DIR not in sys.path:
    sys.path.insert(0, CODE_DIR)

from app.services.sky_brightness_model.core.config import (
    ART_SCALE_RANGE,
    EnvironmentConfig,
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
from app.services.sky_brightness_model.core.data_loader import environment_query, load_pixel_data_from_h5
from app.services.sky_brightness_model.core.calculator import run_pipeline, calculate_directional_shielding, prepare_pixel_geometry
from cli_common import (
    DEFAULT_CSV_PATH,
    DEFAULT_DEM_PATH,
    DEFAULT_H5_PATH,
    DEFAULT_PARAMS_PATH,
    add_data_args,
)

# ==============================================================
# ?뚯씪 寃쎈줈 ?ㅼ젙 (蹂몄씤 PC 寃쎈줈??留욊쾶 留욎떠二쇱꽭??)
# ==============================================================
CSV_FILE_PATH = DEFAULT_CSV_PATH
H5_FILE_PATH = DEFAULT_H5_PATH
DEM_IMG_PATH = DEFAULT_DEM_PATH
BEST_PARAMS_PATH = DEFAULT_PARAMS_PATH

# RAM???곸＜??湲濡쒕쾶 蹂??
PRELOADED_BATCH = []
PRELOADED_DEM_DATA = None
ACTIVE_CSV_FILE_PATH = CSV_FILE_PATH
MAX_RADIUS_KM = 30.0
KEEP_RADIANCE_FRACTION = 0.99
MIN_PIXELS = 50
MAX_PIXELS = 200

def suggest_ms_params(trial):
    return {
        "ms_a": trial.suggest_float("ms_a", *MS_A_RANGE),
        "ms_b": trial.suggest_float("ms_b", *MS_B_RANGE),
        "moon_transmission_scale": trial.suggest_float(
            "moon_transmission_scale", *MOON_TRANSMISSION_SCALE_RANGE
        ),
        "art_scale": trial.suggest_float("art_scale", *ART_SCALE_RANGE),
    }

def preload_all_data():
    global PRELOADED_DEM_DATA
    PRELOADED_BATCH.clear()
    print("\n" + "="*60)
    print("?? [珥덇퀬??紐⑤뱶] ?곗씠??硫붾え由??ъ쟾 濡쒕뵫(Pre-loading)???쒖옉?⑸땲??")
    print("="*60)
    
    # 1. 吏???곗씠??DEM) 1??濡쒕뵫
    print("1截뤴깵 臾닿굅??吏???곗씠??DEM)瑜?RAM???щ━??以?..")
    try:
        with rasterio.open(DEM_IMG_PATH) as src:
            PRELOADED_DEM_DATA = (src.read(1), src.transform)
        print("  -> ??吏???곗씠??硫붾え由??곸옱 ?꾨즺!")
    except Exception as e:
        print(f"  -> ??吏???곗씠??濡쒕뵫 ?ㅽ뙣: {e}")
        return False

    # 2. CSV ?뚯씪 濡쒕뵫
    print("\n2截뤴깵 愿痢??곗씠??CSV)瑜??쎌뼱 湲곗긽/?꾩꽦 ?곗씠?곕? 罹먯떛?⑸땲??..")
    try:
        df = pd.read_csv(ACTIVE_CSV_FILE_PATH)
        print(f"  -> ?ъ슜 CSV: {ACTIVE_CSV_FILE_PATH}")
    except Exception as e:
        print(f"  -> ??CSV ?뚯씪 ?쎄린 ?ㅽ뙣: {e}")
        return False

    env_cache = {}
    pixel_cache = {}
    moon_shield_cache = {}

    # CSV ?곗씠????以꾩뵫 ?쎌뼱??硫붾え由ъ뿉 寃고빀
    for i, row in df.iterrows():
        try:
            # CSV 而щ읆 ?대쫫???ㅻⅤ?ㅻ㈃ ??遺遺꾩쓣 ?섏젙?섏꽭??
            lat = float(row['lat'])
            lon = float(row['lon'])
            zen = float(row['zen'])
            az = float(row['az'])
            time_str = str(row['time'])
            actual_mag = float(row['actual_mag'])
            if not np.isfinite([lat, lon, zen, az, actual_mag]).all():
                print(f"  -> ?좑툘 [{i+1}/{len(df)}] ?좏슚?섏? ?딆? ?レ옄 ?곗씠???쒖쇅")
                continue

            observer_coordinates = (lat, lon)
            observer_angles = (zen, az)

            env_key = (time_str, round(lat, 4), round(lon, 4))
            if env_key not in env_cache:
                env_cache[env_key] = environment_query(time_str, *observer_coordinates)

            aod, cloud_fraction, cloud_base_h, seeing, moonlight, moon_angle, moon_phase_angle, moon_cloud_transmission = env_cache[env_key]
            aod = float(np.clip(aod, 0.0, 5.0))
            cloud_fraction = float(np.clip(cloud_fraction, 0.0, 1.0))
            cloud_base_h = float(np.clip(cloud_base_h, 0.1, 30.0))
            moonlight = float(max(0.0, moonlight))
            
            # [?듭떖] ?ш린???꾩꽦 ?곗씠?곕? 誘몃━ 1踰덈쭔 戮묒븘??蹂닿??대몼?덈떎. (諛섍꼍 30km 異붿쿇)
            pixel_key = (round(lat, 4), round(lon, 4), MAX_RADIUS_KM)
            if pixel_key not in pixel_cache:
                raw_pixel_data = load_pixel_data_from_h5(
                    H5_FILE_PATH, observer_coordinates, max_radius_km=MAX_RADIUS_KM
                )
                pixel_cache[pixel_key] = prepare_pixel_geometry(
                    raw_pixel_data,
                    observer_coordinates,
                    max_radius_km=MAX_RADIUS_KM,
                    dem_data=PRELOADED_DEM_DATA,
                    keep_radiance_fraction=KEEP_RADIANCE_FRACTION,
                    min_pixels=MIN_PIXELS,
                    max_pixels=MAX_PIXELS,
                )

            pixel_data = pixel_cache[pixel_key]
            if not pixel_data:
                continue
                
            # ?뮕 [?듭떖 異붽?] ?듯닾??猷⑦봽 吏꾩엯 ?꾩뿉 誘몃━ ??李⑦룓媛곸쓣 ??踰덈쭔 怨꾩궛?⑸땲??
            moon_shield_deg = 0.0
            if PRELOADED_DEM_DATA is not None:
                shield_key = (round(lat, 4), round(lon, 4), round(float(moon_angle[1]), 2))
                if shield_key not in moon_shield_cache:
                    dem_arr, dem_trans = PRELOADED_DEM_DATA
                    moon_shield_cache[shield_key] = calculate_directional_shielding(
                        observer_coordinates, moon_angle[1], dem_arr, dem_trans, max_dist_km=30.0
                    )

                moon_shield_deg = moon_shield_cache[shield_key]
                
            PRELOADED_BATCH.append({
                "actual_mag": actual_mag,
                "observer_coordinates": observer_coordinates,
                "observer_angles": observer_angles,  
                "moon_angles": moon_angle,
                "pixel_data": pixel_data,
                "aod": aod,
                "cloud_fraction": cloud_fraction,
                "cloud_base_h": cloud_base_h,
                "seeing": seeing,
                "moonlight": moonlight,
                "moon_phase_angle": moon_phase_angle,
                "moon_cloud_transmission": moon_cloud_transmission,
                "radius_km": MAX_RADIUS_KM,
                "moon_shield_deg": moon_shield_deg  # ?뮕 硫붾え由ъ뿉 李⑦룓媛??곴뎄 ???
            })
            print(f"  -> ??[{i+1}/{len(df)}] 吏???곗씠??濡쒕뵫 ?꾨즺!")
        except Exception as e:
            print(f"  -> ??[{i+1}/{len(df)}] ?곗씠??濡쒕뵫 ?먮윭: {e}")

    print(f"\n?럦 珥?{len(PRELOADED_BATCH)}媛쒖쓽 ?좏슚???곗씠?곌? 硫붾え由ъ뿉 以鍮꾨릺?덉뒿?덈떎!")
    print(f"   env cache: {len(env_cache)}, pixel cache: {len(pixel_cache)}, moon shield cache: {len(moon_shield_cache)}")
    return True


def objective(trial):
    ms_params = suggest_ms_params(trial)
    
    # ?렞 諛앷린 遺꾩꽍???꾪븳 由ъ뒪??異붽?
    preds = []
    actuals = []
    
    for data in PRELOADED_BATCH:
        opt_config = EnvironmentConfig(
            gamma=FIXED_GAMMA,
            omega_a=FIXED_OMEGA_A,
            g=FIXED_G,
            Q=FIXED_Q,
            q=FIXED_Q_DIRECT,
            ms_a=ms_params["ms_a"],
            ms_b=ms_params["ms_b"],
            aod=data["aod"],
            cloud_fraction=data["cloud_fraction"],
            cloud_base_h=data["cloud_base_h"],
            seeing=data["seeing"],
            moonlight=data["moonlight"],
            moon_phase_angle_deg=data["moon_phase_angle"],
            moon_cloud_transmission=data["moon_cloud_transmission"],
            moon_transmission_scale=ms_params["moon_transmission_scale"],
            art_scale=ms_params["art_scale"],
        )
        
        try:
            pred_total_radiance = run_pipeline(
                observer_coordinates=data["observer_coordinates"],
                observer_angles=data["observer_angles"],
                moon_angles=data["moon_angles"],
                pixel_data=data["pixel_data"],
                config=opt_config,
                dem_data=PRELOADED_DEM_DATA,
                precalc_moon_shield=data["moon_shield_deg"],
                max_radius_km=data["radius_km"],
            )
            if pred_total_radiance <= 0 or not np.isfinite(pred_total_radiance):
                return float('inf')
            
            pred_mag = 12.59 - 2.5 * np.log10(pred_total_radiance * 683)
            if not np.isfinite(pred_mag):
                return float('inf')
            # ?렞 ?덉륫 諛앷린? ?ㅼ젣 諛앷린 ???
            preds.append(pred_mag)
            actuals.append(data["actual_mag"])
            
        except Exception:
            return float('inf') 
            
    # ?렞 ?됯퇏 移섏슦移?Bias) 諛??섑뵆 臾몄옄???앹꽦
    if not preds:
        return float('inf')

    errors = np.array(preds) - np.array(actuals)
    mean_bias = np.mean(errors)
    mse = np.mean(errors**2)
    rmse = np.sqrt(mse)
    if trial.number % 10 == 0:
        print(f"Trial {trial.number:03d} | MSE: {mse:.4f} | RMSE: {rmse:.4f} | "
              f"Bias(?덉륫-?ㅼ륫): {mean_bias:+.3f}")
          
    return mse

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Optimize final model parameters using the full observation CSV."
    )
    add_data_args(parser, csv_default=CSV_FILE_PATH)
    parser.add_argument("--trials", type=int, default=100, help="Optuna trial count.")
    args = parser.parse_args()

    ACTIVE_CSV_FILE_PATH = args.csv
    H5_FILE_PATH = args.h5
    DEM_IMG_PATH = args.dem
    MAX_RADIUS_KM = args.radius_km
    KEEP_RADIANCE_FRACTION = args.keep_radiance_fraction
    MIN_PIXELS = args.min_pixels
    MAX_PIXELS = args.max_pixels

    success = preload_all_data()
    
    if not success or not PRELOADED_BATCH:
        print("理쒖쟻?붾? 吏꾪뻾?????놁뒿?덈떎. ?곗씠??濡쒕뵫???뺤씤?섏꽭??")
        exit()

    print("\n?쨼 蹂멸꺽?곸씤 蹂묐젹 理쒖쟻???붿쭊??媛?숉빀?덈떎...")
    
    study = optuna.create_study(direction="minimize")
    study.optimize(objective, n_trials=args.trials)
    
    # ==============================================================
    # ?렞 [異붽?] 理쒖쟻???꾨즺 ???곸꽭 諛앷린 鍮꾧탳 ??異쒕젰 由ы룷??
    # ==============================================================
    print("\n" + "="*70)
    print("OPTUNA optimization complete. Full-data report with best parameters.")
    print("="*70)
    best_params = study.best_params
    best_params.update({
        "gamma": FIXED_GAMMA,
        "omega_a": FIXED_OMEGA_A,
        "g": FIXED_G,
        "Q": FIXED_Q,
        "q": FIXED_Q_DIRECT,
        "rho_albedo": FIXED_RHO_ALBEDO,
    })
    with open(BEST_PARAMS_PATH, "w", encoding="utf-8") as f:
        json.dump(best_params, f, ensure_ascii=False, indent=2)

    print(f"??Best MSE Value: {study.best_value:.5f}")
    print(f"??李얠? 理쒖쟻 ?뚮씪誘명꽣: {best_params}\n")
    print(f"??evaluator???뚮씪誘명꽣 ??? {BEST_PARAMS_PATH}\n")
    
    print(f"{'No':<5} | {'?덉륫 ?깃툒 (Pred)':<15} | {'?ㅼ륫 ?깃툒 (Actual)':<15} | {'?ㅼ감 (Diff)':<12} | {'議곌굔':<6}")
    print("-" * 82)
    
    final_diffs = []
    for i, data in enumerate(PRELOADED_BATCH):
        try:
            best_config = EnvironmentConfig(
                gamma=FIXED_GAMMA,
                omega_a=FIXED_OMEGA_A,
                g=FIXED_G,
                Q=FIXED_Q,
                q=FIXED_Q_DIRECT,
                ms_a=best_params["ms_a"],
                ms_b=best_params["ms_b"],
                aod=data["aod"],
                cloud_fraction=data["cloud_fraction"],
                cloud_base_h=data["cloud_base_h"],
                seeing=data["seeing"],
                moonlight=data["moonlight"],
                moon_phase_angle_deg=data["moon_phase_angle"],
                moon_cloud_transmission=data["moon_cloud_transmission"],
                moon_transmission_scale=best_params["moon_transmission_scale"],
                art_scale=best_params["art_scale"],
            )

            rad = run_pipeline(
                observer_coordinates=data["observer_coordinates"],
                observer_angles=data["observer_angles"],
                moon_angles=data["moon_angles"],
                pixel_data=data["pixel_data"],
                config=best_config,
                dem_data=PRELOADED_DEM_DATA,
                precalc_moon_shield=data["moon_shield_deg"],
                max_radius_km=data["radius_km"],
            )
            if rad <= 0 or not np.isfinite(rad):
                print(f"{i+1:<5} | 怨꾩궛 ?먮윭 ?곗씠???쒖쇅")
                continue

            pred = 12.59 - 2.5 * np.log10(rad * 683)
            if not np.isfinite(pred):
                print(f"{i+1:<5} | 怨꾩궛 ?먮윭 ?곗씠???쒖쇅")
                continue

            diff = pred - data["actual_mag"]
            final_diffs.append(diff)
            
            print(f"{i+1:<5} | {pred:<15.4f} | {data['actual_mag']:<15.4f} | {diff:<+12.4f} | C={data['cloud_fraction']:.2f}")
        except Exception:
            print(f"{i+1:<5} | 怨꾩궛 ?먮윭 ?곗씠???쒖쇅")
            
    print("-" * 82)
    if not final_diffs:
        print("?좏슚??理쒖쥌 怨꾩궛 寃곌낵媛 ?놁뒿?덈떎.")
        exit()

    total_bias = np.mean(final_diffs)
    final_mse = np.mean(np.array(final_diffs) ** 2)
    final_rmse = np.sqrt(final_mse)
    print(f"?몛 理쒖쥌 MSE: {final_mse:.5f}")
    print(f"?몛 理쒖쥌 RMSE: {final_rmse:.5f}")
    print(f"?몛 理쒖쥌 ?됯퇏 移섏슦移?(Mean Bias): {total_bias:+.4f}")
    print("\n?뮕 [?곸젏 蹂댁젙 李멸퀬]")
    print(f"   ?ㅼ감媛 紐⑤뱺 愿痢≪젏?먯꽌 媛숈? 諛⑺뼢?쇰줈 ?좊━硫??깃툒 ?섏궛 ?곸젏 ?곸닔瑜??곕줈 蹂댁젙?????덉뒿?덈떎.")
    print(f"   ?꾩옱 ?곗씠??湲곗? 蹂댁젙 ?꾨낫: 12.59 - ({total_bias:+.4f}) = {12.59 - total_bias:.2f}")
    print(f"   ?? ??媛믪? 寃利앹슜 蹂꾨룄 ?곗씠?곗뀑?쇰줈 ?ㅼ떆 ?뺤씤?댁빞 ?⑸땲??")
    print("="*70)

