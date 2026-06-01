# JMGJ

JMGJ는 관측 위치와 시간을 기준으로 밤하늘을 시각화하는 웹 기반 천체 관측 도구입니다. 
프론트엔드는 Stellarium Web Engine을 이용해 천구, 별, 행성, 달, 태양, 딥스카이 천체를 렌더링하고, 백엔드는 주소 검색과 역지오코딩을 담당합니다.

## 주요 기능

- Stellarium Web Engine 기반 천구 렌더링
- 관측 시간 변경, 현재 시간 적용, 일시정지, 1x/5x/10x/100x/1000x 배속 재생
- 관측 위치 직접 선택, 주소 검색, 브라우저 현재 위치 적용
- 별, 행성, 달, 태양, 메시에/NGC/IC 등 딥스카이 천체 검색
- 선택한 천체의 위치, 별칭, 광도/거리/분류/위상 정보 표시
- 별자리선, 지평좌표, 대기, 지평, 딥스카이 표시 토글
- Bright Star Catalog와 Stellarium skyculture/skydata 에셋 활용

## 기술 스택

- Frontend: Next.js, React, TypeScript
- Sky engine: Stellarium Web Engine, WebAssembly
- Backend: FastAPI, Uvicorn, HTTPX
- Geocoding: Kakao Local API, VWorld API, OpenStreetMap Nominatim, Photon

## 프로젝트 구조

```text
JMGJ/
├─ frontend/
│  ├─ components/SkyViewer/      # 천구 렌더링, 조작 패널, 지도 선택, 천체 정보 UI
│  ├─ pages/                     # Next.js Pages Router
│  ├─ public/catalogs/           # Bright Star Catalog 데이터
│  └─ public/stellarium/         # Stellarium Web Engine, skydata, skyculture, 텍스처
└─ backend/
   └─ src/app/
      ├─ api/endpoints/geocode.py # 주소 검색 / 역지오코딩
      ├─ api/router.py
      └─ main.py                  # FastAPI 앱 엔트리포인트
```

## 실행 방법

### 1. 백엔드 실행

```powershell
cd backend
python -m pip install -r src/app/requirements.txt
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 --app-dir src
```

백엔드는 기본적으로 `http://127.0.0.1:8000`에서 실행됩니다.

### 2. 프론트엔드 실행

```powershell
cd frontend
npm.cmd install
npm.cmd run dev
```

프론트엔드는 기본적으로 `http://localhost:3000`에서 실행됩니다.

## 환경 변수

백엔드 환경 변수는 `backend/src/app/.env`에 둘 수 있습니다.

```env
KAKAO_REST_API_KEY=your-kakao-rest-api-key
VWORLD_API_KEY=your-vworld-api-key
VWORLD_API_REFERER=http://localhost:3000
FRONTEND_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
```

프론트엔드는 필요하면 `frontend/.env.local`에 지오코딩 백엔드 주소를 지정할 수 있습니다.

```env
NEXT_PUBLIC_GEOCODE_BASE_URL=http://127.0.0.1:8000/api/geocode
```

개발 환경에서는 로컬 백엔드를 우선 사용하고, 연결이 실패하면 배포된 백엔드 주소도 시도합니다.

## API

현재 FastAPI 라우터에 연결된 API는 `/api/geocode`입니다.

### 주소 검색

```http
GET /api/geocode?query=서울특별시청
```

응답 예시:

```json
[
  {
    "display_name": "서울특별시청, 서울특별시 중구 세종대로 110",
    "name": "서울특별시청",
    "lat": "37.5665",
    "lon": "126.9780",
    "source": "kakao_address"
  }
]
```

주소 검색은 설정된 API 키에 따라 Kakao, VWorld를 먼저 사용하고, 없거나 실패하면 Nominatim/Photon 기반 검색으로 넘어갑니다. 결과는 짧게 캐시됩니다.

### 역지오코딩

```http
GET /api/geocode/reverse?lat=37.5665&lon=126.9780
```

응답 예시:

```json
{
  "display_name": "서울특별시 중구 세종대로 110",
  "name": "서울특별시 중구 세종대로 110",
  "lat": "37.5665",
  "lon": "126.9780",
  "source": "kakao"
}
```

브라우저의 현재 위치 버튼은 위도/경도를 받아 관측 위치에 적용합니다. 현재 위치의 주소명 자동 표시는 개인정보성 좌표 전송 동의가 필요해 아직 기본 동작에는 포함하지 않았습니다.

## 주요 프론트엔드 파일

- `frontend/components/SkyViewer/SkyViewer.tsx`: Stellarium 엔진 초기화, 천체 검색/선택, 시간/위치 적용
- `frontend/components/SkyViewer/SkyViewerControls.tsx`: 좌측 조작 패널, 검색 자동완성, 시간 선택 UI
- `frontend/components/SkyViewer/LocationPicker.tsx`: 지도 기반 위치 선택, 주소 검색, 현재 위치 적용
- `frontend/components/SkyViewer/ObjectInfoPanel.tsx`: 선택 천체 정보 패널
- `frontend/components/SkyViewer/coordinates.ts`: 좌표 변환, 천체 정보 추출, 광도/거리/위상 표시값 생성
- `frontend/components/SkyViewer/engineControls.ts`: Stellarium Web Engine 모듈 설정과 토글 제어
- `frontend/components/SkyViewer/skyCatalog.ts`: Bright Star Catalog, 별 이름/별칭, 딥스카이 검색 데이터

## 검증 명령

```powershell
cd frontend
npm.cmd run lint
npm.cmd run build
```

## 참고

- `frontend/public/stellarium/landscapes/guereins/`에는 Stellarium 기본 지평 이미지가 보관되어 있지만, 현재 화면에서는 엔진의 `zero` 지평선을 사용합니다.
- `backend/src/app/api/endpoints/coords.py`, `twilight.py`, `difficulty.py` 파일은 존재하지만 현재 `api/router.py`에는 연결되어 있지 않습니다.
