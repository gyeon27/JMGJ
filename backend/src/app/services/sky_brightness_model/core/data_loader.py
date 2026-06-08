import numpy as np
import requests
import json
import os
from datetime import datetime, timedelta
from pathlib import Path

try:
    import h5py
except ImportError:
    h5py = None

try:
    from .config import BLACK_MARBLE_RADIANCE_UNIT
except ImportError:
    from config import BLACK_MARBLE_RADIANCE_UNIT

MODEL_DIR = Path(__file__).resolve().parents[1]
APP_DIR = Path(__file__).resolve().parents[3]
BACKEND_DIR = APP_DIR.parents[1]
REPO_ROOT = BACKEND_DIR.parent
CODE_DIR = str(MODEL_DIR)
PROJECT_DIR = str(REPO_ROOT)
DATA_DIR = os.path.join(CODE_DIR, "data")
API_DIR = os.path.join(DATA_DIR, "APIs")
CLOUD_BASE_FALLBACK_KM = 2.0
ASTRO_TIME_SHIFT_HOURS = -9
API_HISTORY_DAYS = 4
ENV_FILE_CANDIDATES = (
    str(APP_DIR / ".env"),
    str(BACKEND_DIR / ".env"),
    os.path.join(PROJECT_DIR, ".env"),
    os.path.join(CODE_DIR, ".env"),
)

BLACK_MARBLE_RADIANCE_SDS = "AllAngle_Composite_Snow_Free"
BLACK_MARBLE_QUALITY_SDS = "AllAngle_Composite_Snow_Free_Quality"
BLACK_MARBLE_ALLOWED_QUALITY = {0, 2}  # 0=good, 2=gap filled. Exclude 1=poor, 255=fill.


def load_env_file_if_present() -> None:
    for env_path in ENV_FILE_CANDIDATES:
        if not os.path.exists(env_path):
            continue

        with open(env_path, "r", encoding="utf-8") as f:
            for raw_line in f:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue

                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value


def get_meteoblue_api_key() -> str:
    load_env_file_if_present()
    api_key = os.environ.get("METEOBLUE_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "METEOBLUE_API_KEY is missing. Create a .env file from .env.example "
            "and set your Meteoblue API key."
        )
    return api_key

def pressure_to_cloud_base_height_km(pressure_hpa, cloud_fraction: float) -> float:
    """Convert cloud-base pressure to km.

    If cloud cover is significant but cloud-base pressure is missing/bad,
    use a conservative low-cloud fallback instead of 30 km. A 30 km value
    later makes the model treat the sky as cloud-free.
    """
    if cloud_fraction <= 0.1:
        return 30.0

    try:
        pressure_hpa = float(pressure_hpa)
    except (TypeError, ValueError):
        return CLOUD_BASE_FALLBACK_KM

    if not np.isfinite(pressure_hpa) or pressure_hpa <= 0.0:
        return CLOUD_BASE_FALLBACK_KM

    height_km = 44.33 * (1 - (pressure_hpa / 1013.25)**(1 / 5.255))
    if not np.isfinite(height_km):
        return CLOUD_BASE_FALLBACK_KM

    if height_km > 30.0:
        return 30.0

    return float(np.clip(height_km, 0.1, 30.0))

def parse_api_time(value: str) -> datetime:
    return datetime.strptime(value, "%Y-%m-%d %H:%M")

def shift_astro_time(target_time: str) -> str:
    """Meteoblue planet_positions 배열은 UTC 인덱스에 맞춰 읽습니다."""
    shifted = parse_api_time(target_time) + timedelta(hours=ASTRO_TIME_SHIFT_HOURS)
    return shifted.strftime("%Y-%m-%d %H:%M")

def find_time_interp(time_list, target_time: str):
    if not time_list:
        return None

    target = parse_api_time(target_time)
    parsed = [parse_api_time(t) for t in time_list]

    if target < parsed[0]:
        return None
    if target == parsed[0]:
        return 0, 0, 0.0
    if target > parsed[-1]:
        return None
    if target == parsed[-1]:
        last = len(parsed) - 1
        return last, last, 0.0

    for i in range(len(parsed) - 1):
        t0, t1 = parsed[i], parsed[i + 1]
        if t0 <= target <= t1:
            if target == t0:
                return i, i, 0.0
            if target == t1:
                return i + 1, i + 1, 0.0

            fraction = (target - t0).total_seconds() / (t1 - t0).total_seconds()
            return i, i + 1, float(fraction)

    return None

