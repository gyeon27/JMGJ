# JMGJ

사용자가 입력한 위치를 기반으로 천체 관측 환경을 분석하고,  
관측 난이도를 시각적으로 제공하는 웹 기반 도구입니다.

---

## 주요 기능

- 장소명 입력 → 위도/경도 자동 변환 (OpenStreetMap Nominatim API)
- SkyViewer를 통한 천구 시각화
- 위치 기반 관측 환경 분석 (개발 예정)
- 관측 난이도 계산 기능 (개발 예정)

---

## 기술 스택

- Frontend: Next.js (React, TypeScript)
- Backend: FastAPI (Python)
- API: OpenStreetMap Nominatim

---

## 프로젝트 구조

frontend/        # Next.js 기반 프론트엔드
backend/         # FastAPI 기반 백엔드

---

## 실행 방법

### 1. Backend 실행

cd backend
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 --app-dir src

### 2. Frontend 실행

cd frontend  
npm install  
npm.cmd run dev

### 3. 접속

http://localhost:3000

---

## API

### GET /api/geocode

사용자가 입력한 장소명을 위도/경도로 변환합니다.

요청 예시:  
/api/geocode?query=seoul

응답 예시:

[
  {
    "lat": "37.5666791",
    "lon": "126.9782914"
  }
]

---

## 향후 개발 계획

- 위치 기반 천체 관측 난이도 계산 알고리즘 구현
- 사용자 입력 자동완성 기능 추가
- API 요청 캐싱 및 성능 최적화
- 관측 환경 시각화 기능 확장