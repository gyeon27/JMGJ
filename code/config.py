from dataclasses import dataclass
from data_loader import environment_query

@dataclass
class EnvironmentConfig:
    """환경변수"""
    
    pixel_area: float = 0.21**2            # 픽셀 면적 A_0 (km^2)
    tau0_m: float = 0.09                   # 분자 산란(Rayleigh) 광학 두께
    aod: float = 1.0                       # 에어로졸 광학 두께 (AOD)
    scale_height: float = 8.0              # 대기 스케일 헤이트 H_0 (km)
    rho_albedo: float = 0.15               # 구름 반사도 (Albedo)
    cloud_fraction: float = 0.0            # 운량 (0.0 = 완전 맑음, 1.0 = 완전 흐림)
    cloud_base_h: float = 2.0              # 구름 밑면 고도 (km)
    seeing: float = 2.0                    # 시야 깊이
    moonlight: float = 0.0                 # 월광 (0.0 = 없음, 1.0 = 매우 밝음)

    # 에어로졸 특성
    gamma: float = 0.65
    omega_a: float = 0.9
    g: float = 0.65
    
    # 조명 방향성 특성
    Q: float = 0.15
    q: float = 0.15

    @property
    def k_multi_scatter(self) -> float:
        """다중산란 보정 계수"""
        return 1.1 + 0.5 * self.aod
    
    def __post_init__(self):
        """시뮬레이션 한계 고도 설정"""
        if self.cloud_fraction > 0.0:
            self.H_max = 30.0               # 대기 최상단 고도 (km)
        else:
            self.H_max = self.cloud_base_h  # 대기 최상단 고도 (km)
            if self.H_max > 30.0:
                self.H_max = 30.0