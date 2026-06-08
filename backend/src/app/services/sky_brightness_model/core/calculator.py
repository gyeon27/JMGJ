import os
import math
import numpy as np
import rasterio
from numba import njit
from functools import partial
from .config import BLACK_MARBLE_RADIANCE_TO_SI, EnvironmentConfig

# -------------------------------------------------------------------
# 3. Numba 최적화된 함수들
# -------------------------------------------------------------------
@njit(fastmath=True)
def calculate_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0 # 지구 반지름 (km)
    lat1_rad, lon1_rad = math.radians(lat1), math.radians(lon1)
    lat2_rad, lon2_rad = math.radians(lat2), math.radians(lon2)
    
    dlat = lat2_rad - lat1_rad
    dlon = lon2_rad - lon1_rad
    
    a = math.sin(dlat / 2)**2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

@njit(fastmath=True)
def calculate_bearing(lat_obs: float, lon_obs: float, lat_light: float, lon_light: float) -> float:
    """관측자에서 광원을 바라보는 방위각(Bearing) 계산 (단위: 라디안)"""
    lat1, lon1 = math.radians(lat_obs), math.radians(lon_obs)
    lat2, lon2 = math.radians(lat_light), math.radians(lon_light)
    dlon = lon2 - lon1
    
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - (math.sin(lat1) * math.cos(lat2) * math.cos(dlon))
    
    initial_bearing = math.atan2(x, y)
    return (initial_bearing + 2 * math.pi) % (2 * math.pi)

@njit(fastmath=True)
def _clip_numba(value: float, low: float, high: float) -> float:
    if value < low:
        return low
    if value > high:
        return high
    return value

@njit(fastmath=True)
def _safe_arccos_numba(value: float) -> float:
    return math.acos(_clip_numba(value, -1.0, 1.0))

@njit(fastmath=True)
def _air_mass_numba(z: float, epsilon: float) -> float:
    z_safe = min(z, math.radians(89.9))
    cos_z = max(math.cos(z_safe), epsilon)
    return 1.0 / (cos_z + 0.025 * math.exp(-11.0 * cos_z))

@njit(fastmath=True)
def _zenith_0h_numba(h: float, z: float, phi: float, L: float, phi_c: float, epsilon: float) -> float:
    h = max(h, epsilon)
    tan_z = math.tan(z)
    term1 = 1.0 + tan_z * tan_z
    l_over_h = L / h
    term2 = l_over_h * (l_over_h - 2.0 * tan_z * math.cos(phi - phi_c))
    cos_val = 1.0 / math.sqrt(max(term1 + term2, epsilon))
    return _safe_arccos_numba(cos_val)

@njit(fastmath=True)
def _scattering_angle_numba(z: float, z_0h: float, L: float, h: float, epsilon: float) -> float:
    h = max(h, epsilon)
    cos_z = math.cos(z)
    if abs(cos_z) <= epsilon:
        cos_z = epsilon

    cos_z0h = math.cos(z_0h)
    if abs(cos_z0h) <= epsilon:
        cos_z0h = epsilon

    val = 0.5 * (((L / h) ** 2) * cos_z * cos_z0h - cos_z0h / cos_z - cos_z / cos_z0h)
    return _safe_arccos_numba(val)

@njit(fastmath=True)
def _directional_b_numba(z_0: float, Q: float, q: float, epsilon: float) -> float:
    b_z0 = 2.0 * Q * (1.0 - q) * math.cos(z_0) + 0.554 * q * (z_0 ** 4)
    b_0 = max(2.0 * Q * (1.0 - q), epsilon)
    return b_z0 / b_0

@njit(fastmath=True)
def _transmittance_numba(
    h: float,
    z: float,
    tau0_m: float,
    aod: float,
    gamma: float,
    scale_height: float,
    epsilon: float,
) -> float:
    air_mass = _air_mass_numba(z, epsilon)
    tau_m_h = tau0_m * (1.0 - math.exp(-h / scale_height))
    tau_a_h = aod * (1.0 - math.exp(-gamma * h))
    return math.exp(-air_mass * (tau_m_h + tau_a_h))

@njit(fastmath=True)
def _scattering_numba(
    h: float,
    theta: float,
    tau0_m: float,
    scale_height: float,
    omega_a: float,
    gamma: float,
    aod: float,
    g: float,
    epsilon: float,
) -> float:
    cos_theta = math.cos(theta)
    p_m = 0.75 * (1.0 + cos_theta * cos_theta)
    scatter_m = p_m * (tau0_m / scale_height) * math.exp(-h / scale_height)

    denom = max(1.0 + g * g - 2.0 * g * cos_theta, epsilon)
    p_a = (1.0 - g * g) / (denom ** 1.5)
    scatter_a = omega_a * p_a * gamma * aod * math.exp(-gamma * h)

    return (scatter_m + scatter_a) / (4.0 * math.pi)

