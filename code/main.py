import os
from data_loader import *
from calculator import run_pipeline

def main():
    print('main.py started.')
    time_input = input("Enter simulation time (YYYY-MM-DD HH:MM): ")
    observer_coordinates = tuple(map(float, input("Enter observer coordinates (latitude, longitude): ").split(",")))
    observer_angles = tuple(map(float, input("Enter observer angles (zenith, azimuth): ").split(",")))
    moon_angles = tuple(map(float, input("Enter moon angles (zenith, azimuth): ").split(",")))

    aod, cloud_fraction, cloud_base_h, seeing, moonlight = environment_query(time_input, *observer_coordinates)

    H5_FILE_PATH = r"C:\Users\yun09\Desktop\제곽\2026\1.연구\2.전람회\전람회\전람회\광공해\VNP46A3.A2026001.h30v05.002.2026041165901.h5"  # 위성 데이터
    DEM_IMG_PATH = r"C:\Users\yun09\Desktop\제곽\2026\1.연구\2.전람회\전람회\전람회\한반도\한반도90m_GRS80.img"     # 지형 데이터

    # 광원 데이터 로딩
    print("satellite data loading...")
    pixel_data = load_pixel_data_from_h5(H5_FILE_PATH)
    
    if not pixel_data:
        print("nothing loaded. check the file path and data format.")
        return

    # 물리 엔진 가동
    print("calculating...")
    
    final_radiance = run_pipeline(
        AOD=aod,                                    # 에어로졸 광학 두께
        cloud_fraction=cloud_fraction,              # 운량 (0=맑음)
        cloud_base_h=cloud_base_h,                  # 구름 밑면 고도 (km)
        seeing=seeing,                              # 시야 깊이
        moonlight=moonlight,                        # 월광
        observer_coordinates=observer_coordinates,  # 관측자 위도, 경도
        observer_angles=observer_angles,            # 관측 천정각, 방위각
        moon_angles=moon_angles,                    # 달 천정각, 방위각
        pixel_data=pixel_data,
        dem_path=DEM_IMG_PATH
    )

    print("simulation completed.")

if __name__ == "__main__":
    main()