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

## 실행 방법 두 가지

### 1) 창 띄워놓고 실행 (권한 불필요, 테스트용)

```powershell
.\run.cmd
```

이 창이 열려 있는 동안에만 작업을 받습니다. 창을 닫거나 재부팅하면 멈춥니다.

### 2) 서비스로 등록 (PC가 켜져 있으면 자동 실행)

`config.cmd` 실행 중 `Would you like to run the runner as service?`에 `Y`로 답하면 등록됩니다. 단, **관리자 권한 PowerShell이 아니면** `Needs Administrator privileges for configuring runner as windows service.`로 실패합니다.

> **주의: Windows 러너 패키지에는 `svc.cmd`/`svc.sh`가 없습니다.**
> `svc.sh`는 Linux·macOS 전용입니다. Windows에서 `.\svc.cmd start`를 실행하면
> `CommandNotFoundException`이 납니다. 서비스 등록은 `config.cmd`가 직접 처리합니다.

이미 `run.cmd`로 돌리고 있다면 아래 순서로 전환합니다.

**① 실행 중인 `run.cmd` 중지** — 해당 창에서 `Ctrl+C`. 서비스와 동시에 뜨면 충돌합니다.

**② 새 등록 토큰 받기** — Settings → Actions → Runners → New self-hosted runner 페이지의 `--token` 값 (약 1시간 후 만료)

**③ 관리자 권한 PowerShell**에서 설정을 다시 하며 서비스로 붙입니다:

```powershell
cd C:\Users\<사용자명>\actions-runner
.\config.cmd --url https://github.com/jongyouna/buja-map --token <새 토큰> --labels naver-scraper --runasservice --replace --unattended
```

- `--labels naver-scraper`: 반드시 포함. 빠지면 작업이 큐에 걸린 채 실행되지 않습니다
- `--replace`: 같은 이름으로 이미 등록된 러너를 대체
- `--runasservice`: 서비스로 설치 (기본 계정 `NT AUTHORITY\NETWORK SERVICE`)

> `config.cmd`는 `.ps1`이 아니라 배치 파일이므로, PowerShell 실행 정책(`Restricted`)의 영향을 받지 않습니다.

**④ 확인**

```powershell
Get-Service actions.runner.*
```

`Status: Running`이면 정상이고, GitHub Runners 페이지에서도 Idle로 보여야 합니다.

### 서비스 전환 시 주의점

- **PC가 깨어 있어야 합니다.** 서비스로 등록해도 예약 시각에 절전/최대 절전 상태면 실행되지 않습니다. 전원 설정에서 절전을 끄거나 해당 시간에 깨어나도록 설정하세요. 로그인 상태일 필요는 없습니다.
- **첫 실행은 더 걸립니다.** Playwright는 Chromium을 계정별 프로필(`%LOCALAPPDATA%\ms-playwright`)에 캐시합니다. 서비스 계정은 프로필이 다르므로 약 130MB를 한 번 다시 받습니다.
- **본인 계정으로 돌리려면** 아래처럼 지정할 수 있습니다(캐시 공유 가능, 대신 비밀번호 필요). 특별한 이유가 없으면 기본값을 권장합니다:

  ```powershell
  .\config.cmd --url https://github.com/jongyouna/buja-map --token <새 토큰> --labels naver-scraper --runasservice --windowslogonaccount "$env:COMPUTERNAME\<사용자명>" --windowslogonpassword "<비밀번호>" --replace --unattended
  ```

## 라벨 확인

워크플로는 `naver-scraper` 라벨로 러너를 찾습니다. 설정 중 `Enter any additional labels` 단계를 그냥 넘겼다면, Settings → Actions → Runners에서 해당 러너를 클릭해 라벨을 추가하면 됩니다. **라벨이 없으면 작업이 큐에 걸린 채 실행되지 않습니다.**

## 사전 요구사항

러너 PC에 아래가 설치돼 있어야 합니다:

- **Node.js** (LTS) — 워크플로가 `node`를 직접 호출
- **Git for Windows** — `actions/checkout`과 커밋 단계가 `git`을 사용

### 워크플로가 `shell: cmd`를 쓰는 이유

윈도우 러너에서 다른 셸은 각각 아래 문제로 실패합니다(둘 다 실제로 겪은 오류입니다):

| 셸 | 증상 | 원인 |
| --- | --- | --- |
| `bash` | `bash: command not found` | Git for Windows가 `bash.exe`를 `C:\Program Files\Git\bin`에 두는데 PATH에는 `cmd` 폴더만 추가됨 |
| `powershell` | `PSSecurityException` / `UnauthorizedAccess` | 기본 실행 정책이 `Restricted`라 스텝 스크립트(`.ps1`) 실행이 차단됨 |

`cmd`는 실행 정책의 영향을 받지 않고 항상 존재하므로, 러너 PC 설정을 바꾸지 않아도 동작합니다. 나중에 러너를 서비스 계정(`NETWORK SERVICE`)으로 돌려도 같은 이유로 안전합니다.

PowerShell을 굳이 쓰고 싶다면 러너 PC에서 실행 정책을 완화해야 합니다:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

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