@njit(fastmath=True)
def calculate_artificial_light_batch_numba(
    radiance_arr,
    distance_arr,
    phi_c_arr,
    shield_arr,
    z: float,
    phi: float,
    max_radius_km: float,
    pixel_area: float,
    tau0_m: float,
    aod: float,
    scale_height: float,
    rho_albedo: float,
    gamma: float,
    omega_a: float,
    g: float,
    Q: float,
    q: float,
    H_max: float,
    cloud_effect_fraction: float,
) -> float:
    epsilon = 1e-5
    cos_z = math.cos(z)
    if cos_z <= epsilon:
        return 0.0

    total_i = 0.0
    num_samples = 50
    h_start = 0.001
    h_step = (H_max - h_start) / (num_samples - 1)

    for i in range(radiance_arr.shape[0]):
        I_0 = radiance_arr[i]
        if I_0 <= 0.0:
            continue

        L = distance_arr[i]
        if L > max_radius_km:
            continue
        L = max(L, 0.01)

        phi_c = phi_c_arr[i]
        shield_elevation_deg = _clip_numba(shield_arr[i], 0.0, 89.9)
        max_zenith_rad = math.radians(90.0 - shield_elevation_deg)

        z_cloud = _zenith_0h_numba(H_max, z, phi, L, phi_c, epsilon)
        i_cloud = 0.0
        if z_cloud <= max_zenith_rad:
            t_z = _transmittance_numba(H_max, z, tau0_m, aod, gamma, scale_height, epsilon)
            t_z0 = _transmittance_numba(H_max, z_cloud, tau0_m, aod, gamma, scale_height, epsilon)
            dir_b_cloud = _directional_b_numba(z_cloud, Q, q, epsilon)
            cos_z_cloud = math.cos(z_cloud)
            i_cloud = (
                I_0 * pixel_area * rho_albedo / (math.pi * H_max * H_max)
                * (cos_z_cloud ** 4) * dir_b_cloud * t_z * t_z0
            )

        integral = 0.0
        prev_integrand = 0.0
        for j in range(num_samples):
            h = h_start + h_step * j
            z_0h = _zenith_0h_numba(h, z, phi, L, phi_c, epsilon)
            integrand = 0.0

            if z_0h <= max_zenith_rad:
                theta = _scattering_angle_numba(z, z_0h, L, h, epsilon)
                gamma_scatter = _scattering_numba(
                    h, theta, tau0_m, scale_height, omega_a, gamma, aod, g, epsilon
                )
                dir_b = _directional_b_numba(z_0h, Q, q, epsilon)
                t_z = _transmittance_numba(h, z, tau0_m, aod, gamma, scale_height, epsilon)
                t_z0 = _transmittance_numba(h, z_0h, tau0_m, aod, gamma, scale_height, epsilon)
                cos_z0h = math.cos(z_0h)
                integrand = dir_b * (cos_z0h ** 2) * t_z * t_z0 / (h * h) * gamma_scatter

            if j > 0:
                integral += 0.5 * (prev_integrand + integrand) * h_step
            prev_integrand = integrand

        i_city = (pixel_area * I_0 / cos_z) * integral
        C = _clip_numba(cloud_effect_fraction, 0.0, 1.0)
        total_i += i_city + i_cloud * C

    return total_i

