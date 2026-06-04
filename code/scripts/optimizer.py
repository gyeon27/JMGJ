import json
import os
import argparse
import sys
import optuna
import numpy as np
import pandas as pd
import rasterio

CODE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if CODE_DIR not in sys.path:
    sys.path.insert(0, CODE_DIR)

from core.config import (
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
from core.data_loader import environment_query, load_pixel_data_from_h5
from core.calculator import run_pipeline, calculate_directional_shielding, prepare_pixel_geometry
from cli_common import (
    DEFAULT_CSV_PATH,
    DEFAULT_DEM_PATH,
    DEFAULT_H5_PATH,
    DEFAULT_PARAMS_PATH,
    add_data_args,
)

# ==============================================================
# 파일 경로 설정 (본인 PC 경로에 맞게 맞춰주세요!)
# ==============================================================
CSV_FILE_PATH = DEFAULT_CSV_PATH
H5_FILE_PATH = DEFAULT_H5_PATH
DEM_IMG_PATH = DEFAULT_DEM_PATH
BEST_PARAMS_PATH = DEFAULT_PARAMS_PATH

# RAM에 상주할 글로벌 변수
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
    print("🚀 [초고속 모드] 데이터 메모리 사전 로딩(Pre-loading)을 시작합니다.")
    print("="*60)
    
    # 1. 지형 데이터(DEM) 1회 로딩
    print("1️⃣ 무거운 지형 데이터(DEM)를 RAM에 올리는 중...")
    try:
        with rasterio.open(DEM_IMG_PATH) as src:
            PRELOADED_DEM_DATA = (src.read(1), src.transform)
        print("  -> ✅ 지형 데이터 메모리 적재 완료!")
    except Exception as e:
        print(f"  -> ❌ 지형 데이터 로딩 실패: {e}")
        return False

    # 2. CSV 파일 로딩
    print("\n2️⃣ 관측 데이터(CSV)를 읽어 기상/위성 데이터를 캐싱합니다...")
    try:
        df = pd.read_csv(ACTIVE_CSV_FILE_PATH)
        print(f"  -> 사용 CSV: {ACTIVE_CSV_FILE_PATH}")
    except Exception as e:
        print(f"  -> ❌ CSV 파일 읽기 실패: {e}")
        return False

    env_cache = {}
    pixel_cache = {}
    moon_shield_cache = {}

    # CSV 데이터 한 줄씩 읽어서 메모리에 결합
    for i, row in df.iterrows():
        try:
            # CSV 컬럼 이름이 다르다면 이 부분을 수정하세요.
            lat = float(row['lat'])
            lon = float(row['lon'])
            zen = float(row['zen'])
            az = float(row['az'])
            time_str = str(row['time'])
            actual_mag = float(row['actual_mag'])
            if not np.isfinite([lat, lon, zen, az, actual_mag]).all():
                print(f"  -> ⚠️ [{i+1}/{len(df)}] 유효하지 않은 숫자 데이터 제외")
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
            
            # [핵심] 여기서 위성 데이터를 미리 1번만 뽑아서 보관해둡니다. (반경 30km 추천)
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
                
            # 💡 [핵심 추가] 옵투나 루프 진입 전에 미리 산 차폐각을 한 번만 계산합니다!
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
                "moon_shield_deg": moon_shield_deg  # 💡 메모리에 차폐각 영구 저장
            })
            print(f"  -> ✅ [{i+1}/{len(df)}] 지역 데이터 로딩 완료!")
        except Exception as e:
            print(f"  -> ❌ [{i+1}/{len(df)}] 데이터 로딩 에러: {e}")

    print(f"\n🎉 총 {len(PRELOADED_BATCH)}개의 유효한 데이터가 메모리에 준비되었습니다!")
    print(f"   env cache: {len(env_cache)}, pixel cache: {len(pixel_cache)}, moon shield cache: {len(moon_shield_cache)}")
    return True


def objective(trial):
    ms_params = suggest_ms_params(trial)
    
    # 🎯 밝기 분석을 위한 리스트 추가
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
            # 🎯 예측 밝기와 실제 밝기 저장
            preds.append(pred_mag)
            actuals.append(data["actual_mag"])
            
        except Exception:
            return float('inf') 
            
    # 🎯 평균 치우침(Bias) 및 샘플 문자열 생성
    if not preds:
        return float('inf')

    errors = np.array(preds) - np.array(actuals)
    mean_bias = np.mean(errors)
    mse = np.mean(errors**2)
    rmse = np.sqrt(mse)
    if trial.number % 10 == 0:
        print(f"Trial {trial.number:03d} | MSE: {mse:.4f} | RMSE: {rmse:.4f} | "
              f"Bias(예측-실측): {mean_bias:+.3f}")
          
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
        print("최적화를 진행할 수 없습니다. 데이터 로딩을 확인하세요.")
        exit()

    print("\n🤖 본격적인 병렬 최적화 엔진을 가동합니다...")
    
    study = optuna.create_study(direction="minimize")
    study.optimize(objective, n_trials=args.trials)
    
    # ==============================================================
    # 🎯 [추가] 최적화 완료 후 상세 밝기 비교 표 출력 리포트
    # ==============================================================
    print("\n" + "="*70)
    print("🏆 OPTUNA 최적화 완료! BEST 파라미터 기준 전체 데이터 리포트")
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

    print(f"▶ Best MSE Value: {study.best_value:.5f}")
    print(f"▶ 찾은 최적 파라미터: {best_params}\n")
    print(f"▶ evaluator용 파라미터 저장: {BEST_PARAMS_PATH}\n")
    
    print(f"{'No':<5} | {'예측 등급 (Pred)':<15} | {'실측 등급 (Actual)':<15} | {'오차 (Diff)':<12} | {'조건':<6}")
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
                print(f"{i+1:<5} | 계산 에러 데이터 제외")
                continue

            pred = 12.59 - 2.5 * np.log10(rad * 683)
            if not np.isfinite(pred):
                print(f"{i+1:<5} | 계산 에러 데이터 제외")
                continue

            diff = pred - data["actual_mag"]
            final_diffs.append(diff)
            
            print(f"{i+1:<5} | {pred:<15.4f} | {data['actual_mag']:<15.4f} | {diff:<+12.4f} | C={data['cloud_fraction']:.2f}")
        except Exception:
            print(f"{i+1:<5} | 계산 에러 데이터 제외")
            
    print("-" * 82)
    if not final_diffs:
        print("유효한 최종 계산 결과가 없습니다.")
        exit()

    total_bias = np.mean(final_diffs)
    final_mse = np.mean(np.array(final_diffs) ** 2)
    final_rmse = np.sqrt(final_mse)
    print(f"👉 최종 MSE: {final_mse:.5f}")
    print(f"👉 최종 RMSE: {final_rmse:.5f}")
    print(f"👉 최종 평균 치우침 (Mean Bias): {total_bias:+.4f}")
    print("\n💡 [영점 보정 참고]")
    print(f"   오차가 모든 관측점에서 같은 방향으로 쏠리면 등급 환산 영점 상수를 따로 보정할 수 있습니다.")
    print(f"   현재 데이터 기준 보정 후보: 12.59 - ({total_bias:+.4f}) = {12.59 - total_bias:.2f}")
    print(f"   단, 이 값은 검증용 별도 데이터셋으로 다시 확인해야 합니다.")
    print("="*70)
