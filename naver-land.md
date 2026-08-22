# 네이버 부동산 매물 갱신 규칙

네이버 부동산 매물 수집·저장·관리자 탭 노출 기능을 고도화하기 위한 규칙 정의 문서.
관련 코드: `scripts/fetch-naver-land.js`, `data/naver-land*.json`, `index.html`
(`#newListingsPanel`, `급매 Now!` 탭). 러너 설정은 `docs/naver-land-runner.md` 참고.

## 데이터 파일 구조

| 파일 | 역할 | 키 단위 |
|---|---|---|
| `data/naver-land.json` | 최신 스냅샷 (지역 → 단지×면적×거래유형 행) | `regions[].complexes[]` |
| `data/naver-land-daily.json` | 날짜별 집계 스냅샷 + 그날의 "신규 단지" 목록. 90일 보관 | 날짜(UTC) 문자열 |
| `data/naver-land-history.json` | `(complexNo\|전용면적\|거래유형)`별 일별 시계열 `[날짜, 평당호가최저가, 최저호가원본]`. 30일 보관, 3일 간격으로 솎음 | `series["복합키"]` |
| `data/naver-land-articles.json` | 매물(article) 단위 상세 스냅샷(신규/급매 후보만). 45일 보관 | `articles[articleNumber]` — 설계만, 아직 없음. 규칙 6 참고 |

## 점검 결과 — Run #39 (2026-08-22)

- **run #39**: `workflow_dispatch`(수동 실행)로 2026-08-21 19:27 UTC(KST 04:27) 시작,
  2026-08-21 22:54 UTC(KST 07:54) 완료, scope=`seoul`, **성공**.
- 커밋 `fdaa7c6` "chore: 네이버 부동산 매물 갱신 - seoul" (github-actions[bot])로 정상 push됨.
- `naver-land.json`(regions 26개, 단지×면적×거래유형 14,403행), `naver-land-daily.json`,
  `naver-land-history.json`(series 14,344건, 마지막 시점까지 갱신) 세 파일 모두 이 커밋
  시각에 맞춰 갱신 확인 — **데이터 저장 자체는 정상**.
- 단, 아래 두 가지 구조적 결함을 실측 데이터로 확인함 (규칙 1/2 품질에 직접 영향).
- **2026-08-22 후속 조치**: 아래 문제 1·2는 코드 수정 완료(커밋 참고), 문제 3은
  러너 상태 자체는 원격에서 못 고치므로 신선도 알림 워크플로를 추가했다. 상세는 각
  문제 항목의 "해결" 표시 참고.

## 발견된 문제 (우선 수정 권장)

### 문제 1 — 날짜 키가 UTC 기준이라 KST와 어긋남 — ✅ 해결 (2026-08-22)

`fetch-naver-land.js`가 `new Date().toISOString().slice(0,10)`로 "오늘" 날짜를 계산한다.
이 값은 UTC 자정 기준이라, 매일 새벽 2시(KST) 정기 실행이나 이른 아침 수동 실행은
UTC로는 여전히 "전날"이 되어 하루 이른 날짜에 데이터가 쌓인다.

- 실측: run #39는 KST 2026-08-22 새벽에 끝났지만, 데이터는 `"2026-08-21"` 키에 저장됐고
  `naver-land-daily.json`에는 아직 `"2026-08-22"` 키가 없다.
- 영향: 관리자/급매 Now! 탭에서 브라우저가 "오늘"을 계산할 때도 같은 방식(UTC)을 쓰므로
  자체 모순은 없지만, **KST 09:00(=UTC 자정)를 넘겨 접속하면 "오늘"이 실제로는 어제
  KST 새벽 데이터를 가리키게 되어**, 하루 종일 데이터가 밀려 보인다.
- 규칙 1(일일별 비교)·규칙 2(30일 조회)의 "일자"가 사용자 체감과 어긋나므로,
  **모든 날짜 계산을 `Asia/Seoul` 기준으로 통일**하는 수정을 권장한다
  (`fetch-naver-land.js`의 `today`/`todayStr`/`yesterdayStr` 계산부, `index.html`의
  `loadDailyComparison()`).
