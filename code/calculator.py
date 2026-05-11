import numpy as np
from scipy.integrate import quad
from config import EnvironmentConfig
import math
import rasterio


def calculate_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    
    R = 6371.0 # 지구 반지름 (km)
    lat1_rad, lon1_rad = math.radians(lat1), math.radians(lon1)
    lat2_rad, lon2_rad = math.radians(lat2), math.radians(lon2)
    
    dlat = lat2_rad - lat1_rad
    dlon = lon2_rad - lon1_rad
    
    a = math.sin(dlat / 2)**2 + math.cos(lat1_rad) * math.cos(lat2_rad) * math.sin(dlon / 2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

def calculate_bearing(lat_obs: float, lon_obs: float, lat_light: float, lon_light: float) -> float:
    """관측자에서 광원을 바라보는 방위각(Bearing) 계산 (단위: 라디안)"""
    lat1, lon1 = math.radians(lat_obs), math.radians(lon_obs)
    lat2, lon2 = math.radians(lat_light), math.radians(lon_light)
    dlon = lon2 - lon1
    
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - (math.sin(lat1) * math.cos(lat2) * math.cos(dlon))
    
    initial_bearing = math.atan2(x, y)
    # 0~2pi 범위로 정규화
    bearing_rad = (initial_bearing + 2 * math.pi) % (2 * math.pi)
    return bearing_rad

def calculate_shielding_angle_img(light_coord: tuple, obs_coord: tuple, dem_filepath: str) -> float:
    """
    .img (Raster) 지형 파일을 읽어 광원과 관측자 사이의 최대 지형 차폐각(도)을 계산
    """
    light_lat, light_lon = light_coord
    obs_lat, obs_lon = obs_coord
    
    # 광원과 관측자 사이의 총 거리 계산
    total_dist_km = calculate_distance(obs_lat, obs_lon, light_lat, light_lon)
    if total_dist_km <= 0.1: # 100m 이내면 차폐 무시
        return 0.0
        
    # 선분을 쪼갤 개수
    num_samples = int(total_dist_km / 0.1) 
    num_samples = max(10, min(num_samples, 1000)) 
    
    # 선분 위의 가상 좌표 생성
    lats = np.linspace(light_lat, obs_lat, num_samples)
    lons = np.linspace(light_lon, obs_lon, num_samples)
    
    coords_to_sample = list(zip(lons, lats))
    
    max_angle_deg = 0.0
    
    try:
        with rasterio.open(dem_filepath) as dem:
            elevations = [s[0] * 1e-3 for s in dem.sample(coords_to_sample)]
    
            light_elevation = elevations[0]
    
            for i in range(1, num_samples):
                point_elevation = elevations[i]
                delta_h = point_elevation - light_elevation

                if delta_h <= 0:
                    continue
                    
                dist_km = calculate_distance(light_lat, light_lon, lats[i], lons[i])
                
                if dist_km == 0: continue
                
                angle_rad = math.atan2(delta_h, dist_km)
                angle_deg = math.degrees(angle_rad)
                
                if angle_deg > max_angle_deg:
                    max_angle_deg = angle_deg
                    
    except Exception as e:
        print(f"reading DEM data failed: {e}")
        return 0.0
        
    return max_angle_deg

class LightPollutionModel:
    """광량 계산"""
    
    EPSILON = 1e-5

    def __init__(self, config: EnvironmentConfig):
        self.cfg = config

    @staticmethod
    def _safe_arccos(cos_val: float) -> float:
        """안전한 arccos 계산 (도메인 범위를 벗어나는 것 방지)"""
        return np.arccos(np.clip(cos_val, -1.0, 1.0))

    def _air_mass(self, z: float) -> float:
        """대기 질량 (Air mass) 계산 (Chapman 함수 근사)"""
        cos_z = np.cos(z)
        return 1.0 / (cos_z + 0.025 * np.exp(-11.0 * cos_z))

    def calculate_zenith_0h(self, h: float, z: float, phi: float, L: float, phi_c: float) -> float:
        """광원으로부터 방출된 빛의 천정각 계산"""
        h = max(h, self.EPSILON)
        tan_z = np.tan(z)
        term1 = 1 + tan_z**2
        term2 = (L / h) * ((L / h) - 2 * tan_z * np.cos(phi - phi_c))
        
        cos_val = (term1 + term2)**(-0.5)
        return self._safe_arccos(cos_val)

    def calculate_scattering_angle(self, z: float, z_0h_val: float, L: float, h: float) -> float:
        """산란각(theta) 계산"""
        h = max(h, self.EPSILON)
        cos_z = np.cos(z) if abs(np.cos(z)) > self.EPSILON else self.EPSILON
        cos_z0h = np.cos(z_0h_val) if abs(np.cos(z_0h_val)) > self.EPSILON else self.EPSILON
        
        val = 0.5 * (((L / h)**2) * cos_z * cos_z0h - cos_z0h / cos_z - cos_z / cos_z0h)
        return self._safe_arccos(val)

    def directional_function_B(self, z_0: float) -> float:
        """광원의 방향성 함수 B(Q, q, z_0)"""
        return 2 * self.cfg.Q * (1 - self.cfg.q) * np.cos(z_0) + 0.554 * self.cfg.q * (z_0**4)

    def transmittance(self, h: float, z: float) -> float:
        """고도 h에서 각도 z 방향으로의 단일 경로 투과 계수"""
        air_mass = self._air_mass(z)
        tau_m_h = self.cfg.tau0_m * (1 - np.exp(-h / self.cfg.scale_height))
        tau_total = tau_m_h + self.cfg.aod
        return np.exp(-air_mass * tau_total)

    def total_transmittance(self, h: float, z: float, z_0: float) -> float:
        """빛이 지표면 -> 고도 h -> 관측자로 오는 총 투과율"""
        return self.transmittance(h, z) * self.transmittance(h, z_0)

    def _calculate_scattering(self, h: float, theta: float) -> float:
        """공통 체적 산란 강도 계산 (분자 산란 + 에어로졸 산란)"""
        cos_theta = np.cos(theta)
        
        p_m = 0.75 * (1 + cos_theta**2)
        scatter_m = p_m * (self.cfg.tau0_m / self.cfg.scale_height) * np.exp(-h / self.cfg.scale_height)

        denom = max(1 + self.cfg.g**2 - 2 * self.cfg.g * cos_theta, self.EPSILON)
        p_a = (1 - self.cfg.g**2) / (denom**1.5)
        scatter_a = self.cfg.omega_a * p_a * self.cfg.gamma * self.cfg.aod * np.exp(-self.cfg.gamma * h)
        
        return (scatter_m + scatter_a) / (4 * np.pi)

    # 광량(Radiance) 계산
    def calculate_artificial_light(
        self, z: float, phi: float, phi_c: float, L: float, I_0: float, 
        shield_elevation_deg: float = 0.0  # 지형 차폐각(고도각) 파라미터 추가!
    ) -> float:
        """단일 인공 광원 픽셀에 의한 산란 광량 (지형 차폐 고려)"""
        if I_0 <= 0:
            return 0.0
            
        # 최대 허용 천정각 계산
        max_zenith_rad = np.radians(90.0 - shield_elevation_deg)

        # 흐린 날 구름 반사광 (Kocifaj 모델)
        zenith_0_cloud = self.calculate_zenith_0h(self.cfg.H_max, z, phi, L, phi_c)
        i_cloud = 0.0
        
        # 구름으로 향하는 빛이 산에 막히지 않는지 확인
        if zenith_0_cloud <= max_zenith_rad:
            t_total_cloud = self.total_transmittance(self.cfg.H_max, z, zenith_0_cloud)
            dir_b_cloud = self.directional_function_B(zenith_0_cloud)
            i_cloud = (I_0 * self.cfg.pixel_area * getattr(self.cfg, 'rho_albedo', 0.0) / (np.pi * self.cfg.H_max**2) 
                       * (np.cos(zenith_0_cloud)**4) * dir_b_cloud * t_total_cloud)

        # 맑은 날 대기 산란광
        def integrand(h: float) -> float:
            z_0h_val = self.calculate_zenith_0h(h, z, phi, L, phi_c)
            
            if z_0h_val > max_zenith_rad:
                return 0.0
                
            theta = self.calculate_scattering_angle(z, z_0h_val, L, h)
            gamma_scatter = self._calculate_scattering(h, theta)
            dir_b = self.directional_function_B(z_0h_val)
            t_total = self.total_transmittance(h, z, z_0h_val)
            
            return dir_b * (np.cos(z_0h_val)**2) * t_total / (h**2) * gamma_scatter

        res_integral, _ = quad(integrand, 0.001, self.cfg.H_max, limit=100)
        i_city = (self.cfg.pixel_area * I_0 / np.cos(z)) * res_integral

        C = getattr(self.cfg, 'cloud_fraction', 0.0)
        final_i = (i_city * (1.0 - C)) + (i_cloud * C)

        return final_i

    def calculate_moonlight(self, xi_0: float, phi_0: float, z: float, phi: float) -> float:
        """달빛에 의한 대기 산란 광량 (I_ML)"""
        alpha_deg = self.cfg.moonlight
        m_moon = -12.37 + 0.026 * abs(alpha_deg) + 4e-9 * (alpha_deg**4)
        i_moon_base = 10**(-0.4 * (m_moon + 16.57))

        t_moon_top = self.transmittance(self.cfg.H_max, xi_0)
        cos_theta = np.cos(xi_0)*np.cos(z) + np.sin(z)*np.cos(phi - phi_0)
        theta_moon = self._safe_arccos(cos_theta)

        def integrand(h: float) -> float:
            gamma_ml = self._calculate_scattering(h, theta_moon)
            t_moon_to_h = t_moon_top / self.transmittance(h, xi_0)
            t_h_to_obs = self.transmittance(h, z)
            
            return gamma_ml * t_moon_to_h * t_h_to_obs

        sumation, _ = quad(integrand, 0.01, self.cfg.H_max, limit=100)
        return (i_moon_base / np.cos(z)) * sumation

    def calculate_background(self) -> float:
        """자연 배경 광량 (별빛 등)"""
        return 10 ** ((12.59 - 22.0) / 2.5) / 683

    def calculate_total_radiance(self, i_pixel_list: list[float], i_ml: float, i_bg: float) -> float:
        """총 관측 광량 (다중 산란 보정)"""
        total_j = i_ml / 683 + i_bg + sum(i_pixel_list) * 1e-5
        return total_j * self.cfg.k_multi_scatter
    

# 실행
def run_pipeline(AOD, observer_coordinates, cloud_base_h, seeing, moonlight, observer_angles, moon_angles, pixel_data, dem_path=None, cloud_fraction=0.0):
    """
    모든 물리 계산을 수행하는 핵심 파이프라인 함수
    """
    # 모델 초기화
    config = EnvironmentConfig(aod=AOD, cloud_fraction=cloud_fraction, cloud_base_h=cloud_base_h, seeing=seeing, moonlight=moonlight)
    model = LightPollutionModel(config)
    
    obs_lat, obs_lon = observer_coordinates
    obs_z_rad = np.radians(observer_angles[0])
    obs_phi_rad = np.radians(observer_angles[1])
    
    moon_z_rad = np.radians(moon_angles[0])
    moon_phi_rad = np.radians(moon_angles[1])

    I_pixel = []
    MAX_RADIUS_KM = 30.0

    # 루프
    for data in pixel_data:
        light_lat, light_lon = data["coord"]
        radiance_val = data["radiance"]
        
        L_dist = calculate_distance(obs_lat, obs_lon, light_lat, light_lon)
        if L_dist > MAX_RADIUS_KM:
            continue
            
        L_dist = max(L_dist, 0.01)
        phi_c_rad = calculate_bearing(obs_lat, obs_lon, light_lat, light_lon)

        # 지형 차폐 계산 (경로가 있을 때만)
        shield_deg = 0.0
        if dem_path:
            shield_deg = calculate_shielding_angle_img(
                (light_lat, light_lon), (obs_lat, obs_lon), dem_path
            )

        I_val = model.calculate_artificial_light(
            z=obs_z_rad, phi=obs_phi_rad, phi_c=phi_c_rad, 
            L=L_dist, I_0=radiance_val, shield_elevation_deg=shield_deg
        )
        I_pixel.append(I_val)

    # 결과 합산
    I_ml = model.calculate_moonlight(moon_z_rad, moon_phi_rad, obs_z_rad, obs_phi_rad)
    I_bg = model.calculate_background()
    
    total = model.calculate_total_radiance(I_pixel, I_ml, I_bg)
    
    # 결과 출력
    print(f"최종 하늘 밝기: {total} [W/m^2/sr]")
    print(f"{12.59-2.5 * np.log10(total*683)} [mag/arcsec^2]")
    print(f"시상: {seeing}")
    return total