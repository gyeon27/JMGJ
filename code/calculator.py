import os
import math
import numpy as np
import rasterio
from numba import njit
from functools import partial
from config import EnvironmentConfig

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
    
    L_dist = calculate_distance(obs_lat, obs_lon, light_lat, light_lon)
    if L_dist > MAX_RADIUS_KM:
        return 0.0
        
    L_dist = max(L_dist, 0.01)
    phi_c_rad = calculate_bearing(obs_lat, obs_lon, light_lat, light_lon)

    shield_deg = 0.0
    # 💡 인자로 넘겨받은 지형 데이터가 있으면 차폐각 적용
    if dem_array is not None and dem_transform is not None:
        shield_deg = calculate_shielding_angle_img(
            (light_lat, light_lon), (obs_lat, obs_lon), dem_array, dem_transform
        )

    I_val = model.calculate_artificial_light(
        z=obs_z_rad, phi=obs_phi_rad, phi_c=phi_c_rad, 
        L=L_dist, I_0=radiance_val, shield_elevation_deg=shield_deg
    )
    return I_val

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
        if I_0 <= 0:
            return 0.0

        cos_z = np.cos(z)
        if cos_z <= self.EPSILON:
            return 0.0
            
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

        C = getattr(self.cfg, 'cloud_fraction', 0.0)
        return (i_city * (1.0 - C)) + (i_cloud * C)

   # calculator.py 내부 LightPollutionModel 클래스의 calculate_moonlight 함수 수정
    
    def calculate_moonlight(self, xi_0: float, phi_0: float, z: float, phi: float, moon_shield_deg: float = 0.0) -> float:
        cos_z = np.cos(z)
        if cos_z <= self.EPSILON:
            return 0.0

        # 달의 실제 고도 (90도 - 천정각)
        moon_elevation_deg = 90.0 - np.degrees(xi_0)
        moon_shield_deg = float(np.clip(moon_shield_deg, 0.0, 89.9))
        
        # [핵심] 달의 고도가 지평선 아래(0 미만)이거나 산(차폐각)보다 낮으면 달빛 차단
        if moon_elevation_deg <= moon_shield_deg:
            return 0.0 

        moonlight_value = float(getattr(self.cfg, 'moonlight', 0.0))
        if moonlight_value <= 0.0:
            return 0.0

        if moonlight_value <= 1.0:
            moon_fraction = moonlight_value
        elif moonlight_value <= 100.0:
            moon_fraction = moonlight_value / 100.0
        else:
            moon_fraction = 1.0

        moon_fraction = float(np.clip(moon_fraction, 0.0, 1.0))
        alpha_deg = np.degrees(np.arccos(np.clip(2.0 * moon_fraction - 1.0, -1.0, 1.0)))
        m_moon = -12.37 + 0.026 * abs(alpha_deg) + 4e-9 * (alpha_deg**4)
        i_moon_base = 10**(-0.4 * (m_moon + 16.57))

        t_moon_top = self.transmittance(self.cfg.H_max, xi_0)
        cos_theta = np.cos(xi_0) * cos_z + np.sin(xi_0) * np.sin(z) * np.cos(phi - phi_0)
        theta_moon = self._safe_arccos(cos_theta)

        NUM_SAMPLES = 50
        h_array = np.linspace(0.01, self.cfg.H_max, NUM_SAMPLES)
        
        gamma_ml_vals = self._calculate_scattering(h_array, theta_moon)
        t_moon_to_h_vals = t_moon_top / self.transmittance(h_array, xi_0)
        t_h_to_obs_vals = self.transmittance(h_array, z)
        
        integrands = gamma_ml_vals * t_moon_to_h_vals * t_h_to_obs_vals
        sumation = np.trapezoid(integrands, x=h_array)
        
        return (i_moon_base / cos_z) * sumation
    def calculate_background(self) -> float:
        return 10 ** ((12.59 - 22.0) / 2.5) / 683

    def calculate_total_radiance(self, i_pixel_list: list[float], i_ml: float, i_bg: float) -> float:
        k_multi_scatter = getattr(self.cfg, 'k_multi_scatter', 1.0)
        total_j = max(0.0, i_ml) / 683 + max(0.0, i_bg) + max(0.0, sum(i_pixel_list)) * 1e-5
        return total_j * k_multi_scatter

# ===================================================================
# 메인 파이프라인 (초고속 캐싱 및 단일 루프 적용)
# ===================================================================
# ===================================================================
# 메인 파이프라인 (초고속 캐싱 및 단일 루프 적용)
# ===================================================================
def run_pipeline(observer_coordinates, observer_angles, moon_angles, pixel_data, dem_path=None, dem_data=None, config=None, precalc_moon_shield=None):
    if config is None:
        config = EnvironmentConfig()
    
    model = LightPollutionModel(config)
    
    obs_lat, obs_lon = observer_coordinates
    obs_z_rad = np.radians(observer_angles[0])
    obs_phi_rad = np.radians(observer_angles[1])
    
    moon_z_rad = np.radians(moon_angles[0])
    moon_phi_rad = np.radians(moon_angles[1])

    MAX_RADIUS_KM = 30.0 

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

    I_pixel = [] 
    
    # 3단계: 광원 시뮬레이션 루프
    for pixel in pixel_data:
        I_val = worker_func(pixel)
        if I_val > 0:
            I_pixel.append(I_val)

    # 4단계: 달빛 및 배경광 합산
    I_ml = model.calculate_moonlight(
        moon_z_rad, moon_phi_rad, obs_z_rad, obs_phi_rad, moon_shield_deg=moon_shield_deg
    )
    I_bg = model.calculate_background()
    
    total = model.calculate_total_radiance(I_pixel, I_ml, I_bg)
    
    return total
