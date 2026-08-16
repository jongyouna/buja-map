# private 저장소 + 무료 GitHub Pages

이 저장소를 **private으로 바꾸면서도** bujamap.kr을 **무료로** 계속 서빙하기 위한 구조와 설정 순서.

## 왜 이 구조가 필요한가

개인 무료 플랜(GitHub Free)의 Pages는 **public 저장소에서만** 켤 수 있다. private 저장소에서 Pages를
쓰려면 GitHub Pro 이상(유료)이 필요하다. 저장소를 그냥 private으로 바꾸면 Pages가 꺼지고 사이트가 내려간다.

그래서 저장소를 둘로 나눈다.

```
[private] jongyouna/buja-map              [public] jongyouna/bujamap-site
  index.html          (원본)                 gh-pages 브랜치
  data/*.json                                  index.html
  scripts/*.js        ← 비공개 유지            data/*.json
  .github/workflows/  ← 비공개 유지            CNAME
  docs/, *.md         ← 비공개 유지            .nojekyll
  firestore.rules     ← 비공개 유지
  커밋 히스토리       ← 비공개 유지          → Pages가 이 브랜치를 서빙 (bujamap.kr)
                     │
                     └── deploy-pages.yml 이 결과물만 골라 force push
```

핵심: **브라우저가 어차피 내려받는 파일(index.html, data/*.json)만** 공개 저장소로 넘어간다.
수집 스크립트, 워크플로, 문서, 커밋 히스토리, 이슈는 private 저장소에 남는다.

배포 브랜치는 매번 **고아 커밋 1개**로 덮어쓴다. 시세 갱신이 하루 수십 번 커밋을 만들어도
공개 저장소 히스토리는 항상 커밋 1개로 유지된다.

## 최초 설정 (한 번만)

### 1. 공개 배포 저장소 만들기

GitHub 웹 UI에서 **완전히 빈** public 저장소를 만든다. 예: `jongyouna/bujamap-site`
(README·라이선스·gitignore 아무것도 체크하지 말 것.)

### 2. 배포 인증 수단 만들기 — 배포 키(권장)

private 저장소의 Actions가 공개 저장소에 push할 권한이 필요하다. **배포 키(deploy key)** 는 저장소
딱 하나에만 붙고 만료가 없어서 PAT보다 안전하다.

로컬에서:

```bash
ssh-keygen -t ed25519 -C "buja-map deploy" -f ./buja-deploy-key -N ""
```

- `buja-deploy-key.pub` (공개키) → **공개 저장소** Settings → Deploy keys → Add deploy key
  → **Allow write access 체크** 후 저장
- `buja-deploy-key` (개인키, `-----BEGIN...` 부터 끝까지 전부) → **private 저장소** Settings →
  Secrets and variables → Actions → New repository secret
  → 이름 `PAGES_DEPLOY_KEY`
- 두 파일은 등록 후 로컬에서 삭제한다.

> **대안 (PAT):** 배포 키 대신 fine-grained PAT도 쓸 수 있다. Resource owner 본인 계정,
> Repository access는 **공개 저장소만**, Repository permissions에서 **Contents: Read and write** 하나면
> 충분하다. 시크릿 이름은 `PAGES_DEPLOY_TOKEN`. 두 시크릿이 다 있으면 배포 키가 우선한다.

### 3. 배포 대상 지정

private 저장소 Settings → Secrets and variables → Actions → **Variables** 탭 → New repository variable

| 이름 | 값 | 필수 |
|---|---|---|
| `PAGES_REPO` | `jongyouna/bujamap-site` | 필수 |
| `PAGES_BRANCH` | `gh-pages` | 선택 (없으면 `gh-pages`) |

### 4. 첫 배포 실행

private 저장소 Actions → **Deploy site** → Run workflow.
성공하면 공개 저장소에 `gh-pages` 브랜치가 생기고 `index.html`, `data/`, `CNAME`, `.nojekyll`이 들어 있다.

### 5. 공개 저장소에서 Pages 켜기

공개 저장소 Settings → Pages → Build and deployment
→ Source: **Deploy from a branch** → Branch: `gh-pages`, 폴더 `/ (root)` → Save.

`https://jongyouna.github.io/bujamap-site/` 로 먼저 화면이 뜨는지 확인한다.
(이 단계에선 커스텀 도메인이 아직 private 저장소에 묶여 있어 Pages가 도메인 경고를 낼 수 있다. 정상.)

### 6. 도메인 옮기고 private으로 전환 — **순서 중요**

같은 커스텀 도메인은 저장소 하나에만 붙일 수 있다. 반드시 이 순서로 한다.

1. **private 저장소** Settings → Pages → 커스텀 도메인 `bujamap.kr` **제거** → Save
2. **private 저장소** Settings → General → 맨 아래 Danger Zone → **Change visibility → Private**
   (무료 플랜이면 이 시점에 Pages가 자동으로 꺼진다)
3. **공개 저장소** Settings → Pages → Custom domain에 `bujamap.kr` 입력 → Save
   → DNS 확인이 끝나면 **Enforce HTTPS** 체크
4. 몇 분 뒤 https://bujamap.kr 접속 확인

**DNS는 손댈 필요 없다.** 같은 계정의 project page라 apex A 레코드(185.199.108~111.153) /
`www` CNAME(`jongyouna.github.io`) 값이 그대로다. 인증서 재발급에 최대 수십 분 걸릴 수 있다.

**Firebase도 손댈 필요 없다.** 승인된 도메인은 저장소가 아니라 도메인 기준이고 `bujamap.kr`은 그대로다.

## 이후 동작

| 언제 | 무슨 일이 |
|---|---|
| 내가 `index.html`을 main에 push | `deploy-pages.yml`의 push 트리거로 즉시 배포 |
| 데이터 갱신 워크플로가 데이터를 커밋 | 각 워크플로의 `deploy` 잡이 `deploy-pages.yml`을 호출해 배포 |
| 데이터에 변화가 없을 때 | 커밋도 배포도 하지 않음 (`changed=false`) |
| 수동 배포가 필요할 때 | Actions → Deploy site → Run workflow |

데이터 갱신 워크플로가 배포를 **직접 호출**하는 이유: Actions의 기본 `GITHUB_TOKEN`으로 만든 push는
다른 워크플로의 `push` 트리거를 발동시키지 않는다(무한 루프 방지 정책). 그래서 push 이벤트로는
"데이터 커밋 → 배포"를 엮을 수 없고, `workflow_call`로 이어붙였다.

## 주의: 진짜 무료로 유지하려면 Actions 사용량도 봐야 한다

Pages 호스팅 자체는 위 구조로 무료다. 하지만 **Actions 실행 시간은 public에서 무제한, private에서
무료 플랜 월 2,000분**으로 바뀐다. 지금 크론을 그대로 두면 한도를 넘길 수 있다.

| 워크플로 | 월 실행 횟수(대략) | 월 소요(대략) |
|---|---|---|
| `update-etf-quotes` (평일 10분마다) | ~950 | 950~1,900분 |
| 그에 딸린 `deploy` 잡 | ~950 | ~950분 |
| `update-etf-anchors` (평일 1회) | 22 | 110~330분 |
| `update-data` (매일 1회) | 30 | 30~60분 |
| `update-naver-land` | 30 | **0분** (self-hosted는 사용량 미차감) |

> Actions 청구는 잡 하나당 **1분 단위 올림**이라, 30초짜리 배포 잡도 1분으로 계산된다.

### 한도 안에 넣는 방법 (택1)

1. **시세 갱신 주기를 늘린다 (가장 간단).**
   `update-etf-quotes.yml`의 크론을 `*/10` → `*/30`으로 바꾸면 하루 43회가 15회로 줄어
   전체가 월 1,000분 안쪽으로 들어온다.
   ```yaml
   - cron: "*/30 0-6 * * 1-5"
   ```
2. **시세 갱신도 self-hosted 러너로 옮긴다.** 네이버 수집용 러너가 이미 있으므로
   `runs-on: [self-hosted, naver-scraper]`로 바꾸면 사용량이 0이 된다. 단, 장중(KST 09~16시)에
   그 PC가 켜져 있어야 한다.
3. **Settings → Billing에서 사용량 알림을 켜 둔다.** 한도를 넘으면 예약 워크플로가 그냥 멈춘다.

## 대안: Cloudflare Pages (저장소를 아예 공개하지 않는 방법)

GitHub Pages 대신 Cloudflare Pages를 쓰면 **private 저장소를 그대로 연결**해 무료로 배포할 수 있다.
공개 미러 저장소가 아예 필요 없고, 배포에 Actions 분을 쓰지도 않는다.

- Cloudflare 대시보드 → Workers & Pages → Create → Connect to Git → private 저장소 선택
- Build command 없음(정적), Build output directory `/`
- Custom domains에 `bujamap.kr` 등록 (DNS를 Cloudflare 네임서버로 옮겨야 함)

바꾸는 게 DNS라서 손이 조금 더 가지만, "소스는 완전 비공개"가 더 중요하면 이쪽이 낫다.
데이터 수집 워크플로의 Actions 분 문제는 이 경우에도 그대로 남는다.

## 공개 저장소에 남는 것 / 남지 않는 것

| | 공개됨 | 비공개 |
|---|---|---|
| `index.html` | O (브라우저가 어차피 받는 파일) | |
| `data/*.json` | O (사이트가 fetch하는 파일) | |
| `scripts/`, `.github/workflows/`, `docs/`, `*.md`, `firestore.rules` | | O |
| 커밋 히스토리·이슈·PR | | O (공개 저장소는 배포 커밋 1개만) |

`index.html` 안의 Firebase 웹 API 키는 원래 공개돼도 되는 값이고, 실제 접근 통제는 Firestore 보안
규칙이 한다 — [docs/admin-tab.md](admin-tab.md) 참고. 다만 **API 키·시크릿을 새로 넣을 때는
`index.html`이 공개된다는 전제**로 판단해야 한다.