@njit(fastmath=True)
def calculate_artificial_light_components_batch_numba(
    radiance_arr,
    distance_arr,
    phi_c_arr,
    shield_arr,
    z: float,
    phi: float,
    max_radius_km: float,
    pixel_area: float,
    tau0_m: float,
    aod: float,
    scale_height: float,
    rho_albedo: float,
    gamma: float,
    omega_a: float,
    g: float,
    Q: float,
    q: float,
    H_max: float,
    cloud_effect_fraction: float,
) -> tuple:
    epsilon = 1e-5
    cos_z = math.cos(z)
    if cos_z <= epsilon:
        return 0.0, 0.0

    city_sum = 0.0
    cloud_sum = 0.0
    num_samples = 50
    h_start = 0.001
    h_step = (H_max - h_start) / (num_samples - 1)
    C = _clip_numba(cloud_effect_fraction, 0.0, 1.0)

    for i in range(radiance_arr.shape[0]):
        I_0 = radiance_arr[i]
        if I_0 <= 0.0:
            continue

        L = distance_arr[i]
        if L > max_radius_km:
            continue
        L = max(L, 0.01)

        phi_c = phi_c_arr[i]
        shield_elevation_deg = _clip_numba(shield_arr[i], 0.0, 89.9)
        max_zenith_rad = math.radians(90.0 - shield_elevation_deg)

        z_cloud = _zenith_0h_numba(H_max, z, phi, L, phi_c, epsilon)
        if z_cloud <= max_zenith_rad:
            t_z = _transmittance_numba(H_max, z, tau0_m, aod, gamma, scale_height, epsilon)
            t_z0 = _transmittance_numba(H_max, z_cloud, tau0_m, aod, gamma, scale_height, epsilon)
            dir_b_cloud = _directional_b_numba(z_cloud, Q, q, epsilon)
            cos_z_cloud = math.cos(z_cloud)
            i_cloud = (
                I_0 * pixel_area * rho_albedo / (math.pi * H_max * H_max)
                * (cos_z_cloud ** 4) * dir_b_cloud * t_z * t_z0
            )
            cloud_sum += i_cloud * C

        integral = 0.0
        prev_integrand = 0.0
        for j in range(num_samples):
            h = h_start + h_step * j
            z_0h = _zenith_0h_numba(h, z, phi, L, phi_c, epsilon)
            integrand = 0.0

            if z_0h <= max_zenith_rad:
                theta = _scattering_angle_numba(z, z_0h, L, h, epsilon)
                gamma_scatter = _scattering_numba(
                    h, theta, tau0_m, scale_height, omega_a, gamma, aod, g, epsilon
                )
                dir_b = _directional_b_numba(z_0h, Q, q, epsilon)
                t_z = _transmittance_numba(h, z, tau0_m, aod, gamma, scale_height, epsilon)
                t_z0 = _transmittance_numba(h, z_0h, tau0_m, aod, gamma, scale_height, epsilon)
                cos_z0h = math.cos(z_0h)
                integrand = dir_b * (cos_z0h ** 2) * t_z * t_z0 / (h * h) * gamma_scatter

            if j > 0:
                integral += 0.5 * (prev_integrand + integrand) * h_step
            prev_integrand = integrand

        city_sum += (pixel_area * I_0 / cos_z) * integral

    return city_sum, cloud_sum

# calculator.py 내부 (calculate_bearing 함수 아래에 추가)

@njit(fastmath=True)
def calculate_target_coordinate(lat_obs: float, lon_obs: float, azimuth_deg: float, distance_km: float):
    """관측자 위치에서 특정 방위각(달의 방향)으로 distance_km 만큼 떨어진 곳의 좌표 계산"""
    R = 6371.0
    lat1 = math.radians(lat_obs)
    lon1 = math.radians(lon_obs)
    az_rad = math.radians(azimuth_deg)
    
    lat2 = math.asin(math.sin(lat1) * math.cos(distance_km / R) + 
                     math.cos(lat1) * math.sin(distance_km / R) * math.cos(az_rad))
    lon2 = lon1 + math.atan2(math.sin(az_rad) * math.sin(distance_km / R) * math.cos(lat1), 
                             math.cos(distance_km / R) - math.sin(lat1) * math.sin(lat2))
    lon2 = (lon2 + 3 * math.pi) % (2 * math.pi) - math.pi

    return math.degrees(lat2), math.degrees(lon2)

def calculate_directional_shielding(obs_coord: tuple, azimuth_deg: float, dem_array, dem_transform, max_dist_km=30.0) -> float:
    """특정 방위각(달 방향)으로 스캔하여 최대 지형 차폐각(산의 높이각)을 반환"""
    obs_lat, obs_lon = obs_coord
    target_lat, target_lon = calculate_target_coordinate(obs_lat, obs_lon, azimuth_deg, max_dist_km)
    
    num_samples = int(max_dist_km / 0.1)
    num_samples = max(10, min(num_samples, 1000))
    
    lats = np.linspace(obs_lat, target_lat, num_samples)
    lons = np.linspace(obs_lon, target_lon, num_samples)
    
    inv_transform = ~dem_transform
    cols, rows = inv_transform * (lons, lats)
    
    rows = np.clip(np.round(rows).astype(int), 0, dem_array.shape[0] - 1)
    cols = np.clip(np.round(cols).astype(int), 0, dem_array.shape[1] - 1)
    
    try:
        raw_elevations = dem_array[rows, cols]
        elevations = np.where(raw_elevations > -500, raw_elevations * 1e-3, 0.0)
        
        obs_elevation = elevations[0]
        delta_h = elevations[1:] - obs_elevation
        valid_idx = np.where(delta_h > 0)[0]
        
        if len(valid_idx) == 0:
            return 0.0
            
        dist_km_array = np.linspace(0, max_dist_km, num_samples)[1:]
        valid_delta_h = delta_h[valid_idx]
        valid_dist_km = dist_km_array[valid_idx]
        
        angles_rad = np.arctan2(valid_delta_h, valid_dist_km)
        max_angle_deg = np.degrees(np.max(angles_rad))
        
        return float(max_angle_deg)
    except Exception:
        return 0.0

