from dataclasses import dataclass
from typing import Optional

FIXED_GAMMA = 0.65
FIXED_OMEGA_A = 0.85
FIXED_G = 0.9
FIXED_Q = 0.2
FIXED_Q_DIRECT = 0.5
FIXED_RHO_ALBEDO = 0.5

DEFAULT_MS_A = 1.003796191310424
DEFAULT_MS_B = 1.1800854377233085
MS_A_RANGE = (1.0, 3.0)
MS_B_RANGE = (0.0, 2.0)
DEFAULT_MOON_TRANSMISSION_SCALE = 1.0
MOON_TRANSMISSION_SCALE_RANGE = (0.5, 2.0)
MOON_MODEL_TOP_KM = 30.0
DEFAULT_ART_SCALE = 1.0
ART_SCALE_RANGE = (0.1, 1.5)

# Black Marble VNP46A3/A4 composite radiance unit:
# nWatts / (cm^2 sr). Convert to SI radiance W / (m^2 sr).
BLACK_MARBLE_RADIANCE_UNIT = "nW/(cm^2 sr)"
BLACK_MARBLE_RADIANCE_TO_SI = 1e-5

def effective_cloud_fraction(cloud_fraction: float, cloud_base_h: float) -> float:
    """관측 운량을 모델에 들어갈 유효 구름 영향도로 변환합니다."""
    model_top_km = 30.0
    if cloud_base_h >= model_top_km:
        return 0.0
    c = max(0.0, min(float(cloud_fraction), 1.0))
    return c**2

@dataclass
class EnvironmentConfig:
    """환경변수"""
    
    pixel_area: float = 0.169            # 픽셀 면적 A_0 (km^2)
    tau0_m: float = 0.09                   # 분자 산란(Rayleigh) 광학 두께
    aod: float = 0.3                       # 에어로졸 광학 두께 (AOD)
    scale_height: float = 8.0              # 대기 스케일 헤이트 H_0 (km)
    rho_albedo: float = FIXED_RHO_ALBEDO  # 구름 반사도 (Albedo)
    cloud_fraction: float = 0.0            # 운량 (0.0 = 완전 맑음, 1.0 = 완전 흐림)
    cloud_base_h: float = 2.0              # 구름 밑면 고도 (km)
    seeing: float = 2.0                    # 시야 깊이
    moonlight: float = 0.0                 # API 월광값은 사용하지 않음. 달 밝기는 위상각으로 계산.
    moon_az: float = 0.0                     # 달 방위각 (도)
    moon_zen: float = 90.0                   # 달 천정각 (도)
    moon_phase_angle_deg: float = 180.0      # 달 위상각 (0=망, 180=삭)
    moon_cloud_transmission: float = 1.0      # 현재 고정값. API actual/clearsky 월광 비율은 사용하지 않음.
    moon_transmission_scale: float = DEFAULT_MOON_TRANSMISSION_SCALE
    moon_model_top_km: float = MOON_MODEL_TOP_KM
    art_scale: float = DEFAULT_ART_SCALE      # 위성 인공광 -> 하늘 밝기 변환 스케일

    # 에어로졸 특성. None이면 운량 조건에 맞는 기본 보정값을 사용합니다.
    gamma: Optional[float] = None
    omega_a: Optional[float] = None
    g: Optional[float] = None
    
    # 조명 방향성 특성
    Q: float = FIXED_Q
    q: float = FIXED_Q_DIRECT

    # 다중산란 보정 계수. None이면 운량 조건에 맞는 기본 보정값을 사용합니다.
    ms_a: Optional[float] = None
    ms_b: Optional[float] = None

    @property
    def k_multi_scatter(self) -> float:
        """다중산란 보정 계수"""
        return self.ms_a + self.ms_b * self.aod
    
    def __post_init__(self):
        """시뮬레이션 한계 고도 설정"""
        model_top_km = 30.0
        self.cloud_fraction = max(0.0, min(float(self.cloud_fraction), 1.0))
        self.cloud_base_h = max(0.1, float(self.cloud_base_h))
        self.moon_model_top_km = max(0.1, float(self.moon_model_top_km))
        self.art_scale = max(0.0, float(self.art_scale))

        cloud_weight = effective_cloud_fraction(self.cloud_fraction, self.cloud_base_h)

        if cloud_weight <= 0.0:
            self.H_max = model_top_km
            self.cloud_effect_fraction = 0.0
        else:
            self.H_max = max(0.1, min(self.cloud_base_h, model_top_km))  # 대기 최상단 고도 (km)
            self.cloud_effect_fraction = cloud_weight

        if self.gamma is None:
            self.gamma = FIXED_GAMMA
        if self.omega_a is None:
            self.omega_a = FIXED_OMEGA_A
        if self.g is None:
            self.g = FIXED_G
        if self.ms_a is None:
            self.ms_a = DEFAULT_MS_A
        if self.ms_b is None:
            self.ms_b = DEFAULT_MS_B