def interp_value(values, idx0, idx1, fraction, default=0.0):
    try:
        v0 = float(values[idx0])
        v1 = float(values[idx1])
    except (TypeError, ValueError, IndexError):
        return default

    if not np.isfinite(v0):
        v0 = default
    if not np.isfinite(v1):
        v1 = default

    return (1.0 - fraction) * v0 + fraction * v1

def interp_angle_deg(values, idx0, idx1, fraction, default=0.0):
    try:
        a0 = float(values[idx0])
        a1 = float(values[idx1])
    except (TypeError, ValueError, IndexError):
        return default

    if not np.isfinite(a0) or not np.isfinite(a1):
        return default

    diff = (a1 - a0 + 180.0) % 360.0 - 180.0
    return (a0 + fraction * diff) % 360.0

def julian_day(dt: datetime) -> float:
    """Julian day for a UTC datetime."""
    year = dt.year
    month = dt.month
    day = dt.day + (dt.hour + (dt.minute + dt.second / 60.0) / 60.0) / 24.0
    if month <= 2:
        year -= 1
        month += 12
    a = year // 100
    b = 2 - a + a // 4
    return int(365.25 * (year + 4716)) + int(30.6001 * (month + 1)) + day + b - 1524.5

def angle_diff_deg(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)

def calculate_lunar_phase_angle_deg(local_time: str) -> float:
    """Approximate lunar phase angle in degrees.

    KS91 uses alpha=0 at full moon and alpha=180 at new moon. This low-order
    Sun/Moon longitude approximation is sufficient for sky-brightness scaling.
    """
    utc_dt = parse_api_time(local_time) + timedelta(hours=ASTRO_TIME_SHIFT_HOURS)
    n = julian_day(utc_dt) - 2451545.0

    sun_l = (280.460 + 0.9856474 * n) % 360.0
    sun_g = np.radians((357.528 + 0.9856003 * n) % 360.0)
    sun_lambda = (sun_l + 1.915 * np.sin(sun_g) + 0.020 * np.sin(2.0 * sun_g)) % 360.0

    moon_l = (218.316 + 13.176396 * n) % 360.0
    moon_m = np.radians((134.963 + 13.064993 * n) % 360.0)
    moon_lambda = (moon_l + 6.289 * np.sin(moon_m)) % 360.0

    elongation = angle_diff_deg(moon_lambda, sun_lambda)
    return float(np.clip(180.0 - elongation, 0.0, 180.0))

def get_interp_indices(block, target_time: str):
    time_list = block.get("time", [])
    return find_time_interp(time_list, target_time)

def cache_missing_reason(cached_data: dict, target_time: str) -> str | None:
    data_1h = cached_data.get('p1', {}).get('data_1h', {})
    if get_interp_indices(data_1h, target_time) is None:
        return f"p1/data_1h에 요청 시간 {target_time} 없음"

    astro_time = shift_astro_time(target_time)
    if data_1h and get_interp_indices(data_1h, astro_time) is None:
        return f"p1/data_1h에 달 위치용 시간 {astro_time} 없음"

    return None

def cache_supports_time(cached_data: dict, target_time: str) -> bool:
    return cache_missing_reason(cached_data, target_time) is None

def _subset_value_by_indices(value, time_count: int, indices: list[int]):
    if isinstance(value, dict):
        return {
            key: _subset_value_by_indices(item, time_count, indices)
            for key, item in value.items()
        }

    if isinstance(value, list):
        if len(value) == time_count:
            return [value[i] for i in indices]

        if value and all(isinstance(item, list) and len(item) == time_count for item in value):
            return [[item[i] for i in indices] for item in value]

    return value

def subset_time_block_by_date(block: dict, date_str: str) -> dict:
    time_list = block.get("time", [])
    if not time_list:
        return block

    indices = [i for i, item_time in enumerate(time_list) if str(item_time).startswith(date_str)]
    if not indices:
        return block

    return _subset_value_by_indices(block, len(time_list), indices)

def subset_cache_by_date(cached_data: dict, date_str: str) -> dict:
    result = {}
    for package_key, package_data in cached_data.items():
        if not isinstance(package_data, dict):
            result[package_key] = package_data
            continue

        package_subset = {}
        for key, value in package_data.items():
            if isinstance(value, dict) and "time" in value:
                package_subset[key] = subset_time_block_by_date(value, date_str)
            else:
                package_subset[key] = value
        result[package_key] = package_subset

    return result