# -------------------------------------------------------------------
# 멀티프로세싱 프로세스별 전역 변수
# -------------------------------------------------------------------
worker_dem_array = None
worker_dem_transform = None

def init_process(dem_path):
    """각 CPU 코어(프로세스)가 생성될 때 DEM 지형 데이터를 딱 한 번만 메모리에 올립니다."""
    global worker_dem_array, worker_dem_transform
    if dem_path:
        with rasterio.open(dem_path) as dataset:
            worker_dem_array = dataset.read(1)
            worker_dem_transform = dataset.transform

# -------------------------------------------------------------------
# 지형 차폐각 고속 계산
# -------------------------------------------------------------------
def calculate_shielding_angle_img(light_coord: tuple, obs_coord: tuple, dem_array, dem_transform) -> float:
    light_lat, light_lon = light_coord
    obs_lat, obs_lon = obs_coord
    
    total_dist_km = calculate_distance(obs_lat, obs_lon, light_lat, light_lon)
    if total_dist_km <= 0.1:
        return 0.0
        
    num_samples = int(total_dist_km / 0.1) 
    num_samples = max(10, min(num_samples, 1000)) 
    
    lats = np.linspace(obs_lat, light_lat, num_samples)
    lons = np.linspace(obs_lon, light_lon, num_samples)
    
    inv_transform = ~dem_transform
    cols, rows = inv_transform * (lons, lats)
    
    rows = np.clip(np.round(rows).astype(int), 0, dem_array.shape[0] - 1)
    cols = np.clip(np.round(cols).astype(int), 0, dem_array.shape[1] - 1)
    
    try:
        raw_elevations = dem_array[rows, cols]
        elevations = np.where(raw_elevations > -500, raw_elevations * 1e-3, 0.0)
        
        obs_elevation = elevations[0]
        
        delta_h = elevations[1:] - obs_elevation
        valid_idx = np.where(delta_h > 0)[0]
        
        if len(valid_idx) == 0:
            return 0.0
            
        dist_km_array = np.linspace(0, total_dist_km, num_samples)[1:]
        
        valid_delta_h = delta_h[valid_idx]
        valid_dist_km = dist_km_array[valid_idx]
        
        angles_rad = np.arctan2(valid_delta_h, valid_dist_km)
        max_angle_deg = np.degrees(np.max(angles_rad))
        
        return float(max_angle_deg)
    except Exception:
        return 0.0

# -------------------------------------------------------------------
#  2. 멀티프로세싱 워커 함수
# -------------------------------------------------------------------
# -------------------------------------------------------------------
#  2. 멀티프로세싱 워커 함수 (Global 변수 제거 및 파라미터 직접 전달)
# -------------------------------------------------------------------
def process_pixel_task(data, obs_lat, obs_lon, obs_z_rad, obs_phi_rad, MAX_RADIUS_KM, model, dem_array=None, dem_transform=None):
    
    light_lat, light_lon = data["coord"]
    radiance_val = data["radiance"]
    
    L_dist = data.get("distance_km")
    if L_dist is None:
        L_dist = calculate_distance(obs_lat, obs_lon, light_lat, light_lon)

    if L_dist > MAX_RADIUS_KM:
        return 0.0
        
    L_dist = max(L_dist, 0.01)
    phi_c_rad = data.get("phi_c_rad")
    if phi_c_rad is None:
        phi_c_rad = calculate_bearing(obs_lat, obs_lon, light_lat, light_lon)

    shield_deg = data.get("shield_deg")
    if shield_deg is None:
        shield_deg = 0.0
    # 💡 인자로 넘겨받은 지형 데이터가 있으면 차폐각 적용
    if "shield_deg" not in data and dem_array is not None and dem_transform is not None:
        shield_deg = calculate_shielding_angle_img(
            (light_lat, light_lon), (obs_lat, obs_lon), dem_array, dem_transform
        )

    I_val = model.calculate_artificial_light(
        z=obs_z_rad, phi=obs_phi_rad, phi_c=phi_c_rad, 
        L=L_dist, I_0=radiance_val, shield_elevation_deg=shield_deg
    )
    return I_val

def process_pixel_task_components(data, obs_lat, obs_lon, obs_z_rad, obs_phi_rad, MAX_RADIUS_KM, model, dem_array=None, dem_transform=None):
    light_lat, light_lon = data["coord"]
    radiance_val = data["radiance"]

    L_dist = data.get("distance_km")
    if L_dist is None:
        L_dist = calculate_distance(obs_lat, obs_lon, light_lat, light_lon)

    if L_dist > MAX_RADIUS_KM:
        return 0.0, 0.0

    L_dist = max(L_dist, 0.01)
    phi_c_rad = data.get("phi_c_rad")
    if phi_c_rad is None:
        phi_c_rad = calculate_bearing(obs_lat, obs_lon, light_lat, light_lon)

    shield_deg = data.get("shield_deg")
    if shield_deg is None:
        shield_deg = 0.0
    if "shield_deg" not in data and dem_array is not None and dem_transform is not None:
        shield_deg = calculate_shielding_angle_img(
            (light_lat, light_lon), (obs_lat, obs_lon), dem_array, dem_transform
        )

    return model.calculate_artificial_light_components(
        z=obs_z_rad,
        phi=obs_phi_rad,
        phi_c=phi_c_rad,
        L=L_dist,
        I_0=radiance_val,
        shield_elevation_deg=shield_deg,
    )

