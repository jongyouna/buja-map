// 네이버 부동산에서 서울 전체 구(區) + 흑석동(정밀 스팟)의 아파트 매매 매물을
// 단지 단위로 집계해 ../data/naver-land.json 생성
//
// m.land.naver.com의 구형 AJAX API(cluster/ajax/articleList)는 더 이상 실데이터를
// 반환하지 않는다(호출은 200을 반환하지만 매물 0건). 네이버 부동산은 fin.land.naver.com
// (Next.js) 로 전면 개편되었고, 이 도메인은 일반 fetch로 호출하면 즉시 429가 뜬다.
// 대신 Playwright로 실제 브라우저를 띄운 뒤 그 페이지 컨텍스트 안에서 내부 API
// (front-api)를 호출하면 정상적으로 데이터를 받아올 수 있다(브라우저 실행 환경/TLS
// 지문이 필요한 것으로 보임). 그래도 네이버가 이 패턴을 재탐지해 막을 수 있으므로,
// 지역 하나가 실패해도 나머지는 계속 수집하고, 전체가 0건일 때만 기존 파일을 유지한다.
//
// 범위는 현재 "서울 전체"까지만 다룬다(경기도는 다음 단계에서 확장 예정 — NAVER_SCOPE 참고).
//
// 수집 범위는 환경변수 NAVER_SCOPE로 고른다:
//   NAVER_SCOPE=gangnam  → 강남구만 (1~2분, 수시 실행용)
//   NAVER_SCOPE=seoul    → 서울 전체 구 + 정밀 동 (기본값, 매일 새벽 정기 수집용)
// 일부 지역만 수집해도 기존 data/naver-land.json의 나머지 지역은 그대로 보존된다
// (mergeRegions 참고). 지역마다 updatedAt을 따로 기록해 어느 지역이 언제 갱신됐는지 남긴다.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const SEOUL_SI_NUMBER = "1100000000";
const SPOTLIGHT_DONGS = [{ gu: "동작구", dong: "흑석동" }]; // 구 전체 집계와 별개로 정밀 집계할 동

const SCOPE = (process.env.NAVER_SCOPE || "seoul").toLowerCase();
const SCOPE_PRESETS = {
  // 응답에 실제로 어떤 필드가 오는지 확인하려고 타일 하나만 조회해 원본 JSON을 찍는다.
  // 파일은 건드리지 않는다. 새 항목(전용면적·세대수 등)을 추가하기 전에 필드명을 확인하는 용도.
  probe: { probe: true, onlyGu: ["강남구"], includeSpotlightDongs: false, label: "필드 확인용 1타일 조회" },
  gangnam: { onlyGu: ["강남구"], includeSpotlightDongs: false, label: "강남구만" },
  seoul: { onlyGu: null, includeSpotlightDongs: true, label: "서울 전체 구 + 정밀 동" },
};
if (!SCOPE_PRESETS[SCOPE]) {
  console.error(`알 수 없는 NAVER_SCOPE="${SCOPE}". 사용 가능: ${Object.keys(SCOPE_PRESETS).join(", ")}`);
  process.exit(1);
}
const SCOPE_CONFIG = SCOPE_PRESETS[SCOPE];

const TRADE_TYPES = ["A1"]; // A1=매매
const REAL_ESTATE_TYPES = ["A01"]; // A01=아파트
const PYEONG_M2 = 3.305785;

const PAGE_SIZE = 20; // 네이버 API가 20 초과 시 400을 반환함
const MAX_PAGES_PER_QUERY = 50; // 더 쪼갤 수 없는 타일의 마지막 상한(1000건)
// 아직 쪼갤 수 있는 타일은 이만큼(500건)만 떠보고, 더 남아 있으면 곧바로 4분할한다.
// 1000건까지 다 받은 뒤 버리고 재조회하면 그 페이지들이 통째로 낭비된다.
const SUBDIVIDE_PROBE_PAGES = 25;
const MAX_ATTEMPTS = 3; // 브라우저 세션 자체가 죽는 등 전체 재시도
const TILES_PER_BROWSER_SESSION = 40; // 이 개수(타일)마다 브라우저를 새로 띄워 세션을 신선하게 유지

// 조회 격자 한 칸의 크기(도 단위). 위도 0.008 ≈ 890m, 경도 0.010 ≈ 880m.
const TILE_LAT = 0.008;
const TILE_LON = 0.01;
// 동 중심 좌표만 알고 있으므로 구 경계를 넉넉히 덮도록 여유를 둔다.
const AREA_MARGIN = { lat: 0.012, lon: 0.015 };
// 구는 사각형이 아니다. 격자를 사각형 그대로 쓰면 모서리 타일이 이웃 구의 밀집 지역에
// 놓여, 남의 구 매물을 잔뜩 받아 전부 버리게 된다(강남구 단독 수집이 느렸던 원인).
// 대상 동 중심에서 이 거리 안에 있는 타일만 남겨 격자를 실제 구 모양에 가깝게 깎는다.
const TILE_KEEP_RADIUS = { lat: 0.014, lon: 0.017 };
// 밀집 타일을 4분할하는 최대 깊이. 깊이 5면 한 칸이 약 28m까지 줄어들어,
// 대단지가 몰린 구역도 상한 안으로 들어온다(깊이 3에서는 누락이 발생했다).
const MAX_SUBDIVIDE_DEPTH = 5;