def save_daily_cache_if_possible(cached_data: dict, daily_cache_filename: str, target_time: str) -> dict:
    date_str = parse_api_time(target_time).strftime("%Y-%m-%d")
    daily_data = subset_cache_by_date(cached_data, date_str)
    if cache_supports_time(daily_data, target_time):
        with open(daily_cache_filename, 'w', encoding='utf-8') as f:
            json.dump(daily_data, f, ensure_ascii=False, indent=2)
        return daily_data
    return cached_data

def load_pixel_data_from_h5(filepath: str, obs_coord: tuple, max_radius_km: float = 30.0) -> list:
    """
    .h5 파일에서 관측자 주변(max_radius_km)의 위도, 경도, Black Marble 광량 데이터를 반환합니다.

    VNP46A3/A4 composite radiance is stored in nW/(cm^2 sr). The calculator
    converts it to W/(m^2 sr) using BLACK_MARBLE_RADIANCE_TO_SI.
    """
    pixel_data = []
    obs_lat, obs_lon = obs_coord

    if h5py is None:
        print("loading data failed: h5py is not installed.")
        return []
    
    try:
        with h5py.File(filepath, 'r') as f:
            base_path = 'HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields/'

            radiance_sds = f[base_path + BLACK_MARBLE_RADIANCE_SDS]
            radiance_data = radiance_sds[:].astype(np.float64)
            scale_factor = float(np.asarray(radiance_sds.attrs.get("scale_factor", 1.0)).squeeze())
            offset = float(np.asarray(radiance_sds.attrs.get("offset", 0.0)).squeeze())
            fill_value = float(np.asarray(radiance_sds.attrs.get("_FillValue", -999.9)).squeeze())
            radiance_data = radiance_data * scale_factor + offset

            quality_data = None
            quality_path = base_path + BLACK_MARBLE_QUALITY_SDS
            if quality_path in f:
                quality_data = f[quality_path][:]

            lat_raw = f[base_path + 'lat'][:]
            lon_raw = f[base_path + 'lon'][:]
            
            if lat_raw.ndim == 1 and lon_raw.ndim == 1:
                lon_data, lat_data = np.meshgrid(lon_raw, lat_raw)
            else:
                lat_data = lat_raw
                lon_data = lon_raw

            lat_offset = max_radius_km / 111.0
            lon_offset = lat_offset / max(0.1, np.cos(np.radians(obs_lat)))
            
            lat_min, lat_max = obs_lat - lat_offset, obs_lat + lat_offset
            lon_min, lon_max = obs_lon - lon_offset, obs_lon + lon_offset

            valid_mask = (
                (radiance_data > 0)
                & np.isfinite(radiance_data)
                & (radiance_data != fill_value)
            )
            if quality_data is not None:
                quality_mask = np.isin(quality_data, list(BLACK_MARBLE_ALLOWED_QUALITY))
                valid_mask &= quality_mask

            valid_mask &= (lat_data >= lat_min) & (lat_data <= lat_max)
            valid_mask &= (lon_data >= lon_min) & (lon_data <= lon_max)
            
            valid_radiance = radiance_data[valid_mask]
            valid_lat = lat_data[valid_mask]
            valid_lon = lon_data[valid_mask]
            
            for r, lat, lon in zip(valid_radiance, valid_lat, valid_lon):
                pixel_data.append({
                    "radiance": float(r),
                    "radiance_unit": BLACK_MARBLE_RADIANCE_UNIT,
                    "coord": (float(lat), float(lon))
                })
                    
        print(f"{len(pixel_data)} data loaded.")
        return pixel_data
        
    except Exception as e:
        print(f"loading data failed: {e}")
        return []    