def filter_bright_pixels(pixel_data, keep_radiance_fraction=0.99, min_pixels=50, max_pixels=200):
    """Keep the brightest pixels that explain most of the surrounding radiance."""
    if not pixel_data or keep_radiance_fraction >= 1.0:
        selected = list(pixel_data)
        return selected[:max_pixels] if max_pixels is not None and max_pixels > 0 else selected

    keep_radiance_fraction = float(np.clip(keep_radiance_fraction, 0.0, 1.0))
    min_pixels = max(1, int(min_pixels))
    max_pixels = None if max_pixels is None or max_pixels <= 0 else max(min_pixels, int(max_pixels))
    sorted_pixels = sorted(pixel_data, key=lambda item: item.get("radiance", 0.0), reverse=True)
    total_radiance = sum(max(0.0, float(item.get("radiance", 0.0))) for item in sorted_pixels)
    if total_radiance <= 0.0:
        return sorted_pixels[:max_pixels] if max_pixels is not None else sorted_pixels

    selected = []
    running_radiance = 0.0
    target_radiance = total_radiance * keep_radiance_fraction
    for item in sorted_pixels:
        selected.append(item)
        running_radiance += max(0.0, float(item.get("radiance", 0.0)))
        if max_pixels is not None and len(selected) >= max_pixels:
            break
        if running_radiance >= target_radiance and len(selected) >= min_pixels:
            break

    return selected

def prepare_pixel_geometry(
    pixel_data,
    obs_coord,
    max_radius_km=30.0,
    dem_data=None,
    keep_radiance_fraction=0.99,
    min_pixels=50,
    max_pixels=200,
):
    """Precompute per-pixel geometry that does not change across optimizer trials."""
    obs_lat, obs_lon = obs_coord
    dem_array = dem_transform = None
    if dem_data is not None:
        dem_array, dem_transform = dem_data

    prepared = []
    filtered_pixel_data = filter_bright_pixels(
        pixel_data,
        keep_radiance_fraction,
        min_pixels,
        max_pixels,
    )
    for pixel in filtered_pixel_data:
        light_lat, light_lon = pixel["coord"]
        dist_km = calculate_distance(obs_lat, obs_lon, light_lat, light_lon)
        if dist_km > max_radius_km:
            continue

        item = dict(pixel)
        item["distance_km"] = max(float(dist_km), 0.01)
        item["phi_c_rad"] = float(calculate_bearing(obs_lat, obs_lon, light_lat, light_lon))

        if dem_array is not None and dem_transform is not None:
            item["shield_deg"] = calculate_shielding_angle_img(
                (light_lat, light_lon), obs_coord, dem_array, dem_transform
            )
        else:
            item["shield_deg"] = 0.0

        prepared.append(item)

    return prepared