- **해결**: `kstDateStr()` 헬퍼(`Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Seoul'})`)를
  `scripts/fetch-naver-land.js`와 `index.html` 양쪽에 추가하고, "오늘"/"어제"/90일 cutoff를
  계산하던 모든 `toISOString()` 지점을 이 헬퍼로 교체. 실제 run #39 시각
  (`2026-08-21T22:54Z`)으로 검증: 이제 `2026-08-22`로 정확히 계산됨. `daysBetween`/
  `thinHistory` 등 날짜 문자열끼리 비교하는 로직은 영향 없어 그대로 둠.

### 문제 2 — "신규 단지" 판정 로직 결함 — ✅ 해결 (2026-08-22)

`updateDailySnapshot()`은 오늘 단지 중 **"어제의 newComplexes 목록"에 없는 것**만 신규로
판정한다(전체 단지 목록과 비교하지 않음). 어제 신규 목록이 비어 있으면(문제 1로 인해
흔히 발생) 사실상 모든 단지가 신규로 잡히는 구조다.

- 실측: `2026-08-20` newComplexes = **0건** → `2026-08-21` newComplexes = **14,310건**
  (전체 14,403개 단지의 99.4%) — 사실상 의미 없는 신호.
- 영향 범위: **"급매 Now!" 탭의 "신규 등록 단지" 섹션**(`loadDailyComparison`/
  `renderNewComplexes`, `naver-land-daily.json` 기반)에만 해당.
  **관리자 탭의 실제 `#newListingsPanel`은 이 결함의 영향을 받지 않는다** — 별도로
  `naver-land-history.json`의 (단지|면적|거래유형)별 최초 관측일을 기준으로 신규를
  판정하기 때문이다.
- 수정 방향: "어제 신규 목록"이 아니라 "지금까지 한 번이라도 관측된 전체 단지 집합"과
  비교하거나, `#newListingsPanel`처럼 history 기반 최초 관측일 방식으로 통일.
- **해결**: `updateDailySnapshot()`이 더 이상 "어제 daily.json의 newComplexes"를 참조하지
  않는다. 대신 `naver-land-history.json`의 `series`에서 각 (단지|전용면적|거래유형) 키의
  최초 관측일이 오늘이면 신규로 본다 — `#newListingsPanel`과 동일한 기준. `data/*.json`
  스키마 변경 없이(`naver-land-daily.json`에 새 필드 추가 없이) 고쳤고, 별도 시딩/마이그레이션도
  불필요(history의 실제 최초 관측일을 그대로 쓰므로). 합성 fixture 2종으로 로컬 검증:
  (1) 오늘 처음 등장한 단지만 신규로 잡히는지, (2) 원래 버그를 유발하던 "어제 daily의
  newComplexes가 비어 있는" 상황을 재현해도 오래된 단지가 오탐되지 않는지. 실제 14,000건대
  오탐이 재발하지 않는지는 다음 실러너 실행에서 최종 확인 필요.

### 문제 3 — 자동 스케줄(매일 새벽 2시)이 사실상 멈춰 있음 — ⚠️ 코드 보완 완료, 러너 확인은 사용자 몫

