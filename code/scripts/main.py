import argparse
import os
import sys
from datetime import datetime
import time
import numpy as np
import rasterio

CODE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if CODE_DIR not in sys.path:
    sys.path.insert(0, CODE_DIR)

from core.config import EnvironmentConfig
from core.data_loader import environment_query, load_pixel_data_from_h5
from core.calculator import calculate_directional_shielding, prepare_pixel_geometry, run_pipeline
from cli_common import add_data_args

# main.py 내부 get_time_input 함수 수정

def get_time_input():
    """시간을 현재 시간으로 할지, 날짜만 입력할지 사용자에게 묻는 함수"""
    while True:
        choice = input("현재 날짜/시간을 사용하시겠습니까? (Y: 현재, N: 날짜 직접 입력): ").strip().upper()
        
        if choice == 'Y':
            # 현재 시간 반환
            return datetime.now().strftime("%Y-%m-%d %H:00")
            
        elif choice == 'N':
            # 시간은 묻지 않고 날짜만 묻기
            custom_date = input("원하는 날짜를 입력하세요 (형식: YYYY-MM-DD HH:MM) [예: 2026-05-18 22:00]: ").strip()
            if len(custom_date) == 16 and custom_date.count('-') == 2 and custom_date.count(':') == 1:
                print(f"-> 야간 광공해 기준 시간인 [{custom_date}] 기준으로 분석합니다.\n")
                return custom_date
            else:
                print("[오류] 입력 형식이 올바르지 않습니다. 'YYYY-MM-DD HH:MM' 형식으로 입력해주세요.\n")
        else:
            print("Y 또는 N을 입력해주세요.\n")

def main(args):
    print('\n--- main.py started. ---')
    
    # [핵심 수정 1] 관측 좌표 입력 스킵 방지 및 예외 처리
    while True:
        coord_input = input("Enter observer coordinates (latitude, longitude) [예: 37.5, 126.9]: ").strip()
        
        # 버퍼 문제로 빈 값이 들어오면 무시하고 다시 입력 대기
        if not coord_input:
            continue
            
        try:
            observer_coordinates = tuple(map(float, coord_input.split(",")))
            if len(observer_coordinates) != 2:
                print("[오류] 위도와 경도 2개의 값을 콤마(,)로 구분해서 입력해야 합니다.\n")
                continue
            break # 정상 입력 시 루프 탈출
        except ValueError:
            print(f"[오류] 숫자로 변환할 수 없는 형식입니다. 입력값: '{coord_input}'")
            print("올바른 예시와 같이 입력해주세요. (예: 37.5, 126.9)\n")

    # [핵심 수정 2] 관측 각도 입력 스킵 방지 및 예외 처리
    while True:
        angle_input = input("Enter observer angles (zenith, azimuth) [예: 0.0, 180.0]: ").strip()
        
        if not angle_input:
            continue
            
        try:
            observer_angles = tuple(map(float, angle_input.split(",")))
            if len(observer_angles) != 2:
                print("[오류] 천정각과 방위각 2개의 값을 콤마(,)로 구분해서 입력해야 합니다.\n")
                continue
            break # 정상 입력 시 루프 탈출
        except ValueError:
            print(f"[오류] 숫자로 변환할 수 없는 형식입니다. 입력값: '{angle_input}'")
            print("올바른 예시와 같이 입력해주세요. (예: 0.0, 180.0)\n")

    # 시간 설정 함수 호출
    time_input = get_time_input()
    print(f"\n[알림] 설정된 관측 시간: {time_input}\n")

    # 환경 데이터 쿼리
    aod, cloud_fraction, cloud_base_h, seeing, moonlight, moon_angle, moon_phase_angle, moon_cloud_transmission = environment_query(time_input, *observer_coordinates)

    # 광원 데이터 로딩
    print("satellite data loading...")
    pixel_data = load_pixel_data_from_h5(args.h5, observer_coordinates, max_radius_km=args.radius_km)
    
    if not pixel_data:
        print("nothing loaded. check the file path and data format.")
        return

    with rasterio.open(args.dem) as src:
        dem_data = (src.read(1), src.transform)

    pixel_data = prepare_pixel_geometry(
        pixel_data,
        observer_coordinates,
        max_radius_km=args.radius_km,
        dem_data=dem_data,
        keep_radiance_fraction=args.keep_radiance_fraction,
        min_pixels=args.min_pixels,
        max_pixels=args.max_pixels,
    )

    moon_shield_deg = calculate_directional_shielding(
        observer_coordinates,
        moon_angle[1],
        dem_data[0],
        dem_data[1],
        max_dist_km=args.radius_km,
    )

    # 물리 엔진 가동
    print("calculating...")
    
    my_config = EnvironmentConfig(
        aod=aod,
        cloud_fraction=cloud_fraction,
        cloud_base_h=cloud_base_h,
        seeing=seeing,
        moonlight=moonlight,
        moon_phase_angle_deg=moon_phase_angle,
        moon_cloud_transmission=moon_cloud_transmission,
    )

    final_radiance = run_pipeline(
        observer_coordinates=observer_coordinates,    # 관측자 위도, 경도
        observer_angles=observer_angles,            # 관측 천정각, 방위각
        moon_angles=moon_angle,                     # 달 천정각, 방위각
        pixel_data=pixel_data,
        dem_data=dem_data,
        config=my_config,
        precalc_moon_shield=moon_shield_deg,
        max_radius_km=args.radius_km,
    )
    if final_radiance <= 0:
        print("simulation completed, but radiance is zero or negative. Check input angles/data.")
        return

    mag = 12.59 - 2.5 * np.log10(final_radiance * 683)
    print("simulation completed.")
    print(f"Predicted magnitude: {mag:.2f}")
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run one interactive model prediction.")
    add_data_args(parser, include_csv=False)
    cli_args = parser.parse_args()

    while True:
        Q = input("프로그램을 실행하시겠습니까? (Y/N): ").strip().upper()
        
        if Q == 'Y':
            run_time = time.time()
            main(cli_args)
            print(f"Total execution time: {time.time() - run_time:.2f} seconds")
        elif Q == 'N':
            print("프로그램을 종료합니다.")
            break
        else:
            print("Y 또는 N을 입력해주세요.\n")
    
