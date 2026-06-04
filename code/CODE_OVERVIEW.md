# JMGJ Code Overview

이 문서는 `code` 디렉토리의 파일 구조, 실행 순서, 공통 인자, 모델 파라미터 흐름을 정리한 것이다.

## Directory Structure

```text
code/
  core/
    config.py              # 물리 상수, 고정 파라미터, EnvironmentConfig
    data_loader.py         # 기상 API 캐시, 위성 H5/Black Marble 픽셀 로딩
    calculator.py          # 달빛, 인공광, 구름 반사, 배경광 복사휘도 계산
    __init__.py

  scripts/
    cli_common.py          # 모든 실행 파일의 공통 경로/CLI 인자
    main.py                # 한 지점/한 방향 대화식 예측
    optimizer.py           # 전체 CSV로 Optuna 최종 파라미터 튜닝
    evaluator.py           # 저장된 파라미터로 예측 성능 평가
    kfold_evaluator.py     # 날짜 또는 날짜-시간 단위 leave-one-group-out 검증
    component_residual_plots.py # 성분별 잔차 그래프 생성
    split_eval_data.py     # CSV를 train/eval로 나누는 보조 스크립트

  data/
    best_params.json       # optimizer가 저장한 최적 파라미터
    component_residual_plots.png
    csv/
      ac_mag.csv             # 기본 관측 데이터
      ac_mag_moon.csv        # 달빛 조건 관측 데이터
      component_residuals.csv # residual plot용 표 출력
    APIs/                  # Meteoblue API 캐시 JSON
```

## Common Arguments

아래 인자는 `scripts/cli_common.py`에서 관리한다. `optimizer.py`, `evaluator.py`, `kfold_evaluator.py`, `component_residual_plots.py`가 같은 기본값을 사용한다. `main.py`는 대화식 단일 예측이라 `--csv`만 제외하고 같은 H5/DEM/픽셀 옵션을 사용한다.

| Argument | Default | Meaning |
| --- | --- | --- |
| `--csv` | `code/data/csv/ac_mag.csv` | 관측 CSV |
| `--h5` | `광공해/VNP46A3...h5` | Black Marble 위성 H5 |
| `--dem` | `한반도/한반도90m_GRS80.img` | 지형 DEM |
| `--radius-km` | `30.0` | 관측점 주변 광원 검색 반경 |
| `--keep-radiance-fraction` | `0.99` | 밝은 픽셀 누적 보존 비율 |
| `--min-pixels` | `50` | 최소 픽셀 수 |
| `--max-pixels` | `10000` | 최대 픽셀 수 |

`kfold_evaluator.py`와 `split_eval_data.py`는 기존 호환을 위해 `--source`도 `--csv`와 같은 의미로 받는다.

## Main Workflow

Before running a script that may request Meteoblue data, create `.env` from `.env.example`.

```text
METEOBLUE_API_KEY=your_real_key
```

`.env` is ignored by git. Do not commit real API keys.

### 1. Final parameter fitting

```powershell
python "C:\Users\yun09\Desktop\제곽\2026\1.연구\2.전람회\전람회\전람회\code\scripts\optimizer.py" --trials 100 --max-pixels 10000
```

역할:
- `ac_mag.csv`를 모두 읽는다.
- API/위성/DEM 데이터를 미리 로딩한다.
- Optuna로 `ms_a`, `ms_b`, `moon_transmission_scale`, `art_scale`를 튜닝한다.
- 결과를 `data/best_params.json`에 저장한다.

고정 파라미터:
- `gamma = 0.65`
- `omega_a = 0.85`
- `g = 0.9`
- `Q = 0.2`
- `q = 0.5`
- `rho_albedo = 0.5`

### 2. Evaluation

```powershell
python "C:\Users\yun09\Desktop\제곽\2026\1.연구\2.전람회\전람회\전람회\code\scripts\evaluator.py" --params "C:\Users\yun09\Desktop\제곽\2026\1.연구\2.전람회\전람회\전람회\code\data\best_params.json"
```

역할:
- 저장된 파라미터를 사용해서 관측 CSV 전체를 다시 계산한다.
- Pred, Actual, Diff, MoonSep, C, Ce, Hmax, q를 출력한다.
- 전체 MSE/RMSE/Bias/MAE와 시간대별 bias를 출력한다.

### 3. Date-based validation

```powershell
python "C:\Users\yun09\Desktop\제곽\2026\1.연구\2.전람회\전람회\전람회\code\scripts\kfold_evaluator.py" --trials 30 --group-by date
```