// 네이버 차단을 피하려고 요청 사이에 두는 대기(ms 기준값, 실제로는 최대 50% 지터가 붙는다).
// 전체 소요 시간의 대부분이 이 대기다 — 조회 횟수를 줄이는 것보다 여기가 훨씬 크게 작용한다.
// 차단 위험과 수집 시간을 맞바꾸는 손잡이이므로 값을 낮출 때는 실제 실행으로 확인할 것.
const PAGE_DELAY_MS = 500; // 같은 타일의 다음 페이지
const TILE_DELAY_MS = 350; // 다음 타일 / 분할된 하위 타일
const DETAIL_DELAY_MS = 180; // 단지 상세(세대수·실거래가) 조회 사이. 가벼운 GET이라 짧게 둔다.

// 실거래 최고가를 몇 년치에서 뽑을지. 3개월만 보면 거래가 없어 null이 뜨는 단지가 대부분이다.
const REAL_PRICE_YEARS = 3;
const COMPLEXES_PER_DETAIL_SESSION = 150; // 이 개수마다 브라우저를 새로 띄운다

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (baseMs) => baseMs + Math.floor(Math.random() * baseMs * 0.5);

async function launchStealthBrowser() {
  return chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
  });
}

async function newStealthPage(browser) {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1400, height: 1000 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();
  await page.goto("https://fin.land.naver.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(jitter(2000));
  return { context, page };
}

async function callApi(page, apiPath, body) {
  return page.evaluate(
    async ({ apiPath, body }) => {
      const options = { headers: { Accept: "application/json, text/plain, */*" } };
      if (body) {
        options.method = "POST";
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
      }
      const res = await fetch(apiPath, options);
      const text = await res.text();
      return { status: res.status, text };
    },
    { apiPath, body }
  );
}

async function subInfoList(page, legalDivisionLevelType, legalDivisionNumber) {
  const res = await callApi(
    page,
    `/front-api/v1/legalDivision/subInfoList?legalDivisionLevelType=${legalDivisionLevelType}&legalDivisionNumber=${legalDivisionNumber}`
  );
  const json = JSON.parse(res.text);
  if (!json.isSuccess) throw new Error(`subInfoList API error: ${res.text.slice(0, 200)}`);
  return json.result || [];
}

// 수집 대상 구의 하위 동 목록을 받아, 동 이름 -> 구 매핑과 조회할 격자(타일)를 만든다.
//
// 왜 동별 박스가 아니라 격자인가:
// 처음에는 구 하나를 큰 박스로 조회했는데, 상한에 걸려 모든 구가 정확히 500건에서 잘렸고
// 박스가 인접 구까지 걸쳐 남의 구 매물이 섞였다. 다음으로 동마다 박스를 잡아 주소로 걸렀더니
// 섞임은 사라졌지만, 이웃 동 매물을 매번 다시 받느라 조회 예산을 낭비했다(신사동은 1000건을
// 받아 23건만 건짐, 전체 적중률 22%). 결국 동 14곳에 15분이 걸렸고 여전히 잘렸다.
//
// 어차피 주소로 구를 판정하므로 박스를 행정구역에 맞출 이유가 없다. 겹치지 않는 격자로
// 한 번씩만 훑고 받은 매물을 주소로 각 구에 배정하면 중복 조회가 사라진다.
async function buildTargets(page) {
  let guList = await subInfoList(page, "SI", SEOUL_SI_NUMBER);
  if (SCOPE_CONFIG.onlyGu) {
    guList = guList.filter((g) => SCOPE_CONFIG.onlyGu.includes(g.legalDivisionName));
    if (guList.length === 0) throw new Error(`범위 ${SCOPE}에 해당하는 구를 찾지 못했습니다.`);
  }

  const dongToGu = new Map(); // 동 이름 -> 구 번호
  const dongNumbers = new Map(); // "구명|동명" -> 동 번호 (정밀 동 지역에 필요)
  const coords = [];
  for (const gu of guList) {
    const dongList = await subInfoList(page, "GUN", gu.legalDivisionNumber);
    for (const dong of dongList) {
      dongToGu.set(dong.legalDivisionName, gu.legalDivisionNumber);
      dongNumbers.set(`${gu.legalDivisionName}|${dong.legalDivisionName}`, dong.legalDivisionNumber);
      if (dong.coordinates) coords.push(dong.coordinates);
    }
    await sleep(jitter(400));
  }
  if (coords.length === 0) throw new Error("수집 대상 동 목록이 비어 있습니다.");

  return { guList, dongToGu, dongNumbers, tiles: buildTileGrid(coords) };
}

// 동 중심 좌표들을 모두 덮는 사각 영역을 겹치지 않는 격자로 나눈다.
function buildTileGrid(coords) {
  const xs = coords.map((c) => c.xCoordinate);
  const ys = coords.map((c) => c.yCoordinate);
  const left = Math.min(...xs) - AREA_MARGIN.lon;
  const right = Math.max(...xs) + AREA_MARGIN.lon;
  const bottom = Math.min(...ys) - AREA_MARGIN.lat;
  const top = Math.max(...ys) + AREA_MARGIN.lat;

  const tiles = [];
  for (let y = bottom; y < top; y += TILE_LAT) {
    for (let x = left; x < right; x += TILE_LON) {
      tiles.push({
        left: x,
        right: Math.min(x + TILE_LON, right),
        bottom: y,
        top: Math.min(y + TILE_LAT, top),
      });
    }
  }

  // 대상 동에서 멀리 떨어진 모서리 타일은 조회하지 않는다.
  return tiles.filter((t) => {
    const cx = (t.left + t.right) / 2;
    const cy = (t.bottom + t.top) / 2;
    return coords.some(
      (c) =>
        Math.abs(c.xCoordinate - cx) <= TILE_KEEP_RADIUS.lon &&
        Math.abs(c.yCoordinate - cy) <= TILE_KEEP_RADIUS.lat
    );
  });
}

// maxPages까지만 받아오고, 아직 더 남았는지(hasMore)를 함께 돌려준다.
// 분할할 수 있는 타일이라면 적은 페이지만 떠보고 바로 쪼개는 편이 싸다.
async function fetchArticlesForRegion(page, boundingBox, tradeType, maxPages) {
  const collected = [];
  let cursor = { seed: undefined, lastInfo: undefined };

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const articlePagingRequest = { size: PAGE_SIZE };
    if (cursor.seed) articlePagingRequest.seed = cursor.seed;
    if (cursor.lastInfo) articlePagingRequest.lastInfo = cursor.lastInfo;

    const body = {
      filter: {
        tradeTypes: [tradeType],
        realEstateTypes: REAL_ESTATE_TYPES,
        roomCount: [],
        bathRoomCount: [],
        optionTypes: [],
        oneRoomShapeTypes: [],
        moveInTypes: [],
        filtersExclusiveSpace: false,
        floorTypes: [],
        directionTypes: [],
        hasArticlePhoto: false,
        isAuthorizedByOwner: false,
        parkingTypes: [],
        entranceTypes: [],
        hasArticle: false,
      },
      boundingBox,
      precision: 15,
      userChannelType: "PC",
      articlePagingRequest,
    };

    const res = await callApi(page, "/front-api/v1/article/boundedArticles", body);
    if (res.status !== 200) throw new Error(`boundedArticles HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    const json = JSON.parse(res.text);
    if (!json.isSuccess) throw new Error(`boundedArticles API error: ${res.text.slice(0, 200)}`);

    for (const group of json.result?.list || []) {
      const rep = group.representativeArticleInfo;
      if (!rep) continue;
      collected.push(rep);
    }

    if (!json.result?.hasNextPage) return { articles: collected, hasMore: false };
    cursor = { seed: json.result.seed, lastInfo: json.result.lastInfo };
    if (pageIndex < maxPages - 1) await sleep(jitter(PAGE_DELAY_MS));
  }

  return { articles: collected, hasMore: true };
}

// 같은 단지라도 전용면적이 다르면 사실상 다른 상품이라 가격대가 겹치지 않는다.
// 그래서 (단지, 전용면적) 단위로 한 줄씩 만든다. 면적을 모르는 매물은 따로 모은다.
function aggregateComplexes(articles, tradeType) {
  const byUnit = new Map();
  for (const a of articles) {
    const rawPrice = tradeType === "A1" ? a.priceInfo?.dealPrice : a.priceInfo?.warrantyPrice;
    const price = rawPrice > 0 ? rawPrice / 10000 : null; // 원 -> 만원
    // 화면에 쓰는 기준 면적은 전용면적이다. 공급면적도 같이 남겨 둔다.
    const area = a.spaceInfo?.exclusiveSpace > 0 ? a.spaceInfo.exclusiveSpace : null;
    const supply = a.spaceInfo?.supplySpace > 0 ? a.spaceInfo.supplySpace : null;
    const complexKey = a.complexNumber ?? a.complexName;
    // 소수점 둘째 자리까지 같아야 같은 평형으로 본다. 84A/84B처럼 미세하게
    // 다른 타입은 실제로 다른 상품이므로 굳이 합치지 않는다.
    const key = `${complexKey}|${area == null ? "" : area.toFixed(2)}`;
    if (!byUnit.has(key)) {
      byUnit.set(key, {
        complexNo: a.complexNumber ?? null,
        complexName: a.complexName,
        tradeType,
        exclusiveArea: area,
        supplyArea: supply,
        // 화면에 "서울시 강남구 역삼동"처럼 표시하려면 단지가 속한 동이 필요하다.
        // 구 단위로 집계한 지역은 지역 자체에 동 정보가 없으므로 매물 주소에서 가져온다.
        dong: a.address?.sector || null,
        prices: [],
        approvalElapsedYears: [],
      });
    }
    const bucket = byUnit.get(key);
    if (!bucket.dong && a.address?.sector) bucket.dong = a.address.sector;
    if (price != null) bucket.prices.push(price);
    if (typeof a.buildingInfo?.approvalElapsedYear === "number") {
      bucket.approvalElapsedYears.push(a.buildingInfo.approvalElapsedYear);
    }
  }

  const complexes = [];
  for (const bucket of byUnit.values()) {
    const prices = bucket.prices.slice().sort((x, y) => x - y);
    const years = bucket.approvalElapsedYears;
    // 한 줄 안의 매물은 면적이 모두 같으므로 평당가는 평균가에서 바로 나온다.
    const avgPrice = prices.length ? prices.reduce((s, v) => s + v, 0) / prices.length : null;
    const minPrice = prices.length ? prices[0] : null;
    complexes.push({
      complexNo: bucket.complexNo,
      complexName: bucket.complexName,
      tradeType: bucket.tradeType,
      dong: bucket.dong,
      exclusiveArea: bucket.exclusiveArea,
      supplyArea: bucket.supplyArea,
      count: bucket.prices.length,
      minPrice,
      maxPrice: prices.length ? prices[prices.length - 1] : null,
      avgPrice,
      // 평당가는 관례대로 공급면적 기준이다(전용면적으로 나누면 값이 30%쯤 부풀려진다).
      avgPyeongPrice:
        avgPrice != null && bucket.supplyArea != null ? avgPrice / (bucket.supplyArea / PYEONG_M2) : null,
      // 가장 싼 호가를 평당으로 환산한 값. 화면의 기준 지표이자 주간 변화율의 계산 대상.
      pyeongAskMin:
        minPrice != null && bucket.supplyArea != null
          ? Math.round(minPrice / (bucket.supplyArea / PYEONG_M2))
          : null,
      approvalElapsedYear: years.length ? Math.round(years.reduce((s, v) => s + v, 0) / years.length) : null,
    });
  }
  return complexes;
}

// ---- 단지 상세 보강 ----
// 매물 목록 응답에는 세대수도 실거래가도 없다(probe로 확인). 단지 상세 API 두 개를 더 부른다.
//   /front-api/v1/complex/pyeongList                  : 평형타입별 전용면적 · 세대수
//   /front-api/v1/complex/pyeong/realPrice/summary    : 평형타입별 실거래 최저/최고/평균
// 평형타입은 전용면적으로 우리 행과 맞춘다(둘 다 네이버가 준 같은 값이라 정확히 일치한다).
function realPriceStartDate() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - REAL_PRICE_YEARS);
  return d.toISOString().slice(0, 10);
}

async function fetchPyeongList(page, complexNo) {
  const res = await callApi(page, `/front-api/v1/complex/pyeongList?complexNumber=${complexNo}`);
  if (res.status !== 200) return null;
  const json = JSON.parse(res.text);
  return json.isSuccess && Array.isArray(json.result) ? json.result : null;
}

async function fetchRealPriceSummary(page, complexNo, pyeongTypeNumber, tradeType, startDate) {
  const res = await callApi(
    page,
    `/front-api/v1/complex/pyeong/realPrice/summary?complexNumber=${complexNo}` +
      `&pyeongTypeNumber=${pyeongTypeNumber}&realEstateType=A01&tradeType=${tradeType}&startDate=${startDate}`
  );
  if (res.status !== 200) return null;
  const json = JSON.parse(res.text);
  return json.isSuccess ? json.result : null; // 거래 이력이 없으면 result가 null
}

async function enrichWithComplexDetail(regions) {
  const startDate = realPriceStartDate();
  // 같은 단지가 구 지역과 정밀 동 지역에 함께 들어 있으므로, 단지 번호로 묶어 한 번만 조회한다.
  const byComplex = new Map();
  for (const region of regions) {
    for (const row of region.complexes) {
      if (row.complexNo == null) continue;
      if (!byComplex.has(row.complexNo)) byComplex.set(row.complexNo, []);
      byComplex.get(row.complexNo).push(row);
    }
  }
  if (byComplex.size === 0) return;
  console.log(`[상세] 단지 ${byComplex.size}곳의 세대수·실거래 최고가 조회 시작 (실거래 ${REAL_PRICE_YEARS}년치)`);

  let browser = await launchStealthBrowser();
  let session = await newStealthPage(browser);
  const stat = { ok: 0, failed: 0, households: 0, realPrice: 0 };
  let i = 0;
  try {
    for (const [complexNo, group] of byComplex) {
      i++;
      if (i > 1 && i % COMPLEXES_PER_DETAIL_SESSION === 0) {
        await session.context.close().catch(() => {});
        await browser.close().catch(() => {});
        browser = await launchStealthBrowser();
        session = await newStealthPage(browser);
      }
      try {
        const types = await fetchPyeongList(session.page, complexNo);
        await sleep(jitter(DETAIL_DELAY_MS));
        if (!types) {
          stat.failed++;
          continue;
        }
        const total = types.reduce((s, t) => s + (t.householdCount || 0), 0);
        const byArea = new Map();
        for (const t of types) {
          if (t.exclusiveArea > 0) byArea.set(t.exclusiveArea.toFixed(2), t);
        }
        for (const row of group) {
          if (total > 0) {
            row.householdCount = total;
            stat.households++;
          }
          const t = row.exclusiveArea == null ? null : byArea.get(row.exclusiveArea.toFixed(2));
          if (!t) continue;
          row.unitHouseholdCount = t.householdCount ?? null;
          const summary = await fetchRealPriceSummary(session.page, complexNo, t.number, row.tradeType, startDate);
          await sleep(jitter(DETAIL_DELAY_MS));
          const maxDeal = summary?.maxPrice?.dealPrice;
          if (maxDeal > 0) {
            row.realMaxPrice = Math.round(maxDeal / 10000); // 원 -> 만원
            row.realMaxDate = summary.maxPrice.tradeDate || null;
            stat.realPrice++;
          }
        }
        stat.ok++;
      } catch (err) {
        // 단지 하나가 실패해도 나머지는 계속 채운다. 이 값들은 없어도 표가 동작한다.
        stat.failed++;
      }
      if (i % 100 === 0) {
        console.log(`  [상세] ${i}/${byComplex.size} 단지 (성공 ${stat.ok} / 실패 ${stat.failed} / 실거래 ${stat.realPrice}행)`);
      }
    }
  } finally {
    await session.context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  console.log(
    `[상세] 완료 — 단지 ${byComplex.size}곳 중 성공 ${stat.ok} / 실패 ${stat.failed}, ` +
      `세대수 ${stat.households}행 / 실거래 최고가 ${stat.realPrice}행`
  );
}

// 타일 하나를 조회한다. 상한에 걸리면 매물이 빽빽하다는 뜻이므로 4분할해 다시 조회한다.
// 분할된 타일끼리는 겹치지 않으므로 같은 매물이 두 번 잡히지 않는다.
async function fetchTile(page, tile, tradeType, depth, stats) {
  // 분할 여지가 있으면 SUBDIVIDE_PROBE_PAGES까지만 떠본다. 상한까지 다 받아놓고
  // 쪼개면 그 페이지들이 통째로 버려지므로, 밀집 타일일수록 일찍 쪼개는 편이 싸다.
  const canSubdivide = depth < MAX_SUBDIVIDE_DEPTH;
  const budget = canSubdivide ? SUBDIVIDE_PROBE_PAGES : MAX_PAGES_PER_QUERY;
  const { articles: fetched, hasMore } = await fetchArticlesForRegion(page, tile, tradeType, budget);
  stats.queries++;
  stats.fetched += fetched.length;

  if (!hasMore) return fetched;
  if (!canSubdivide) {
    stats.truncated++;
    console.log(`      ※ 최대 분할 깊이에서도 상한 도달 - 일부 누락 가능`);
    return fetched;
  }

  stats.subdivided++;
  stats.wasted += fetched.length;
  const midX = (tile.left + tile.right) / 2;
  const midY = (tile.bottom + tile.top) / 2;
  const quads = [
    { left: tile.left, right: midX, bottom: tile.bottom, top: midY },
    { left: midX, right: tile.right, bottom: tile.bottom, top: midY },
    { left: tile.left, right: midX, bottom: midY, top: tile.top },
    { left: midX, right: tile.right, bottom: midY, top: tile.top },
  ];
  const out = [];
  for (const quad of quads) {
    await sleep(jitter(TILE_DELAY_MS));
    out.push(...(await fetchTile(page, quad, tradeType, depth + 1, stats)));
  }
  return out;
}

async function fetchAllRegions() {
  let browser = await launchStealthBrowser();
  let session;
  // 구 번호 -> { gu 정보, tradeType별 매물 배열 }
  const byGu = new Map();
  // 정밀 동(흑석동 등)은 별도 지역으로도 남기기 위해 따로 보관
  const spotlightArticles = new Map();
  const stats = { queries: 0, fetched: 0, kept: 0, subdivided: 0, truncated: 0, wasted: 0 };

  try {
    session = await newStealthPage(browser);
    const { guList, dongToGu, dongNumbers, tiles } = await buildTargets(session.page);
    console.log(`대상 ${guList.length}개 구 / 조회 타일 ${tiles.length}개 (범위: ${SCOPE_CONFIG.label})`);

    for (const gu of guList) {
      byGu.set(gu.legalDivisionNumber, { gu, articles: new Map() });
    }
    const spotlightKeys = new Set(
      (SCOPE_CONFIG.includeSpotlightDongs ? SPOTLIGHT_DONGS : []).map((s) => `${s.gu}|${s.dong}`)
    );
    const guNameByNumber = new Map(guList.map((g) => [g.legalDivisionNumber, g.legalDivisionName]));

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];

      if (i > 0 && i % TILES_PER_BROWSER_SESSION === 0) {
        console.log("브라우저 세션 갱신...");
        await session.context.close();
        await browser.close();
        browser = await launchStealthBrowser();
        session = await newStealthPage(browser);
      }

      try {
        for (const tradeType of TRADE_TYPES) {
          const articles = await fetchTile(session.page, tile, tradeType, 0, stats);
          let kept = 0;
          for (const a of articles) {
            const sector = a.address?.sector;
            const guNumber = sector ? dongToGu.get(sector) : null;
            if (!guNumber) continue; // 수집 대상 밖의 지역
            kept++;

            const bucket = byGu.get(guNumber);
            if (!bucket.articles.has(tradeType)) bucket.articles.set(tradeType, []);
            bucket.articles.get(tradeType).push(a);

            const spotKey = `${guNameByNumber.get(guNumber)}|${sector}`;
            if (spotlightKeys.has(spotKey)) {
              if (!spotlightArticles.has(spotKey)) {
                spotlightArticles.set(spotKey, {
                  guName: guNameByNumber.get(guNumber),
                  dongName: sector,
                  dongNumber: dongNumbers.get(spotKey),
                  byTradeType: new Map(),
                });
              }
              const spot = spotlightArticles.get(spotKey);
              if (!spot.byTradeType.has(tradeType)) spot.byTradeType.set(tradeType, []);
              spot.byTradeType.get(tradeType).push(a);
            }
          }
          stats.kept += kept;
          if (articles.length > 0) {
            console.log(`[${i + 1}/${tiles.length}] ${tradeType}: 조회 ${articles.length}건 → 대상 ${kept}건`);
          }
          await sleep(jitter(TILE_DELAY_MS));
        }
      } catch (err) {
        console.log(`[${i + 1}/${tiles.length}] 오류(건너뜀): ${err.message}`);
      }
    }
  } finally {
    if (session) await session.context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const hitRate = stats.fetched ? Math.round((stats.kept / stats.fetched) * 100) : 0;
  console.log(
    `[수집 요약] 조회 ${stats.queries}회 / 받은 매물 ${stats.fetched}건 / 대상 ${stats.kept}건 (적중률 ${hitRate}%)` +
      ` / 타일 분할 ${stats.subdivided}회(버린 조회 ${stats.wasted}건)` +
      (stats.truncated ? ` / 최대 깊이 상한 도달 ${stats.truncated}회 ※일부 누락 가능` : "")
  );

  // 구 단위 지역: 그 구의 모든 동에서 모은 매물을 한 번에 집계
  const results = [];
  for (const { gu, articles } of byGu.values()) {
    const complexes = [];
    let total = 0;
    for (const [tradeType, list] of articles) {
      total += list.length;
      complexes.push(...aggregateComplexes(list, tradeType));
    }
    if (complexes.length === 0) continue; // 전부 실패한 구는 기존 데이터를 남겨둔다
    const complexCount = new Set(complexes.map((c) => c.complexNo ?? c.complexName)).size;
    console.log(
      `[집계] 서울 ${gu.legalDivisionName}: 매물 ${total}건 → 단지 ${complexCount}곳 / 면적별 ${complexes.length}행`
    );
    results.push({
      cortarNo: gu.legalDivisionNumber,
      name: `서울 ${gu.legalDivisionName}`,
      si: "서울",
      gugun: gu.legalDivisionName,
      dong: null,
      updatedAt: new Date().toISOString(),
      complexes,
    });
  }

  // 정밀 동 지역(구 집계와 별개로 동 단위 행도 제공)
  for (const spot of spotlightArticles.values()) {
    const complexes = [];
    for (const [tradeType, list] of spot.byTradeType) complexes.push(...aggregateComplexes(list, tradeType));
    if (complexes.length === 0) continue;
    results.push({
      cortarNo: spot.dongNumber,
      name: `서울 ${spot.guName} ${spot.dongName}`,
      si: "서울",
      gugun: spot.guName,
      dong: spot.dongName,
      updatedAt: new Date().toISOString(),
      complexes,
    });
  }

  await enrichWithComplexDetail(results);

  return results;
}

// ---- 평당호가최저가 주간 변화율 ----
// 네이버는 호가 이력을 주지 않는다. 그래서 수집할 때마다 (단지|전용면적)별 평당호가최저가를
// 따로 쌓아 두고, 오늘 값과 일주일 전 값을 비교한다.
// 매일 수집하므로 하루 한 점이면 충분하고, 비교에 필요한 만큼만 남기고 버린다.
const HISTORY_KEEP_DAYS = 12; // 7일 전 값을 찾을 수 있을 만큼만
const HISTORY_MATCH_MIN_DAYS = 5; // "일주일 전"으로 인정할 최소 간격
const HISTORY_MATCH_MAX_DAYS = 12; // 최대 간격(수집이 며칠 걸러도 비교는 되도록)
// 매일 수집한 점을 전부 남기면 서울 전체 기준 하루 2MB씩 저장소가 불어난다.
// 3일보다 촘촘한 점은 버린다. 남는 점이 오늘/3일/6일/9일/12일이라 7일 비교에는 충분하고,
// 실제로 비교에 쓴 날짜는 화면 툴팁에 그대로 보여준다.
const HISTORY_MIN_GAP_DAYS = 3;

const historyKey = (row) =>
  `${row.complexNo ?? row.complexName}|${row.exclusiveArea == null ? "" : row.exclusiveArea.toFixed(2)}|${row.tradeType}`;

function readHistory(histPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(histPath, "utf8"));
    return parsed && typeof parsed.series === "object" ? parsed.series : {};
  } catch (e) {
    return {};
  }
}

const daysBetween = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

// HISTORY_MIN_GAP_DAYS 길이의 고정 구간마다 한 점씩만 남긴다.
//
// "오늘로부터 3일 이상 떨어진 점만 남긴다"는 식으로 오늘 기준으로 솎으면 안 된다.
// 매일 수집하면 어제 점이 매번 버려져서 이력이 영원히 한 점만 남는다.
// 달력에 고정된 구간으로 나눠야 점이 자리를 지키고 쌓인다.
function thinHistory(points, today) {
  const byBucket = new Map();
  for (const p of points) {
    if (daysBetween(today, p[0]) > HISTORY_KEEP_DAYS) continue;
    const bucket = Math.floor(Date.parse(p[0]) / 86400000 / HISTORY_MIN_GAP_DAYS);
    const cur = byBucket.get(bucket);
    if (!cur || p[0] > cur[0]) byBucket.set(bucket, p); // 같은 구간이면 최신 값
  }
  return [...byBucket.values()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
}

// 오늘 값을 이력에 넣고, 일주일 전 값을 각 행에 붙인다.
function applyWeeklyChange(regions, series, today) {
  let matched = 0;
  const touched = new Set();
  for (const region of regions) {
    for (const row of region.complexes) {
      if (row.pyeongAskMin == null) continue;
      const key = historyKey(row);
      const points = series[key] || [];

      // 같은 날 두 번 수집하면 나중 값으로 덮어쓴다.
      const older = points.filter((p) => p[0] !== today);
      // 일주일 전에 가장 가까운 점을 찾는다.
      let best = null;
      for (const p of older) {
        const gap = daysBetween(today, p[0]);
        if (gap < HISTORY_MATCH_MIN_DAYS || gap > HISTORY_MATCH_MAX_DAYS) continue;
        if (!best || Math.abs(gap - 7) < Math.abs(daysBetween(today, best[0]) - 7)) best = p;
      }
      if (best) {
        row.prevPyeongAskMin = best[1];
        row.prevDate = best[0];
        matched++;
      }

      if (!touched.has(key)) {
        older.push([today, row.pyeongAskMin]);
        series[key] = thinHistory(older, today);
        touched.add(key);
      }
    }
  }
  // 이번에 수집하지 않은 지역의 이력은 건드리지 않되, 너무 오래된 항목은 정리한다.
  for (const [key, points] of Object.entries(series)) {
    if (touched.has(key)) continue;
    const kept = thinHistory(points, today);
    if (kept.length === 0) delete series[key];
    else series[key] = kept;
  }
  console.log(`[변화율] 이력 ${Object.keys(series).length}건 보관 / 이번에 일주일 전 값과 비교된 행 ${matched}개`);
  return series;
}

function readExistingRegions(outPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(outPath, "utf8"));
    return Array.isArray(parsed.regions) ? parsed.regions : [];
  } catch (e) {
    return []; // 파일이 없거나 깨졌으면 이번 수집분만 저장
  }
}

// 이번에 수집한 지역만 교체하고, 수집 대상이 아니었던 지역은 기존 데이터를 그대로 남긴다.
// (강남구만 수집했다고 나머지 구가 파일에서 사라지면 안 되므로)
function mergeRegions(existing, fresh) {
  const byKey = new Map(existing.map((r) => [r.cortarNo, r]));
  for (const r of fresh) byKey.set(r.cortarNo, r);
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

// 응답 원본을 찍어 필드명을 확인한다. 화면에 새 항목을 추가하기 전에 이걸로 먼저 확인할 것.
async function probeOnce() {
  const browser = await launchStealthBrowser();
  const { page, context } = await newStealthPage(browser);
  try {
    // 역삼동 한복판의 작은 상자 하나
    const boundingBox = { left: 127.03, right: 127.045, bottom: 37.494, top: 37.506 };
    const body = {
      filter: {
        tradeTypes: ["A1"],
        realEstateTypes: REAL_ESTATE_TYPES,
        roomCount: [],
        bathRoomCount: [],
        optionTypes: [],
        oneRoomShapeTypes: [],
        moveInTypes: [],
        filtersExclusiveSpace: false,
        floorTypes: [],
        directionTypes: [],
        hasArticlePhoto: false,
        isAuthorizedByOwner: false,
        parkingTypes: [],
        entranceTypes: [],
        hasArticle: false,
      },
      boundingBox,
      precision: 15,
      userChannelType: "PC",
      articlePagingRequest: { size: 5 },
    };
    const res = await callApi(page, "/front-api/v1/article/boundedArticles", body);
    console.log(`HTTP ${res.status}`);
    const json = JSON.parse(res.text);
    const list = json.result?.list || [];
    console.log(`받은 그룹 ${list.length}개`);
    console.log("=== RESULT KEYS ===");
    console.log(JSON.stringify(Object.keys(json.result || {})));
    for (const [i, group] of list.slice(0, 1).entries()) {
      console.log(`=== GROUP ${i} 전체 ===`);
      console.log(JSON.stringify(group, null, 2));
    }

    // 세대수·실거래가는 매물 목록 응답에 없다. 단지 상세 페이지가 어떤 API를 부르는지
    // 실제로 열어보고 잡아낸다(엔드포인트 주소를 추측하지 않기 위해).
    const complexNumber = list[0]?.representativeArticleInfo?.complexNumber;
    if (!complexNumber) {
      console.log("단지 번호를 찾지 못해 단지 상세 조사는 건너뜁니다.");
      return;
    }
    console.log(`=== 단지 상세 페이지 네트워크 조사: complexNumber=${complexNumber} ===`);
    const seen = [];
    page.on("response", async (r) => {
      const url = r.url();
      if (!url.includes("/front-api/")) return;
      let body = "";
      try {
        body = (await r.text()).slice(0, 1200);
      } catch (e) {
        body = `(본문 읽기 실패: ${e.message})`;
      }
      seen.push({ url, status: r.status(), body });
    });
    await page.goto(`https://fin.land.naver.com/complexes/${complexNumber}`, {
      waitUntil: "networkidle",
      timeout: 45000,
    });
    await page.waitForTimeout(4000);
    console.log(`front-api 호출 ${seen.length}건`);
    for (const s of seen) {
      console.log(`--- ${s.status} ${s.url}`);
      console.log(s.body);
    }

    // [확인 완료] 표의 단지명 링크 형식.
    //   https://fin.land.naver.com/complexes/{번호}?tab=article&tradeTypes=A1
    //     &exclusiveSpaceMode=true&space={전용-0.5}-{전용+0.5}
    // 이 주소는 /map 으로 리다이렉트되는데, 네 파라미터가 모두 layer 상태로 넘어간다:
    //   [{"id":"complex_detail","params":{"complexId":109227},
    //     "searchParams":{"tab":"article","tradeTypes":"A1",
    //                     "exclusiveSpaceMode":"true","space":"114.0900-115.0900"}}]
    // layer는 lz-string Base64 압축이지만, 우리가 직접 만들 필요 없이 위 주소만 쓰면 된다.
    // tab=article 이라는 값은 네이버 자신의 recentView 응답이 알려준 것이다.

  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const outPath = path.join(__dirname, "..", "data", "naver-land.json");
  const histPath = path.join(__dirname, "..", "data", "naver-land-history.json");
  console.log(`수집 범위: ${SCOPE} (${SCOPE_CONFIG.label})`);
  if (SCOPE_CONFIG.probe) {
    await probeOnce();
    return;
  }
  let regions = [];
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[시도 ${attempt}/${MAX_ATTEMPTS}] 네이버 부동산 매물 수집 중...`);
      regions = await fetchAllRegions();
      const totalComplexes = regions.reduce((s, r) => s + r.complexes.length, 0);
      if (totalComplexes > 0) break;
      console.log("  0건 수집됨, 재시도 전 대기...");
    } catch (err) {
      lastError = err;
      console.log(`  오류: ${err.message}`);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(jitter(5000 * attempt));
  }

  const totalComplexes = regions.reduce((s, r) => s + r.complexes.length, 0);
  if (totalComplexes === 0) {
    console.error(
      "[실패] 수집된 매물이 한 건도 없습니다. 네이버 차단 여부를 확인하세요. 기존 파일을 유지합니다."
    );
    if (lastError) console.error(lastError.stack || lastError.message);
    process.exit(1);
  }

  // 이번에 수집한 지역에 "일주일 전 평당호가최저가"를 붙이고 이력을 갱신한다.
  const today = new Date().toISOString().slice(0, 10);
  const series = applyWeeklyChange(regions, readHistory(histPath), today);

  const merged = mergeRegions(readExistingRegions(outPath), regions);
  const data = { updatedAt: new Date().toISOString(), scope: SCOPE, regions: merged };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(histPath, JSON.stringify({ updatedAt: new Date().toISOString(), series }));
  // 개별 매물 가격까지 담으면서 파일이 커졌다. 들여쓰기를 빼면 절반 크기가 되고,
  // 어차피 기계가 만드는 파일이라 사람이 diff를 읽을 일은 없다.
  fs.writeFileSync(outPath, JSON.stringify(data));

  const keptCount = merged.length - regions.length;
  console.log(
    `[성공] 이번 수집 ${regions.length}개 지역(${totalComplexes}개 단지×면적×거래유형)` +
      (keptCount > 0 ? `, 기존 유지 ${keptCount}개 지역` : "") +
      ` → 총 ${merged.length}개 지역 저장 (${outPath})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