# -------------------------------------------------------------------
# 클래스 원본 유지 (코드 구조 동일)
# -------------------------------------------------------------------
class LightPollutionModel:  
    EPSILON = 1e-5

    def __init__(self, config: EnvironmentConfig):
        self.cfg = config

    @staticmethod
    def _safe_arccos(cos_val):
        return np.arccos(np.clip(cos_val, -1.0, 1.0))

    def _air_mass(self, z):
        z_safe = np.minimum(z, np.radians(89.9))
        cos_z = np.maximum(np.cos(z_safe), self.EPSILON)
        return 1.0 / (cos_z + 0.025 * np.exp(-11.0 * cos_z))

    def calculate_zenith_0h(self, h, z: float, phi: float, L: float, phi_c: float):
        h = np.maximum(h, self.EPSILON)
        tan_z = np.tan(z)
        term1 = 1 + tan_z**2
        term2 = (L / h) * ((L / h) - 2 * tan_z * np.cos(phi - phi_c))
        
        cos_val = (term1 + term2)**(-0.5)
        return self._safe_arccos(cos_val)

    def calculate_scattering_angle(self, z: float, z_0h_val, L: float, h):
        h = np.maximum(h, self.EPSILON)
        cos_z = np.cos(z) if abs(np.cos(z)) > self.EPSILON else self.EPSILON
        
        cos_z0h = np.cos(z_0h_val)
        cos_z0h = np.where(np.abs(cos_z0h) > self.EPSILON, cos_z0h, self.EPSILON)
        
        val = 0.5 * (((L / h)**2) * cos_z * cos_z0h - cos_z0h / cos_z - cos_z / cos_z0h)
        return self._safe_arccos(val)

    def directional_function_B(self, z_0):
        b_z0 = 2 * self.cfg.Q * (1 - self.cfg.q) * np.cos(z_0) + 0.554 * self.cfg.q * (z_0**4)
        b_0 = 2 * self.cfg.Q * (1 - self.cfg.q) * 1.0
        return b_z0 / b_0

    def transmittance(self, h, z):
        air_mass = self._air_mass(z)
        # 분자 산란
        tau_m_h = self.cfg.tau0_m * (1 - np.exp(-h / self.cfg.scale_height))
        # 💡 에어로졸 산란 (고도 h까지만 반영되도록 수정)
        tau_a_h = self.cfg.aod * (1 - np.exp(-self.cfg.gamma * h)) 
        
        tau_total = tau_m_h + tau_a_h
        return np.exp(-air_mass * tau_total)

    def total_transmittance(self, h, z: float, z_0):
        return self.transmittance(h, z) * self.transmittance(h, z_0)

    def _calculate_scattering(self, h, theta):
        cos_theta = np.cos(theta)
        
        p_m = 0.75 * (1 + cos_theta**2)
        scatter_m = p_m * (self.cfg.tau0_m / self.cfg.scale_height) * np.exp(-h / self.cfg.scale_height)

        denom = np.maximum(1 + self.cfg.g**2 - 2 * self.cfg.g * cos_theta, self.EPSILON)
        p_a = (1 - self.cfg.g**2) / (denom**1.5)
        scatter_a = self.cfg.omega_a * p_a * self.cfg.gamma * self.cfg.aod * np.exp(-self.cfg.gamma * h)
        
        return (scatter_m + scatter_a) / (4 * np.pi)

    def calculate_artificial_light(self, z: float, phi: float, phi_c: float, L: float, I_0: float, shield_elevation_deg: float = 0.0) -> float:
        i_city, i_cloud = self.calculate_artificial_light_components(
            z, phi, phi_c, L, I_0, shield_elevation_deg
        )
        return i_city + i_cloud

    def calculate_artificial_light_components(self, z: float, phi: float, phi_c: float, L: float, I_0: float, shield_elevation_deg: float = 0.0) -> tuple[float, float]:
        if I_0 <= 0:
            return 0.0, 0.0

        cos_z = np.cos(z)
        if cos_z <= self.EPSILON:
            return 0.0, 0.0
            
        shield_elevation_deg = float(np.clip(shield_elevation_deg, 0.0, 89.9))
        max_zenith_rad = np.radians(90.0 - shield_elevation_deg)

        zenith_0_cloud = self.calculate_zenith_0h(self.cfg.H_max, z, phi, L, phi_c)
        i_cloud = 0.0
        
        if zenith_0_cloud <= max_zenith_rad:
            t_total_cloud = self.total_transmittance(self.cfg.H_max, z, zenith_0_cloud)
            dir_b_cloud = self.directional_function_B(zenith_0_cloud)
            i_cloud = (I_0 * self.cfg.pixel_area * getattr(self.cfg, 'rho_albedo', 0.0) / (np.pi * self.cfg.H_max**2) 
                       * (np.cos(zenith_0_cloud)**4) * dir_b_cloud * t_total_cloud)

        NUM_SAMPLES = 50 
        h_array = np.linspace(0.001, self.cfg.H_max, NUM_SAMPLES)
        
        z_0h_vals = self.calculate_zenith_0h(h_array, z, phi, L, phi_c)
        valid_mask = z_0h_vals <= max_zenith_rad
        
        if not np.any(valid_mask):
            i_city = 0.0
        else:
            theta_vals = self.calculate_scattering_angle(z, z_0h_vals, L, h_array)
            gamma_scatter_vals = self._calculate_scattering(h_array, theta_vals)
            dir_b_vals = self.directional_function_B(z_0h_vals)
            t_total_vals = self.total_transmittance(h_array, z, z_0h_vals)
            
            integrands = dir_b_vals * (np.cos(z_0h_vals)**2) * t_total_vals / (h_array**2) * gamma_scatter_vals
            integrands[~valid_mask] = 0.0
            
            res_integral = np.trapezoid(integrands, x=h_array)
            i_city = (self.cfg.pixel_area * I_0 / cos_z) * res_integral

        C = getattr(self.cfg, 'cloud_effect_fraction', getattr(self.cfg, 'cloud_fraction', 0.0))
        C = float(np.clip(C, 0.0, 1.0))
        return float(i_city), float(i_cloud * C)

    def calculate_moonlight(self, xi_0: float, phi_0: float, z: float, phi: float, moon_shield_deg: float = 0.0) -> float:
        # Kocifaj Eq.25-style first-order scattering of extraterrestrial moonlight.
        cos_z = np.cos(z)
        if cos_z <= self.EPSILON:
            return 0.0

        moon_elevation_deg = 90.0 - np.degrees(xi_0)
        moon_shield_deg = float(np.clip(moon_shield_deg, 0.0, 89.9))
        if moon_elevation_deg <= moon_shield_deg:
            return 0.0

        cos_theta = np.cos(xi_0) * cos_z + np.sin(xi_0) * np.sin(z) * np.cos(phi - phi_0)
        theta_moon = self._safe_arccos(cos_theta)

        phase_angle = float(np.clip(getattr(self.cfg, 'moon_phase_angle_deg', 180.0), 0.0, 180.0))
        i_ml = 10.0**(-0.4 * (3.84 + 0.026 * abs(phase_angle) + 4.0e-9 * phase_angle**4))
        moon_transmission_scale = float(np.clip(getattr(self.cfg, 'moon_transmission_scale', 1.0), 0.5, 2.0))

        def moon_transmittance(h, zenith_rad):
            air_mass = self._air_mass(zenith_rad)
            tau_m_h = self.cfg.tau0_m * (1.0 - np.exp(-h / self.cfg.scale_height))
            tau_a_h = self.cfg.aod * (1.0 - np.exp(-self.cfg.gamma * h))
            return np.exp(-air_mass * moon_transmission_scale * (tau_m_h + tau_a_h))

        num_samples = 50
        moon_top_km = max(0.1, float(getattr(self.cfg, 'moon_model_top_km', 30.0)))
        h_array = np.linspace(0.01, moon_top_km, num_samples)
        gamma_ml_vals = self._calculate_scattering(h_array, theta_moon)
        t_moon_top = moon_transmittance(moon_top_km, xi_0)
        t_moon_to_h_vals = t_moon_top / np.maximum(moon_transmittance(h_array, xi_0), self.EPSILON)
        t_h_to_obs_vals = moon_transmittance(h_array, z)

        integrands = gamma_ml_vals * t_moon_to_h_vals * t_h_to_obs_vals
        integral = np.trapezoid(integrands, x=h_array)

        return max(0.0, float((i_ml / cos_z) * integral))
    def calculate_background(self) -> float:
        return 10 ** ((12.59 - 22.0) / 2.5) / 683

    def calculate_total_radiance(self, i_pixel_list: list[float], i_ml: float, i_bg: float) -> float:
        k_multi_scatter = getattr(self.cfg, 'k_multi_scatter', 1.0)
        art_scale = max(0.0, float(getattr(self.cfg, 'art_scale', 1.0)))
        art_j = art_scale * max(0.0, sum(i_pixel_list)) * BLACK_MARBLE_RADIANCE_TO_SI
        total_j = max(0.0, i_ml) / 683 + max(0.0, i_bg) + art_j
        return total_j * k_multi_scatter

