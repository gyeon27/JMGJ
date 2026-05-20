import optuna
import numpy as np
import pandas as pd
import rasterio
from config import EnvironmentConfig
from data_loader import environment_query, load_pixel_data_from_h5
from calculator import run_pipeline, calculate_directional_shielding

# config.py 보존을 위한 클래스 상속
class OptimizedConfig(EnvironmentConfig):
    ms_a: float = 3.0
    ms_b: float = 1.2

    @property
    def k_multi_scatter(self) -> float:
        return self.ms_a + self.ms_b * self.aod

# ==============================================================
# 파일 경로 설정 (본인 PC 경로에 맞게 맞춰주세요!)
# ==============================================================
CSV_FILE_PATH = r"C:\Users\yun09\Desktop\제곽\2026\1.연구\2.전람회\전람회\전람회\\code\\actual_magnitude.csv" # 확보하신 관측 데이터 CSV 경로
H5_FILE_PATH = r"C:\Users\yun09\Desktop\제곽\2026\1.연구\2.전람회\전람회\전람회\광공해\VNP46A3.A2026001.h30v05.002.2026041165901.h5"
DEM_IMG_PATH = r"C:\Users\yun09\Desktop\제곽\2026\1.연구\2.전람회\전람회\전람회\한반도\한반도90m_GRS80.img"

# RAM에 상주할 글로벌 변수
PRELOADED_BATCH = []
PRELOADED_DEM_DATA = None

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
        df = pd.read_csv(CSV_FILE_PATH)
    except Exception as e:
        print(f"  -> ❌ CSV 파일 읽기 실패: {e}")
        return False

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

            aod, cloud_fraction, cloud_base_h, seeing, moonlight, moon_angle = environment_query(
                time_str, *observer_coordinates
            )
            aod = float(np.clip(aod, 0.0, 5.0))
            cloud_fraction = float(np.clip(cloud_fraction, 0.0, 1.0))
            cloud_base_h = float(np.clip(cloud_base_h, 0.1, 30.0))
            moonlight = float(max(0.0, moonlight))
            
            # [핵심] 여기서 위성 데이터를 미리 1번만 뽑아서 보관해둡니다. (반경 30km 추천)
            pixel_data = load_pixel_data_from_h5(H5_FILE_PATH, observer_coordinates, max_radius_km=30.0)
            if not pixel_data:
                continue
                
            # 💡 [핵심 추가] 옵투나 루프 진입 전에 미리 산 차폐각을 한 번만 계산합니다!
            moon_shield_deg = 0.0
            if PRELOADED_DEM_DATA is not None:
                dem_arr, dem_trans = PRELOADED_DEM_DATA
                moon_shield_deg = calculate_directional_shielding(
                    observer_coordinates, moon_angle[1], dem_arr, dem_trans, max_dist_km=30.0
                )
                
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
                "moon_shield_deg": moon_shield_deg  # 💡 메모리에 차폐각 영구 저장
            })
            print(f"  -> ✅ [{i+1}/{len(df)}] 지역 데이터 로딩 완료!")
        except Exception as e:
            print(f"  -> ❌ [{i+1}/{len(df)}] 데이터 로딩 에러: {e}")

    print(f"\n🎉 총 {len(PRELOADED_BATCH)}개의 유효한 데이터가 메모리에 준비되었습니다!")
    return True


