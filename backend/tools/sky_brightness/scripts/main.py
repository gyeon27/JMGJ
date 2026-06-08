import argparse
import os
import sys
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(SCRIPT_DIR)))
SRC_DIR = os.path.join(BACKEND_DIR, "src")
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)
from datetime import datetime
import time
import numpy as np
import rasterio

CODE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if CODE_DIR not in sys.path:
    sys.path.insert(0, CODE_DIR)

from app.services.sky_brightness_model.core.config import EnvironmentConfig
from app.services.sky_brightness_model.core.data_loader import environment_query, load_pixel_data_from_h5
from app.services.sky_brightness_model.core.calculator import calculate_directional_shielding, prepare_pixel_geometry, run_pipeline
from cli_common import add_data_args

# main.py ?대? get_time_input ?⑥닔 ?섏젙

def get_time_input():
    """?쒓컙???꾩옱 ?쒓컙?쇰줈 ?좎?, ?좎쭨留??낅젰?좎? ?ъ슜?먯뿉寃?臾삳뒗 ?⑥닔"""
    while True:
        choice = input("?꾩옱 ?좎쭨/?쒓컙???ъ슜?섏떆寃좎뒿?덇퉴? (Y: ?꾩옱, N: ?좎쭨 吏곸젒 ?낅젰): ").strip().upper()
        
        if choice == 'Y':
            # ?꾩옱 ?쒓컙 諛섑솚
            return datetime.now().strftime("%Y-%m-%d %H:00")
            
        elif choice == 'N':
            # ?쒓컙? 臾살? ?딄퀬 ?좎쭨留?臾산린
            custom_date = input("?먰븯???좎쭨瑜??낅젰?섏꽭??(?뺤떇: YYYY-MM-DD HH:MM) [?? 2026-05-18 22:00]: ").strip()
            if len(custom_date) == 16 and custom_date.count('-') == 2 and custom_date.count(':') == 1:
                print(f"-> ?쇨컙 愿묎났??湲곗? ?쒓컙??[{custom_date}] 湲곗??쇰줈 遺꾩꽍?⑸땲??\n")
                return custom_date
            else:
                print("[?ㅻ쪟] ?낅젰 ?뺤떇???щ컮瑜댁? ?딆뒿?덈떎. 'YYYY-MM-DD HH:MM' ?뺤떇?쇰줈 ?낅젰?댁＜?몄슂.\n")
        else:
            print("Y ?먮뒗 N???낅젰?댁＜?몄슂.\n")

def main(args):
    print('\n--- main.py started. ---')
    
    # [?듭떖 ?섏젙 1] 愿痢?醫뚰몴 ?낅젰 ?ㅽ궢 諛⑹? 諛??덉쇅 泥섎━
    while True:
        coord_input = input("Enter observer coordinates (latitude, longitude) [?? 37.5, 126.9]: ").strip()
        
        # 踰꾪띁 臾몄젣濡?鍮?媛믪씠 ?ㅼ뼱?ㅻ㈃ 臾댁떆?섍퀬 ?ㅼ떆 ?낅젰 ?湲?
        if not coord_input:
            continue
            
        try:
            observer_coordinates = tuple(map(float, coord_input.split(",")))
            if len(observer_coordinates) != 2:
                print("[?ㅻ쪟] ?꾨룄? 寃쎈룄 2媛쒖쓽 媛믪쓣 肄ㅻ쭏(,)濡?援щ텇?댁꽌 ?낅젰?댁빞 ?⑸땲??\n")
                continue
            break # ?뺤긽 ?낅젰 ??猷⑦봽 ?덉텧
        except ValueError:
            print(f"[?ㅻ쪟] ?レ옄濡?蹂?섑븷 ???녿뒗 ?뺤떇?낅땲?? ?낅젰媛? '{coord_input}'")
            print("?щ컮瑜??덉떆? 媛숈씠 ?낅젰?댁＜?몄슂. (?? 37.5, 126.9)\n")

    # [?듭떖 ?섏젙 2] 愿痢?媛곷룄 ?낅젰 ?ㅽ궢 諛⑹? 諛??덉쇅 泥섎━
    while True:
        angle_input = input("Enter observer angles (zenith, azimuth) [?? 0.0, 180.0]: ").strip()
        
        if not angle_input:
            continue
            
        try:
            observer_angles = tuple(map(float, angle_input.split(",")))
            if len(observer_angles) != 2:
                print("[?ㅻ쪟] 泥쒖젙媛곴낵 諛⑹쐞媛?2媛쒖쓽 媛믪쓣 肄ㅻ쭏(,)濡?援щ텇?댁꽌 ?낅젰?댁빞 ?⑸땲??\n")
                continue
            break # ?뺤긽 ?낅젰 ??猷⑦봽 ?덉텧
        except ValueError:
            print(f"[?ㅻ쪟] ?レ옄濡?蹂?섑븷 ???녿뒗 ?뺤떇?낅땲?? ?낅젰媛? '{angle_input}'")
            print("?щ컮瑜??덉떆? 媛숈씠 ?낅젰?댁＜?몄슂. (?? 0.0, 180.0)\n")

    # ?쒓컙 ?ㅼ젙 ?⑥닔 ?몄텧
    time_input = get_time_input()
    print(f"\n[?뚮┝] ?ㅼ젙??愿痢??쒓컙: {time_input}\n")

    # ?섍꼍 ?곗씠??荑쇰━
    aod, cloud_fraction, cloud_base_h, seeing, moonlight, moon_angle, moon_phase_angle, moon_cloud_transmission = environment_query(time_input, *observer_coordinates)

    # 愿묒썝 ?곗씠??濡쒕뵫
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

    # 臾쇰━ ?붿쭊 媛??
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
        observer_coordinates=observer_coordinates,    # 愿痢≪옄 ?꾨룄, 寃쎈룄
        observer_angles=observer_angles,            # 愿痢?泥쒖젙媛? 諛⑹쐞媛?
        moon_angles=moon_angle,                     # ??泥쒖젙媛? 諛⑹쐞媛?
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
        Q = input("?꾨줈洹몃옩???ㅽ뻾?섏떆寃좎뒿?덇퉴? (Y/N): ").strip().upper()
        
        if Q == 'Y':
            run_time = time.time()
            main(cli_args)
            print(f"Total execution time: {time.time() - run_time:.2f} seconds")
        elif Q == 'N':
            print("?꾨줈洹몃옩??醫낅즺?⑸땲??")
            break
        else:
            print("Y ?먮뒗 N???낅젰?댁＜?몄슂.\n")
    