# ===================================================================
# 메인 파이프라인 (초고속 캐싱 및 단일 루프 적용)
# ===================================================================
def run_pipeline(
    observer_coordinates,
    observer_angles,
    moon_angles,
    pixel_data,
    dem_path=None,
    dem_data=None,
    config=None,
    precalc_moon_shield=None,
    max_radius_km=30.0,
    return_components=False,
):
    if config is None:
        config = EnvironmentConfig()
    
    model = LightPollutionModel(config)
    
    obs_lat, obs_lon = observer_coordinates
    obs_z_rad = np.radians(observer_angles[0])
    obs_phi_rad = np.radians(observer_angles[1])
    
    moon_z_rad = np.radians(moon_angles[0])
    moon_phi_rad = np.radians(moon_angles[1])

    MAX_RADIUS_KM = float(max_radius_km)

    # 💡 1단계: 지형 데이터 세팅 (광원 처리보다 먼저 실행해야 함)
    dem_arr_main = None
    dem_trans_main = None
    moon_shield_deg = 0.0
    
    if precalc_moon_shield is not None:
        moon_shield_deg = precalc_moon_shield
        if dem_data is not None:
            dem_arr_main, dem_trans_main = dem_data
            
    elif dem_data is not None:
        dem_arr_main, dem_trans_main = dem_data
        moon_shield_deg = calculate_directional_shielding(
            (obs_lat, obs_lon), moon_angles[1], dem_arr_main, dem_trans_main, max_dist_km=30.0
        )
    elif dem_path and os.path.exists(dem_path):
        with rasterio.open(dem_path) as src:
            dem_arr_main = src.read(1)
            dem_trans_main = src.transform
            moon_shield_deg = calculate_directional_shielding(
                (obs_lat, obs_lon), moon_angles[1], dem_arr_main, dem_trans_main, max_dist_km=30.0
            )

    # 💡 2단계: 워커 함수에 지형 데이터(dem_array, dem_transform) 묶어주기
    worker_func = partial(
        process_pixel_task,
        obs_lat=obs_lat, 
        obs_lon=obs_lon,
        obs_z_rad=obs_z_rad, 
        obs_phi_rad=obs_phi_rad,
        MAX_RADIUS_KM=MAX_RADIUS_KM,
        model=model,
        dem_array=dem_arr_main,       # 수정됨!
        dem_transform=dem_trans_main  # 수정됨!
    )

    I_art_sum = 0.0
    I_cloud_sum = 0.0

    # 3단계: 광원 시뮬레이션 루프. 전처리된 픽셀은 Numba batch 경로를 사용합니다.
    use_numba_batch = bool(pixel_data) and all(
        ("distance_km" in pixel and "phi_c_rad" in pixel and "shield_deg" in pixel)
        for pixel in pixel_data
    )
    if use_numba_batch:
        radiance_arr = np.asarray([pixel["radiance"] for pixel in pixel_data], dtype=np.float64)
        distance_arr = np.asarray([pixel["distance_km"] for pixel in pixel_data], dtype=np.float64)
        phi_c_arr = np.asarray([pixel["phi_c_rad"] for pixel in pixel_data], dtype=np.float64)
        shield_arr = np.asarray([pixel["shield_deg"] for pixel in pixel_data], dtype=np.float64)
        if return_components:
            I_art_sum, I_cloud_sum = calculate_artificial_light_components_batch_numba(
                radiance_arr,
                distance_arr,
                phi_c_arr,
                shield_arr,
                obs_z_rad,
                obs_phi_rad,
                MAX_RADIUS_KM,
                config.pixel_area,
                config.tau0_m,
                config.aod,
                config.scale_height,
                getattr(config, 'rho_albedo', 0.0),
                config.gamma,
                config.omega_a,
                config.g,
                config.Q,
                config.q,
                config.H_max,
                getattr(config, 'cloud_effect_fraction', getattr(config, 'cloud_fraction', 0.0)),
            )
        else:
            I_art_sum = calculate_artificial_light_batch_numba(
                radiance_arr,
                distance_arr,
                phi_c_arr,
                shield_arr,
                obs_z_rad,
                obs_phi_rad,
                MAX_RADIUS_KM,
                config.pixel_area,
                config.tau0_m,
                config.aod,
                config.scale_height,
                getattr(config, 'rho_albedo', 0.0),
                config.gamma,
                config.omega_a,
                config.g,
                config.Q,
                config.q,
                config.H_max,
                getattr(config, 'cloud_effect_fraction', getattr(config, 'cloud_fraction', 0.0)),
            )
    else:
        for pixel in pixel_data:
            if return_components:
                I_art, I_cloud = process_pixel_task_components(
                    pixel,
                    obs_lat,
                    obs_lon,
                    obs_z_rad,
                    obs_phi_rad,
                    MAX_RADIUS_KM,
                    model,
                    dem_arr_main,
                    dem_trans_main,
                )
                I_art_sum += max(0.0, I_art)
                I_cloud_sum += max(0.0, I_cloud)
            else:
                I_val = worker_func(pixel)
                if I_val > 0:
                    I_art_sum += I_val

    # 4단계: 달빛 및 배경광 합산
    I_ml = model.calculate_moonlight(
        moon_z_rad, moon_phi_rad, obs_z_rad, obs_phi_rad, moon_shield_deg=moon_shield_deg
    )
    I_bg = model.calculate_background()
    
    k_multi_scatter = getattr(config, 'k_multi_scatter', 1.0)
    art_scale = max(0.0, float(getattr(config, 'art_scale', 1.0)))
    I_art_final = art_scale * max(0.0, I_art_sum) * BLACK_MARBLE_RADIANCE_TO_SI
    I_cloud_final = art_scale * max(0.0, I_cloud_sum) * BLACK_MARBLE_RADIANCE_TO_SI
    I_ml_final = max(0.0, I_ml) / 683
    I_bg_final = max(0.0, I_bg)
    total = (I_ml_final + I_bg_final + I_art_final + I_cloud_final) * k_multi_scatter

    if return_components:
        return {
            "total": total,
            "I_ml": I_ml,
            "I_art": I_art_sum,
            "I_cloud": I_cloud_sum,
            "I_bg": I_bg,
            "I_ml_final": I_ml_final * k_multi_scatter,
            "I_art_final": I_art_final * k_multi_scatter,
            "I_cloud_final": I_cloud_final * k_multi_scatter,
            "I_bg_final": I_bg_final * k_multi_scatter,
        }

    return total
