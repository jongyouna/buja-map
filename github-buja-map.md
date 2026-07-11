# github-buja-map: GitHub Pages 대시보드 배포 가이드

buja-map 프로젝트를 GitHub에 올리고 GitHub Pages로 호스팅하며 겪었던 과정과 다음에 비슷한 정적 대시보드를 만들 때 그대로 재사용할 수 있는 체크리스트.

## 1. 프로젝트 구조 (재사용 템플릿)

```
프로젝트/
  index.html              # 대시보드 UI (Chart.js CDN 사용, 순수 정적 파일)
  data/
    data.json              # 매일 갱신되는 데이터 (정적 JSON)
  scripts/
    fetch-data.js           # 외부 API에서 데이터 수집 → data.json 생성 (Node, 외부 의존성 없이 fetch만 사용)
  server.js                 # 로컬 개발용 정적 서버 (node server.js → localhost:8080)
  package.json              # "update": node scripts/fetch-data.js
  .github/workflows/
    update-data.yml         # 매일 cron으로 fetch-data.js 실행 + data.json 자동 커밋
  .gitignore
```

포인트: GitHub Pages는 **정적 파일만** 서빙하므로, 서버 로직(fetch-data.js) 자체는 Pages에서 실행되지 않는다. 대신 GitHub Actions가 주기적으로 스크립트를 실행하고 결과 JSON을 repo에 커밋 → Pages가 그 최신 JSON을 서빙하는 방식으로 "매일 업데이트"를 구현한다.

## 2. 데이터 소스 선정 시 체크할 것

- 브라우저에서 직접 fetch할 수 있는지(CORS) 먼저 확인. 막혀 있으면(Stooq처럼 봇 차단) 클라이언트 사이드 fetch는 포기하고 서버/Actions에서만 수집.
- Yahoo Finance 비공식 API(`https://query1.finance.yahoo.com/v8/finance/chart/{TICKER}?range=...&interval=...`)는 User-Agent 헤더만 있으면 대체로 응답함(공식 API 아니므로 변경/차단 가능성 있음을 인지).
- FRED는 `https://fred.stlouisfed.org/graph/fredgraph.csv?id={SERIES_ID}` 로 키 없이 CSV 직접 다운로드 가능.

## 3. GitHub 저장소 생성 및 푸시 절차

1. **저장소는 GitHub 웹 UI에서 직접 생성**하는 것이 가장 확실함. `gh` CLI나 API로 자동 생성하려면 토큰에 계정 단위 "Administration: Read and write" 권한 + "All repositories" 접근이 필요한데, fine-grained 토큰은 보통 특정 저장소만 스코프하므로 애초에 없는 저장소를 대상으로 지정할 수 없어 실패한다.
   - 이름: `{repo-name}` (project page로 호스팅할 경우) 또는 `{github계정명}.github.io` (계정명과 정확히 일치해야 user/org page로 동작)
   - Public으로 생성 (무료 개인 계정은 Pages가 public repo만 지원)
   - README/gitignore/license 등 아무것도 추가하지 않은 완전 빈 저장소로 생성 (로컬 커밋과 히스토리 충돌 방지)

2. **fine-grained Personal Access Token 권한** (Settings → Developer settings → Fine-grained tokens):
   - Resource owner: 본인 계정
   - Repository access: 해당 저장소 선택 (저장소가 이미 존재해야 선택 가능)
   - Repository permissions:
     - **Contents: Read and write** (코드 push)
     - **Administration: Read and write** (일부 API 동작에 필요)
     - **Workflows: Read and write** (`.github/workflows/*.yml` 파일을 포함해 push할 경우 필수 — 빠뜨리면 `refusing to allow a Personal Access Token to create or update workflow ... without workflow scope` 에러 발생)

3. **로컬에서 push**:
   ```bash
   git init -b main
   git add -A
   git commit -m "..."
   git remote add origin https://{github계정명}:{TOKEN}@github.com/{github계정명}/{repo}.git
   git push -u origin main
   # 이후 보안을 위해 토큰 없는 URL로 원복 (로컬 .git/config에 토큰 평문 저장 방지)
   git remote set-url origin https://github.com/{github계정명}/{repo}.git
   ```

## 4. GitHub Pages 활성화

- API(`POST /repos/{owner}/{repo}/pages`)로 시도했으나 fine-grained 토큰에 **Pages 전용 권한**이 별도로 필요해 403 발생 → **웹 UI로 켜는 것이 가장 빠름**:
  1. 저장소 → Settings → Pages
  2. Build and deployment → Source: **Deploy from a branch**
  3. Branch: `main`, 폴더: `/ (root)` → Save
- 배포 확인: `GET /repos/{owner}/{repo}/pages` API 응답의 `"status": "built"` 및 `html_url` 확인, 또는 `curl -o /dev/null -w "%{http_code}" {html_url}` 로 200 확인
- URL 형태: project page면 `https://{계정명}.github.io/{repo}/`

## 5. 매일 자동 갱신 (GitHub Actions)

`.github/workflows/update-data.yml` 핵심 구조:

```yaml
on:
  schedule:
    - cron: "0 21 * * *"   # UTC 기준 — KST는 UTC+9이므로 KST 06:00 = UTC 21:00 (전날)
  workflow_dispatch: {}      # 수동 실행 버튼 추가

permissions:
  contents: write            # data.json 커밋에 필요

jobs:
  update-data:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: node scripts/fetch-data.js
      - run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/data.json
          git diff --cached --quiet && echo "no changes" || git commit -m "chore: daily data update"
          git push
```

- `permissions: contents: write`를 workflow 파일에 명시해야 push가 가능함 (repo 기본 설정이 read-only일 수 있음)
- cron 시간은 UTC 기준이므로 KST로 환산해서 적을 것

## 6. 겪었던 삽질 순서 (다음엔 스킵 가능)

1. Stooq CSV로 주가를 받으려 했으나 JS 챌린지로 차단됨 → Yahoo Finance 비공식 API로 전환
2. 로컬 정적 서버 스크립트 초안에서 `path.join(__dirname, "/")`가 trailing slash를 제거해 루트 경로(`/`)가 404 나는 버그 → 원본 `req.url`로 먼저 `/` 여부를 판단하도록 수정
3. `gh` CLI 미설치 + git 전역 인증 없음 → PAT 방식으로 전환
4. PAT로 저장소 생성 API 호출 → 403 (Administration 권한/스코프 문제) → 웹 UI에서 직접 빈 저장소 생성으로 전환
5. push 시 403 Permission denied → 토큰에 Contents: Read/write 권한 누락 → 추가 후 재시도
6. push 시 workflow 파일 때문에 재차 거부 → Workflows: Read/write 권한 추가로 해결
7. Pages 활성화 API 호출 → 403 (Pages 전용 권한 없음) → 웹 UI에서 직접 켜는 것으로 전환

**결론**: 처음부터 fine-grained PAT를 발급할 때 `Contents`, `Administration`, `Workflows` 세 가지를 Read and write로 미리 켜두면 3~7번 왕복을 줄일 수 있다. 단, 저장소 생성과 Pages 활성화는 API보다 웹 UI가 더 빠르고 확실하다.
