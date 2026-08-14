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
const MAX_PAGES_PER_QUERY = 50; // 타일 하나당 상한(1000건). 넘치면 타일을 4분할해 다시 조회한다.
const MAX_ATTEMPTS = 3; // 브라우저 세션 자체가 죽는 등 전체 재시도
const TILES_PER_BROWSER_SESSION = 40; // 이 개수(타일)마다 브라우저를 새로 띄워 세션을 신선하게 유지

// 조회 격자 한 칸의 크기(도 단위). 위도 0.008 ≈ 890m, 경도 0.010 ≈ 880m.
const TILE_LAT = 0.008;
const TILE_LON = 0.01;
// 동 중심 좌표만 알고 있으므로 구 경계를 넉넉히 덮도록 여유를 둔다.
const AREA_MARGIN = { lat: 0.012, lon: 0.015 };
// 밀집 타일을 4분할하는 최대 깊이. 깊이 5면 한 칸이 약 28m까지 줄어들어,
// 대단지가 몰린 구역도 상한 안으로 들어온다(깊이 3에서는 누락이 발생했다).
const MAX_SUBDIVIDE_DEPTH = 5;

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
  return tiles;
}

async function fetchArticlesForRegion(page, boundingBox, tradeType) {
  const collected = [];
  let cursor = { seed: undefined, lastInfo: undefined };

  for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_QUERY; pageIndex++) {
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

    if (!json.result?.hasNextPage) break;
    cursor = { seed: json.result.seed, lastInfo: json.result.lastInfo };
    await sleep(jitter(1000));
  }

  return collected;
}

function median(sortedNums) {
  const n = sortedNums.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sortedNums[mid - 1] + sortedNums[mid]) / 2 : sortedNums[mid];
}

function aggregateComplexes(articles, tradeType) {
  const byComplex = new Map();
  for (const a of articles) {
    const key = a.complexNumber ?? a.complexName;
    if (!byComplex.has(key)) {
      byComplex.set(key, {
        complexNo: a.complexNumber ?? null,
        complexName: a.complexName,
        tradeType,
        prices: [],
        areas: [],
        pyeongPrices: [],
        approvalElapsedYears: [],
      });
    }
    const bucket = byComplex.get(key);
    const rawPrice = tradeType === "A1" ? a.priceInfo?.dealPrice : a.priceInfo?.warrantyPrice;
    const price = rawPrice > 0 ? rawPrice / 10000 : null; // 원 -> 만원
    const area = a.spaceInfo?.supplySpace > 0 ? a.spaceInfo.supplySpace : null;
    if (price != null) bucket.prices.push(price);
    if (area != null) bucket.areas.push(area);
    // 평당가는 같은 매물의 가격과 면적이 둘 다 있을 때만 그 자리에서 계산해 쌓는다.
    // prices/areas 배열을 인덱스로 짝지으면, 가격만 있고 면적이 없는 매물이 하나라도
    // 섞이는 순간 이후 항목들이 다른 매물의 면적과 잘못 짝지어진다.
    if (price != null && area != null) bucket.pyeongPrices.push(price / (area / PYEONG_M2));
    if (typeof a.buildingInfo?.approvalElapsedYear === "number") {
      bucket.approvalElapsedYears.push(a.buildingInfo.approvalElapsedYear);
    }
  }

  const complexes = [];
  for (const bucket of byComplex.values()) {
    const prices = bucket.prices.slice().sort((x, y) => x - y);
    const areas = bucket.areas;
    const avgArea = areas.length ? areas.reduce((s, v) => s + v, 0) / areas.length : null;
    const pyeongPrices = bucket.pyeongPrices;
    const years = bucket.approvalElapsedYears;
    complexes.push({
      complexNo: bucket.complexNo,
      complexName: bucket.complexName,
      tradeType: bucket.tradeType,
      count: bucket.prices.length,
      minPrice: prices.length ? prices[0] : null,
      medianPrice: median(prices),
      maxPrice: prices.length ? prices[prices.length - 1] : null,
      avgPyeongPrice: pyeongPrices.length ? pyeongPrices.reduce((s, v) => s + v, 0) / pyeongPrices.length : null,
      avgArea,
      approvalElapsedYear: years.length ? Math.round(years.reduce((s, v) => s + v, 0) / years.length) : null,
    });
  }
  return complexes;
}

// 타일 하나를 조회한다. 상한에 걸리면 매물이 빽빽하다는 뜻이므로 4분할해 다시 조회한다.
// 분할된 타일끼리는 겹치지 않으므로 같은 매물이 두 번 잡히지 않는다.
async function fetchTile(page, tile, tradeType, depth, stats) {
  const fetched = await fetchArticlesForRegion(page, tile, tradeType);
  stats.queries++;
  stats.fetched += fetched.length;

  const capHit = fetched.length >= MAX_PAGES_PER_QUERY * PAGE_SIZE;
  if (!capHit) return fetched;
  if (depth >= MAX_SUBDIVIDE_DEPTH) {
    stats.truncated++;
    console.log(`      ※ 최대 분할 깊이에서도 상한 도달 - 일부 누락 가능`);
    return fetched;
  }

  stats.subdivided++;
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
    await sleep(jitter(700));
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
  const stats = { queries: 0, fetched: 0, kept: 0, subdivided: 0, truncated: 0 };

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
          await sleep(jitter(700));
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
      ` / 타일 분할 ${stats.subdivided}회` +
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
    console.log(`[집계] 서울 ${gu.legalDivisionName}: 매물 ${total}건 → 단지 ${complexes.length}곳`);
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

  return results;
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

async function main() {
  const outPath = path.join(__dirname, "..", "data", "naver-land.json");
  console.log(`수집 범위: ${SCOPE} (${SCOPE_CONFIG.label})`);
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

  const merged = mergeRegions(readExistingRegions(outPath), regions);
  const data = { updatedAt: new Date().toISOString(), scope: SCOPE, regions: merged };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

  const keptCount = merged.length - regions.length;
  console.log(
    `[성공] 이번 수집 ${regions.length}개 지역(${totalComplexes}개 단지×거래유형)` +
      (keptCount > 0 ? `, 기존 유지 ${keptCount}개 지역` : "") +
      ` → 총 ${merged.length}개 지역 저장 (${outPath})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