최근 워크플로 실행 이력(run #30~39)을 전수 조사한 결과, `schedule` 이벤트로 실행된
것은 **run #32(2026-08-20 17:28 UTC = KST 08-21 02:28)** 단 한 건뿐이며 그마저도
**실패**했다. 그다음 스케줄이 도는 시각(KST 08-22 02:00경)에도 `schedule` 이벤트 실행
기록이 없고, 대신 run #33~39가 전부 사람이 직접 실행한 `workflow_dispatch`였다.

- 자기호스팅 러너가 스케줄 시각에 꺼져 있으면 작업이 24시간 대기하다 취소되는 것이
  기존 동작이므로(`docs/naver-land-runner.md`), 최근 며칠은 자동 수집이 안 되고
  사람이 수동으로 챙겨야만 데이터가 갱신된 것으로 보인다.
- 규칙 1·2(일일 연속성, 30일 조회)는 매일 빠짐없이 수집된다는 전제가 깔려 있으므로,
  **러너가 예약 시각에 켜져 있는지(서비스 등록 여부, 절전 설정) 확인이 필요**하다.
- **코드 보완**: 러너 PC의 서비스/전원 상태는 원격에서 고칠 수 없어 그 자체는 미해결이지만,
  `scripts/check-naver-land-freshness.js` + `.github/workflows/naver-land-freshness-check.yml`을
  추가했다. `naver-scraper` 러너 없이 매일 KST 09:00에 `ubuntu-latest`에서 돌며,
  `naver-land-daily.json`의 최신 `updatedAt`이 30시간 넘게 오래되면 기존
  `scripts/notify-failure.js`(SMTP) 경로로 메일을 보낸다. **사용자 확인 필요**: 홈 PC의
  `naver-scraper` 러너가 서비스로 등록돼 있고 예약 시각(KST 02:00)에 깨어 있는지는
  `docs/naver-land-runner.md`를 참고해 직접 점검해야 한다.

## 규칙

| # | 규칙 | 상태 | 근거 |
|---|---|---|---|
| 1 | 저장되는 매물 데이터는 일일별 비교가 가능하도록 저장되어야 함 | 충족 ✅ | `naver-land-history.json`(30일 시계열) · `naver-land-daily.json`(날짜별 집계) 구조 + **문제 1 해결**로 날짜 키가 KST 기준으로 정확해짐 |
| 2 | 관리자 탭의 신규 등록 매물은 과거 30일 조회 가능해야 함 | 설계상 충족, 축적 중 ⚠️ | `#newListingsPanel`의 날짜 셀렉트가 `naver-land-history.json`의 (단지\|면적) 최초 관측일들로 채워짐(`HISTORY_KEEP_DAYS=30`). 이 이력 추적이 2026-08-20 도입돼 아직 30일치가 다 안 쌓임(2026-09-19경 완성 예정). **문제 1 해결**로 날짜 라벨 자체는 이제 정확함 |
| 3 | 신규 등록 매물 중 호가가 실거래가 대비 하락율 순으로 조회할 수 있어야 함 | **충족 ✅** | `#newListingsPanel`의 `renderForDate()`가 각 행을 `bargainDiscount()`(호가 vs `realMaxPrice`) 내림차순으로 이미 정렬해서 보여줌 |
| 4 | 신규 등록 매물을 단지별·평형별 신규 매물 개수 증감 순위로도 조회할 수 있어야 함 | 미구현 — 설계만 | 아래 "설계: 규칙 4" 참고 |
| 5 | 매물 수집 시 급매 등 키워드를 함께 수집해 JSON에 표시하고, 관리자 탭 신규 등록 매물에서 활용 가능하도록 설계 | **규칙 6으로 대체됨** | 아래 "설계: 규칙 5(대체됨)" 참고 |
| 6 | (2026-08-22 추가) 매물별 상세 정보(특징요약/특징/설명/방향/층수/방수 등)를 개별 매물 단위로 수집 | 미구현 — 설계 + 스캐폴딩만, 필드명 미확정 | 아래 "설계: 규칙 6" 참고. 실제 Naver API 필드명 확인은 실 러너의 `NAVER_SCOPE=probe` 실행 필요 |

## 설계: 규칙 4 — 단지·평형별 신규 매물 개수 증감 순위

현재 `naver-land.json`의 `complexes[]`는 이미 `(complexNo, tradeType, dong, exclusiveArea)`
조합 단위로 `count`(그 조합의 매물 건수)를 갖고 있다. 다만
`naver-land-history.json`의 시계열은 `[date, pyeongAskMin, minPrice]`만 저장하고
`count`는 저장하지 않아 "건수 증감"을 계산할 수 없다.

**제안 스키마 변경** (`naver-land-history.json`):

```
series["complexNo|area|tradeType"] = [
  [date, pyeongAskMin, minPrice, count],   // count 추가
  ...
]
```

이렇게 하면 최근 두 시점의 `count` 차이(delta)를 계산해 단지·평형 단위로 랭킹을 만들 수
있다. `CLAUDE.md`의 "`data/*.json` 구조를 임의로 바꾸지 않는다" 원칙에 따라 이번 점검에서는
**스키마 변경을 실제로 적용하지 않고 설계만 남긴다** — 구현 시 `fetch-naver-land.js`의
`applyWeeklyChange()`(현재 `[today, row.pyeongAskMin, row.minPrice ?? null]`을 미는 부분)와
`index.html`의 소비 코드를 함께 바꿔야 한다.

## 설계: 규칙 5(대체됨) — 급매 키워드 수집

**2026-08-22: 규칙 6으로 대체됨.** 원래 설계는 단지×면적 집계 행에 `tags: string[]`를
직접 붙이는 것이었는데, 집계 행 하나가 매물 수십 건을 대표할 수 있어("한 줄에 116건"인
경우도 실측됨) "이 행의 tags가 정확히 무엇을 가리키는가"가 애매했다. 매물별 상세를
아예 별도 파일(`naver-land-articles.json`)로 개별 수집하는 규칙 6이 이 문제를 근본적으로
해소하므로, 집계 행에는 저비용 파생값 `hasBargainKeyword: boolean`만 남기고(버킷 내
매물 중 하나라도 급매 키워드에 걸리면 true) 전체 태그/설명은 규칙 6 쪽에서 다룬다.
유사어 목록(`BARGAIN_KEYWORDS`) 아이디어는 규칙 6에 그대로 이어받았다.

## 설계: 규칙 6 — 매물별(article) 상세 정보 수집 (2026-08-22 추가)

**배경**: 사용자가 참고로 제공한 외부 스크레이핑 결과(102건, "서울 급매" 검색)에는
매물특징요약(태그)/매물특징(한 줄 요약)/매물설명(장문)/방향/층수/방수/화장실수/관리비
등 지금 `fetch-naver-land.js`가 버리고 있는 개별 매물 단위 상세 필드가 담겨 있었다.
현재 수집기는 `(complexNo, exclusiveArea)` 단위로 매물 여러 건을 하나의 집계 행으로
뭉치면서 `priceInfo`/`spaceInfo`/`buildingInfo.approvalElapsedYear`/`address.sector`/
`complexNumber`/`complexName` 외의 모든 필드를 버린다(`aggregateComplexes()` 참고).

**데이터 모델**: 신규 파일 `data/naver-land-articles.json`.

```jsonc
{
  "updatedAt": "2026-08-22T...Z",
  "articles": {
    "<articleNumber>": {
      "complexNo": 12345, "complexName": "...", "tradeType": "A1",
      "exclusiveArea": 84.97, "supplyArea": 112.4,
      "floor": "10/20", "direction": "남향",
      "roomCount": 3, "bathRoomCount": 2,
      "priceRaw": "매매 18억 5,000", "price": 185000,
      "tags": ["10년이내", "대단지", "필로티", "방세개"],
      "featureSummary": "...", "description": "...",
      "managementCost": null,
      "hasBargainKeyword": false,
      "firstSeenDate": "2026-08-22", "lastSeenDate": "2026-08-22",
      "removedDate": null
    }
  }
}
```

- **키**: `articleNumber`(폴백 `articleId`) — 이미 `fetchAllRegions()`의 중복 제거
  로직에서 실사용 중인 확정 필드명.
- **전체 매물(하루 약 5.7만건)을 다 저장하지 않는다.** `naver-land-daily.json`이
  4.2MB까지 불어난 전례(과거 신규 단지 오탐 버그의 직접 결과)가 있어, 저장 대상을
  "상세할 가치가 있는" 부분집합으로 제한: (a) 이 파일 기준으로 이번에 처음 보는 매물,
  (b) 급매 키워드(`BARGAIN_KEYWORDS`)에 걸리는 매물.
- **스냅샷 방식**: 매물별 전체 이력이 아니라 최신 스냅샷만 유지. 재관측되면
  `lastSeenDate` 갱신, 이번에 안 보이면 `removedDate` 기록 — "제안 규칙 6"(매물 내려감
  감지)을 부수적으로 해결.
- **보관 기간**: `lastSeenDate` 기준 45일.
- **개인정보**: `data/*.json`은 배포 시 퍼블릭 미러 저장소로 그대로 복사돼 bujamap.kr에
  실린다(`docs/private-repo-pages.md`). **부동산번호1/2(전화)·부동산명·부동산주소는
  아예 추출/저장하지 않는다** — 이미 네이버에 공개된 정보라도, 이 개인 대시보드에 저장할
  기능적 필요가 없고 다른 공개 도메인에 재게시할 이유가 없다. 매물설명(장문)은 저장하되,
  전화번호 패턴(`/01[0-9]-?\d{3,4}-?\d{4}/`)이 섞여 있으면 저장 전 제거한다.
- **필드명은 전부 미확정 추정치** — `priceInfo`/`spaceInfo`처럼 그룹화된 응답 구조를
  근거로 한 최선의 추측이며, 실제 확인은 `NAVER_SCOPE=probe`로만 가능(이 개발 환경은
  네이버 접속 자체가 차단돼 있음). 히트율(추정 필드가 실제로 값을 채우는 비율)이 낮으면
  `naver-land-articles.json` 쓰기 자체를 건너뛰도록 가드를 둬서, 필드명이 틀렸을 때
  null투성이 파일이 퍼블릭 저장소에 커밋되는 걸 막는다.
- **후속 UI 작업(별도 범위)**: `#newListingsPanel`의 각 행에 태그 칩/설명 표시,
  `hasBargainKeyword`를 기존 하락율 기반 급매 판정과 함께 필터링에 반영.

## 제안 규칙 (추가로 고려할 것)

1. ~~날짜 계산을 KST(Asia/Seoul) 기준으로 통일~~ — **완료 (2026-08-22)**. 문제 1 참고.
2. ~~신규 단지 판정을 "누적 관측 집합" 기준으로 변경~~ — **완료 (2026-08-22)**. 문제 2 참고.
3. 매물 고유 식별자 기준 명확화 — 현재 신규 판정 단위가 `complexNo`+면적(단지 상품
   단위)이지 개별 매물(`articleNumber`)이 아님을 문서에 명시. 필요하면 개별 매물 단위
   추적을 별도로 추가할지 결정.
4. 하락율 계산식·임계치(현재 5%, `bargainPct`는 관리자가 조정 가능)와 `realMaxPrice`
   갱신 주기(최근 3년 실거래, `DETAIL_DELAY_MS` 간격으로 수집)를 문서에 고정.
5. `naver-land-daily.json`(90일) / `naver-land-history.json`(30일) 보관 기간이 서로
   다른 이유(용도가 다름: 전자는 일별 집계 그래프용, 후자는 신규 매물 위젯 + 주간
   변화율용)를 명문화.
6. ~~매물이 내려간(삭제된) 경우를 감지·표시하는 규칙 추가~~ — **규칙 6 설계로 해결**.
   `naver-land-articles.json`의 스냅샷 방식(재관측 시 `lastSeenDate` 갱신, 미관측 시
   `removedDate` 기록)이 부수적으로 이 요구를 충족.
7. 워크플로 실패(예: 이전 run #37/#35/#34 실패) 시 데이터 정합성 체크 — 전일 대비
   건수가 비정상적으로 급감/급증하면 경고하는 규칙 추가 (이번 점검에서 발견한 문제 2도
   이런 검증이 있었다면 조기에 잡혔을 것).
8. ~~문제 3(자동 스케줄 미작동)의 재발 방지~~ — **코드 보완 완료 (2026-08-22)**.
   `naver-land-freshness-check.yml`이 매일 KST 09:00에 신선도를 확인해 메일로 알림. 단,
   근본 원인(러너 PC가 예약 시각에 꺼져 있는 것으로 추정)은 사용자가 직접 확인·조치해야 함.
