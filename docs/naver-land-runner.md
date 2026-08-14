# 네이버 부동산 수집 러너 설정 (Windows)

## 왜 self-hosted 러너가 필요한가

네이버는 클라우드/데이터센터 IP에서 `land.naver.com` 계열 접속을 **응답 없이 끊습니다**. 403이 아니라 무응답이라 재시도·헤더 위장으로는 우회되지 않습니다.

GitHub 호스팅 러너에서 실제로 측정한 결과:

| 대상 | 결과 |
| --- | --- |
| `www.naver.com` | 200 OK (1.2초) |
| `m.land.naver.com` / `new.land.naver.com` | 타임아웃 |
| `fin.land.naver.com` (Playwright 실브라우저) | `page.goto` 45초 타임아웃 × 3회 → 실패 |

Playwright로 진짜 브라우저를 띄워도 막힙니다. **봇 탐지가 아니라 IP 단계 차단**이라 접속 자체가 안 됩니다.

따라서 수집은 **국내 가정용 회선**에서 실행해야 하고, 이를 자동화하려면 집 PC에 GitHub self-hosted 러너를 붙이면 됩니다.

## 러너 설치

> **주의: 이 단계는 반드시 PowerShell에서 실행합니다. Git Bash가 아닙니다.**
> GitHub가 안내하는 `Invoke-WebRequest`, `Add-Type` 등은 PowerShell 전용 명령이라
> Git Bash에 붙여넣으면 `bash: Invoke-WebRequest: command not found`가 납니다.
> (뒤에 나오는 "로컬에서 직접 돌리기"의 node/git 명령은 Git Bash로 하셔도 됩니다.)

1. GitHub 저장소 → **Settings → Actions → Runners → New self-hosted runner**
2. **Windows / x64** 선택
3. 화면에 나오는 명령을 **PowerShell**에서 그대로 실행 (`config.cmd`까지).
   `--token` 값은 그 페이지에 표시된 것을 써야 하며 약 1시간 후 만료되므로,
   시간이 지났으면 페이지를 새로고침해 새 토큰을 받습니다.
4. 설정 중 질문에 이렇게 답합니다:
   - `Enter the name of the runner group` → 그냥 Enter
   - `Enter the name of runner` → 그냥 Enter (기본값)
   - **`Enter any additional labels` → `naver-scraper` 입력** ← 워크플로가 이 라벨로 러너를 찾습니다
   - `Enter name of work folder` → 그냥 Enter

## 서비스로 등록 (PC 켜져 있으면 자동 실행)

`config.cmd` 실행 중 `Would you like to run the runner as service?` 질문에 `Y`로 답하면 바로 서비스로 등록됩니다.

이미 `N`으로 넘어갔다면, **관리자 권한 PowerShell**에서 러너 폴더로 이동해 아래를 실행합니다:

```powershell
.\svc.cmd install
.\svc.cmd start
```

(`svc.sh`는 Linux·macOS용입니다. Windows에서는 `svc.cmd`를 씁니다.)

상태 확인과 중지는 각각 `.\svc.cmd status`, `.\svc.cmd stop` 입니다.

서비스로 등록하면 로그인하지 않아도 백그라운드에서 돌고, PC 재부팅 후에도 자동으로 뜹니다. 등록하지 않으면 `.\run.cmd`를 실행해둔 창이 열려 있는 동안에만 작업을 받습니다.

## 사전 요구사항

러너 PC에 아래가 설치돼 있어야 합니다:

- **Node.js** (LTS) — 워크플로가 `node`를 직접 호출
- **Git for Windows** — 워크플로가 `shell: bash`(Git Bash)를 사용

## 동작 방식

| 실행 | 범위 | 소요 시간 |
| --- | --- | --- |
| 매일 새벽 2시 (자동) | 서울 전체 구 + 흑석동 | 15~40분 |
| 수동 실행 (기본값) | **강남구만** | 1~2분 |
| 수동 실행 (`seoul` 선택) | 서울 전체 | 15~40분 |

수동 실행은 GitHub 저장소 → **Actions → Update Naver Land listings → Run workflow** 에서 범위를 골라 실행합니다.

**일부 지역만 수집해도 나머지 지역 데이터는 지워지지 않습니다.** 스크립트가 기존 `data/naver-land.json`을 읽어 이번에 수집한 지역만 교체하고 나머지는 그대로 보존합니다(`mergeRegions`). 지역마다 `updatedAt`을 따로 기록하므로, 대시보드에서 "일부 지역은 ○월 ○일 기준"으로 표시됩니다.

## 로컬에서 직접 돌리기

러너 없이 손으로 돌릴 수도 있습니다:

```bash
# 강남구만
NAVER_SCOPE=gangnam node scripts/fetch-naver-land.js

# 서울 전체 (기본값)
node scripts/fetch-naver-land.js

git add data/naver-land.json
git commit -m "chore: 네이버 매물 갱신"
git push
```

Windows PowerShell에서는 환경변수 지정 방식이 다릅니다:

```powershell
$env:NAVER_SCOPE="gangnam"; node scripts/fetch-naver-land.js
```

## 러너가 없을 때의 동작

러너가 등록되지 않은 상태에서 스케줄이 돌면, 작업이 실행되지 못하고 큐에 대기하다가 24시간 뒤 취소됩니다. 데이터가 손상되지는 않습니다. 러너를 설치할 때까지는 위의 "로컬에서 직접 돌리기"로 갱신하면 됩니다.