역할:
- 날짜 또는 날짜-시간 단위로 한 그룹을 빼고 학습한다.
- 빠진 그룹을 test로 평가한다.
- 날짜별 일반화 성능과 과적합 위험을 본다.

옵션:
- `--group-by date`: 날짜별 fold
- `--group-by date-hour`: 같은 날짜도 시간대별로 분리
- `--save-params`: fold별 최적 파라미터 JSON 저장

### 4. Residual component plots

```powershell
python "C:\Users\yun09\Desktop\제곽\2026\1.연구\2.전람회\전람회\전람회\code\scripts\component_residual_plots.py" --y-mode radiance
```

역할:
- `I_ml`, `I_cloud`, `I_art`, `cloud_effect_fraction`와 잔차의 관계를 그린다.
- 기본 y축은 `I_actual - I_pred`이다.
- 결과:
  - `data/component_residual_plots.png`
  - `data/csv/component_residuals.csv`

해석:
- y가 음수면 모델이 실제보다 밝게 예측한 것이다.
- 특정 성분과 잔차 상관이 크면 그 성분이 보정 후보이다.

### 5. One-point interactive prediction

```powershell
python "C:\Users\yun09\Desktop\제곽\2026\1.연구\2.전람회\전람회\전람회\code\scripts\main.py" --max-pixels 10000
```

역할:
- 관측자 좌표, 관측 천정각/방위각, 시간을 직접 입력한다.
- 한 방향의 예측 등급을 출력한다.

## Core Model Flow

1. `data_loader.environment_query()`
   - Meteoblue API 캐시에서 AOD, cloud fraction, cloud base height, seeing, moon position을 가져온다.
   - API moonlight 값은 물리 모델 입력으로 쓰지 않는다.

2. `data_loader.load_pixel_data_from_h5()`
   - Black Marble H5의 `AllAngle_Composite_Snow_Free` 값을 읽는다.
   - 단위는 `nW/(cm^2 sr)`이다.
   - 코드 내부에서 `1e-5`를 곱해 `W/(m^2 sr)`로 변환한다.
   - 품질값이 있으면 `Good(0)`과 `Gap filled(2)`만 사용한다.

3. `calculator.prepare_pixel_geometry()`
   - 관측점 주변 픽셀을 거리/방위/지형 차폐 정보와 함께 전처리한다.
   - 밝기 누적 비율과 최대 픽셀 수로 계산량을 제한한다.

4. `calculator.run_pipeline()`
   - 달빛 산란 `I_ml`
   - 배경광 `I_bg`
   - 도시/인공광 산란 `I_art`
   - 구름 1차 반사 `I_cloud`
   - 다중산란 계수 `k`
   를 합산해 최종 복사휘도 `W/(m^2 sr)`를 반환한다.

5. magnitude conversion
   - 최종 복사휘도를 광도계 기준으로 변환한 뒤 등급으로 환산한다.
   - 현재 식:

```text
mag = 12.59 - 2.5 log10(radiance * 683)
```

## Current Calibration Strategy

현재는 파라미터를 너무 많이 튜닝하지 않는 쪽이 안정적이다.

튜닝 대상:
- `ms_a`
- `ms_b`
- `moon_transmission_scale`
- `art_scale`

고정 대상:
- `gamma`
- `omega_a`
- `g`
- `Q`
- `q`
- `rho_albedo`

이유:
- 데이터 수가 아직 작고 날짜별 조건 차이가 크다.
- 너무 많은 파라미터를 열면 날짜별 과적합이 커진다.
- 현재 가장 큰 구조적 문제는 고휘도 `I_art` 구간의 과대평가이다.

## Recommended Check Order

1. `optimizer.py`로 `best_params.json` 생성
2. `evaluator.py`로 전체 MSE/Bias와 시간대별 bias 확인
3. `component_residual_plots.py`로 성분별 잔차 패턴 확인
4. `kfold_evaluator.py`로 날짜별 일반화 확인
5. 큰 outlier는 관측 조건, 달, 구름, 광원 방향을 따로 확인

## Notes

- `I_actual - I_pred < 0`: 모델이 실제보다 밝게 예측했다.
- `I_actual - I_pred > 0`: 모델이 실제보다 어둡게 예측했다.
- `cloud_effect_fraction`은 현재 `C^2` 기반이다.
- 구름이 없거나 운저고도가 계산 상한보다 높으면 구름 효과는 0으로 둔다.
- 달 모델은 API moonlight 대신 위상각과 달 위치 기반 산란 모델을 사용한다.