def objective(trial):
    opt_gamma = trial.suggest_float("gamma", 0.01, 0.5)
    opt_omega_a = trial.suggest_float("omega_a", 0.7, 0.99)
    opt_g = trial.suggest_float("g", 0.1, 0.9)
    opt_Q = 0.21
    opt_q = 0.43
    opt_ms_a = trial.suggest_float("ms_a", 1.0, 5.0)
    opt_ms_b = trial.suggest_float("ms_b", 0.1, 3.0)
    
    total_squared_error = 0.0
    
    # 🎯 밝기 분석을 위한 리스트 추가
    preds = []
    actuals = []
    
    for data in PRELOADED_BATCH:
        opt_config = OptimizedConfig(
            gamma=opt_gamma, omega_a=opt_omega_a, g=opt_g, Q=opt_Q, q=opt_q,
            ms_a=opt_ms_a, ms_b=opt_ms_b,
            aod=data["aod"],
            cloud_fraction=data["cloud_fraction"],
            cloud_base_h=data["cloud_base_h"],
            seeing=data["seeing"],
            moonlight=data["moonlight"]
        )
        
        try:
            pred_total_radiance = run_pipeline(
                observer_coordinates=data["observer_coordinates"],
                observer_angles=data["observer_angles"],
                moon_angles=data["moon_angles"],
                pixel_data=data["pixel_data"],
                config=opt_config,
                dem_data=PRELOADED_DEM_DATA,
                precalc_moon_shield=data["moon_shield_deg"]
            )
            if pred_total_radiance <= 0 or not np.isfinite(pred_total_radiance):
                return float('inf')
            
            pred_mag = 12.59 - 2.5 * np.log10(pred_total_radiance * 683)
            if not np.isfinite(pred_mag):
                return float('inf')
            total_squared_error += (pred_mag - data["actual_mag"]) ** 2
            
            # 🎯 예측 밝기와 실제 밝기 저장
            preds.append(pred_mag)
            actuals.append(data["actual_mag"])
            
        except Exception:
            return float('inf') 
            
    # 🎯 평균 치우침(Bias) 및 샘플 문자열 생성
    if not preds:
        return float('inf')

    mean_bias = np.mean(np.array(preds) - np.array(actuals))
    samples_str = ", ".join([f"{p:.2f}/{a:.2f}" for p, a in zip(preds, actuals)])
    
    # 기존 print문을 아래와 같이 확장
    print(f"Trial {trial.number:03d} | MSE: {total_squared_error / len(PRELOADED_BATCH):.4f} | "
          f"Bias(예측-실측): {mean_bias:+.3f} | 샘플(예측/실측): [{samples_str}...]")
          
    return total_squared_error / len(PRELOADED_BATCH)

if __name__ == "__main__":
    success = preload_all_data()
    
    if not success or not PRELOADED_BATCH:
        print("최적화를 진행할 수 없습니다. 데이터 로딩을 확인하세요.")
        exit()

    print("\n🤖 본격적인 병렬 최적화 엔진을 가동합니다...")
    
    study = optuna.create_study(direction="minimize")
    study.optimize(objective, n_trials=100)
    
    # ==============================================================
    # 🎯 [추가] 최적화 완료 후 상세 밝기 비교 표 출력 리포트
    # ==============================================================
    print("\n" + "="*70)
    print("🏆 OPTUNA 최적화 완료! BEST 파라미터 기준 전체 데이터 리포트")
    print("="*70)
    best_params = study.best_params
    print(f"▶ Best MSE Value: {study.best_value:.5f}")
    print(f"▶ 찾은 최적 파라미터: {best_params}\n")
    
    print(f"{'No':<5} | {'예측 등급 (Pred)':<15} | {'실측 등급 (Actual)':<15} | {'오차 (Diff)':<12}")
    print("-" * 70)
    
    final_diffs = []
    for i, data in enumerate(PRELOADED_BATCH):
        try:
            best_config = OptimizedConfig(
                gamma=best_params.get("gamma", 0.2),
                omega_a=best_params.get("omega_a", 0.95),
                g=best_params.get("g", 0.55),
                Q=best_params.get("Q", 0.21),
                q=best_params.get("q", 0.43),
                ms_a=best_params.get("ms_a", 3.0),
                ms_b=best_params.get("ms_b", 1.2),
                aod=data["aod"],
                cloud_fraction=data["cloud_fraction"],
                cloud_base_h=data["cloud_base_h"],
                seeing=data["seeing"],
                moonlight=data["moonlight"]
            )

            rad = run_pipeline(
                observer_coordinates=data["observer_coordinates"],
                observer_angles=data["observer_angles"],
                moon_angles=data["moon_angles"],
                pixel_data=data["pixel_data"],
                config=best_config,
                dem_data=PRELOADED_DEM_DATA,
                precalc_moon_shield=data["moon_shield_deg"]
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
            
            print(f"{i+1:<5} | {pred:<15.4f} | {data['actual_mag']:<15.4f} | {diff:<+12.4f}")
        except Exception:
            print(f"{i+1:<5} | 계산 에러 데이터 제외")
            
    print("-" * 70)
    if not final_diffs:
        print("유효한 최종 계산 결과가 없습니다.")
        exit()

    total_bias = np.mean(final_diffs)
    print(f"👉 최종 평균 치우침 (Mean Bias): {total_bias:+.4f}")
    print("\n💡 [영점 보정 참고]")
    print(f"   오차가 모든 관측점에서 같은 방향으로 쏠리면 등급 환산 영점 상수를 따로 보정할 수 있습니다.")
    print(f"   현재 데이터 기준 보정 후보: 12.59 - ({total_bias:+.4f}) = {12.59 - total_bias:.2f}")
    print(f"   단, 이 값은 검증용 별도 데이터셋으로 다시 확인해야 합니다.")
    print("="*70)