def environment_query(time, lat, lon):
    api_key = get_meteoblue_api_key()

    # 1. 초기값 설정
    aod = 0.0
    cloud_fraction = 0.0
    cloud_base_h = 30.0   
    seeing = 0.0
    moonlight = 0.0
    moon_cloud_transmission = 1.0
    moon_phase_angle = calculate_lunar_phase_angle_deg(time)
    moon_zen = 90.0
    moon_az = 0.0

    PACKAGE1 = "seeing-1h"
    PACKAGE2 = "airquality-1h"
    PACKAGE3 = "ensemble-1h" 
    PACKAGE4 = "air-1h"

    # 관측 위치별로 고유한 캐시 파일명 생성 (소수점 4자리까지 제한하여 매칭 편의성 제공)
    cache_dir = API_DIR
    cache_filename = os.path.join(cache_dir, f"weather_cache_{lat:.4f}_{lon:.4f}.json")
    date_str = parse_api_time(time).strftime("%Y-%m-%d")
    daily_cache_filename = os.path.join(cache_dir, f"weather_cache_{lat:.4f}_{lon:.4f}_{date_str}.json")
    cache_hit = False
    responses = {}

    # 2. 로컬 캐시 파일 확인 및 시간 검증
    for candidate_filename in (daily_cache_filename, cache_filename):
        if cache_hit or not os.path.exists(candidate_filename):
            continue

        try:
            with open(candidate_filename, 'r', encoding='utf-8') as f:
                cached_data = json.load(f)
            
            missing_reason = cache_missing_reason(cached_data, time)
            if missing_reason is None:
                if candidate_filename == cache_filename and not os.path.exists(daily_cache_filename):
                    cached_data = save_daily_cache_if_possible(cached_data, daily_cache_filename, time)
                    if cached_data is not None:
                        print(f"[{daily_cache_filename}] 하루치 캐시를 생성했습니다.")

                print(f"[{candidate_filename}] 로컬 캐시에서 데이터를 찾았습니다. API 호출을 건너뜁니다.")
                responses = cached_data
                cache_hit = True
            else:
                print(f"캐시 파일이 존재하지만 사용할 수 없습니다: {candidate_filename}")
                print(f"  -> 이유: {missing_reason}")
        except Exception as e:
            print(f"캐시 파일을 읽는 중 오류 발생 (새로 요청 진행): {e}")

    # 3. 캐시가 없거나 만료된 경우 API 새로 요청
    if not cache_hit:
        print("Meteoblue API로부터 새로운 일주일 데이터를 요청합니다...")
        os.makedirs(cache_dir, exist_ok=True)
        url1 = f"https://my.meteoblue.com/packages/{PACKAGE1}?lat={lat}&lon={lon}&asl=38&tz=local&format=json&apikey={api_key}&history_days={API_HISTORY_DAYS}"
        url2 = f"https://my.meteoblue.com/packages/{PACKAGE2}?lat={lat}&lon={lon}&asl=38&tz=local&format=json&apikey={api_key}&history_days={API_HISTORY_DAYS}"
        url3 = f"https://my.meteoblue.com/packages/{PACKAGE3}?lat={lat}&lon={lon}&asl=38&tz=local&format=json&apikey={api_key}&history_days={API_HISTORY_DAYS}"
        url4 = f"https://my.meteoblue.com/packages/{PACKAGE4}?lat={lat}&lon={lon}&asl=38&tz=local&format=json&apikey={api_key}&history_days={API_HISTORY_DAYS}"
        try:
            responses = {
                'p1': requests.get(url1, timeout=20).json(),
                'p2': requests.get(url2, timeout=20).json(),
                'p3': requests.get(url3, timeout=20).json(),
                'p4': requests.get(url4, timeout=20).json(),
            }
            
            # 5개 패키지 응답을 묶어서 로컬 파일로 저장
            with open(cache_filename, 'w', encoding='utf-8') as f:
                json.dump(responses, f, ensure_ascii=False, indent=4)
            print(f"새로운 데이터를 [{cache_filename}]에 성공적으로 저장했습니다.")

            responses = save_daily_cache_if_possible(responses, daily_cache_filename, time)
            print(f"하루치 데이터를 [{daily_cache_filename}]에 성공적으로 저장했습니다.")
            
        except Exception as e:
            print(f"API 요청 또는 캐시 저장 중 에러 발생: {e}")
            return aod, cloud_fraction, cloud_base_h, seeing, moonlight, (moon_zen, moon_az), moon_phase_angle, moon_cloud_transmission

    # 4. 데이터 파싱 및 가공 (기존 로직과 동일하나 responses 딕셔너리에서 가져옴)
    try:
        response1 = responses.get('p1', {})
        response2 = responses.get('p2', {})
        response3 = responses.get('p3', {})
        response4 = responses.get('p4', {})
        # [1] Seeing + Moon position
        if 'data_1h' in response1:
            interp = get_interp_indices(response1['data_1h'], time)
            if interp is None:
                print(f"Seeing 데이터 매칭 실패")
            else:
                idx0, idx1, frac = interp
                seeing = interp_value(response1['data_1h'].get('seeing_arcsec', []), idx0, idx1, frac, default=0.0)

            astro_interp = get_interp_indices(response1['data_1h'], shift_astro_time(time))
            if astro_interp is None:
                print(f"Moon position 데이터 매칭 실패")
            else:
                idx0, idx1, frac = astro_interp
                moon_data = response1['data_1h'].get('planet_positions', {}).get('moon', {})
                moon_az = interp_angle_deg(moon_data.get('az', []), idx0, idx1, frac, default=0.0)
                moon_alt = interp_value(moon_data.get('alt', []), idx0, idx1, frac, default=0.0)
                moon_zen = 90.0 - moon_alt
        else:
            print(f"Seeing 데이터 매칭 실패")

        # [2] AOD
        if 'data_1h' in response2:
            interp = get_interp_indices(response2['data_1h'], time)
            if interp is None:
                print(f"AOD 데이터 매칭 실패")
            else:
                idx0, idx1, frac = interp
                aod = interp_value(response2['data_1h'].get('aod550', []), idx0, idx1, frac, default=0.0)
        else:
            print(f"AOD 데이터 매칭 실패")

        # [3] Cloud Fraction
        ens_key = 'gfsensemble_1h' if 'gfsensemble_1h' in response3 else 'data_1h'
        if ens_key in response3:
            interp = get_interp_indices(response3[ens_key], time)
            if interp is None:
                print(f"Cloud 데이터 매칭 실패")
            else:
                idx0, idx1, frac = interp
                totalcloud_data = response3[ens_key].get('totalcloudcover', [])
                
                if totalcloud_data and isinstance(totalcloud_data[0], list):
                    cloud_values = [
                        interp_value(member, idx0, idx1, frac, default=0.0)
                        for member in totalcloud_data
                    ]
                    cloud_fraction = sum(cloud_values) / len(cloud_values) / 100.0
                elif totalcloud_data:
                    cloud_fraction = interp_value(totalcloud_data, idx0, idx1, frac, default=0.0) / 100.0
        else:
            print(f"Cloud 데이터 매칭 실패")

        # [4] Cloud Base Height
        if 'data_1h' in response4:
            interp = get_interp_indices(response4['data_1h'], time)
            if interp is None:
                print(f"Cloud Base 데이터 매칭 실패")
            else:
                idx0, idx1, frac = interp
                cloud_base_p = interp_value(
                    response4['data_1h'].get('convectivecloudbase_pressure', []),
                    idx0, idx1, frac, default=np.nan
                )
                cloud_base_h = pressure_to_cloud_base_height_km(cloud_base_p, cloud_fraction)
        else:
            print(f"Cloud Base 데이터 매칭 실패")

        # [5] Moonlight API percent is intentionally not used.
        # Moon brightness is computed from lunar phase angle in the radiative model.

    except Exception as e:
        print(f"데이터 파싱 중 에러 발생: {e}")

    aod = float(np.clip(aod, 0.0, 5.0))
    cloud_fraction = float(np.clip(cloud_fraction, 0.0, 1.0))
    cloud_base_h = pressure_to_cloud_base_height_km(None, cloud_fraction) if cloud_base_h is None else float(np.clip(cloud_base_h, 0.1, 30.0))
    seeing = float(max(0.0, seeing))
    moonlight = 0.0
    moon_cloud_transmission = 1.0

    return aod, cloud_fraction, cloud_base_h, seeing, moonlight, (moon_zen, moon_az), moon_phase_angle, moon_cloud_transmission

if __name__ == "__main__":
    test_lat = 33.426769
    test_lon = 126.530349
    test_time = "2026-05-22 22:00"
    
    aod, cloud_fraction, cloud_base_h, seeing, moonlight, moon_angle, moon_phase_angle, moon_cloud_transmission = environment_query(test_time, test_lat, test_lon)
    print(f"AOD: {aod}, Cloud Fraction: {cloud_fraction}, Cloud Base Height: {cloud_base_h}, Seeing: {seeing}, Moonlight: {moonlight}, Moon Angle (Zen, Az): {moon_angle}, Moon Phase Angle: {moon_phase_angle}, Moon Cloud Transmission: {moon_cloud_transmission}")
