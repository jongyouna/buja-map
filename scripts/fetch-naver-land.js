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
// 동 하나에 대한 안전 상한. 동 단위로 쪼개 조회하므로 실제로는 대부분 몇 페이지에서 끝난다.
// (구 단위로 조회하던 시절에는 이 상한에 걸려 모든 구가 500건에서 잘렸다.)
const MAX_PAGES_PER_QUERY = 50;
const MAX_ATTEMPTS = 3; // 브라우저 세션 자체가 죽는 등 전체 재시도
const TARGETS_PER_BROWSER_SESSION = 30; // 이 개수(동)마다 브라우저를 새로 띄워 세션을 신선하게 유지

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

// 수집은 항상 "동" 단위로 한다. 구 하나를 큰 박스로 한 번에 조회하면 두 가지 문제가 생긴다:
//   1) 매물이 상한(MAX_PAGES_PER_QUERY x PAGE_SIZE)에 걸려 잘린다. 실제로 강남·송파·서초·
//      마포·성동이 모두 정확히 500건에서 멈춰 있었다.
//   2) 바운딩 박스는 사각형이라 인접 구까지 걸친다. 성동구 성수동 트리마제가 강남구로,
//      서초구 단지 59곳이 강남구에도 함께 집계됐다.
// 동별 좁은 박스로 조회하고 응답의 실제 주소(address.sector)로 한 번 더 거르면 둘 다 풀린다.
// 주소 필터가 중복 제거 역할도 하므로(매물의 소재 동은 하나뿐) 동 간 중복 걱정도 없다.
async function buildTargets(page) {
  let guList = await subInfoList(page, "SI", SEOUL_SI_NUMBER);
  if (SCOPE_CONFIG.onlyGu) {
    guList = guList.filter((g) => SCOPE_CONFIG.onlyGu.includes(g.legalDivisionName));
    if (guList.length === 0) throw new Error(`범위 ${SCOPE}에 해당하는 구를 찾지 못했습니다.`);
  }

  const targets = [];
  for (const gu of guList) {
    const dongList = await subInfoList(page, "GUN", gu.legalDivisionNumber);
    for (const dong of dongList) {
      targets.push({
        guNumber: gu.legalDivisionNumber,
        guName: gu.legalDivisionName,
        dongNumber: dong.legalDivisionNumber,
        dongName: dong.legalDivisionName,
        coordinates: dong.coordinates,
      });
    }
    await sleep(jitter(400));
  }
  if (targets.length === 0) throw new Error("수집 대상 동 목록이 비어 있습니다.");
  return { guList, targets };
}

// 동 하나를 덮는 박스. 주소 필터가 넘친 매물을 걸러주므로 경계를 넉넉히 잡아도 안전하다.
function boundingBoxFor(coordinates) {
  const delta = { lat: 0.015, lon: 0.018 };
  const { xCoordinate, yCoordinate } = coordinates;
  return {
    left: xCoordinate - delta.lon,
    right: xCoordinate + delta.lon,
    top: yCoordinate + delta.lat,
    bottom: yCoordinate - delta.lat,
  };
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

// 동 하나를 조회하고, 응답 중 실제로 그 동에 속한 매물만 남긴다.
async function fetchOneDong(page, target) {
  const boundingBox = boundingBoxFor(target.coordinates);
  const byTradeType = new Map();
  for (const tradeType of TRADE_TYPES) {
    const fetched = await fetchArticlesForRegion(page, boundingBox, tradeType);
    const kept = fetched.filter((a) => a.address?.sector === target.dongName);
    byTradeType.set(tradeType, kept);
    const capHit = fetched.length >= MAX_PAGES_PER_QUERY * PAGE_SIZE;
    console.log(
      `    ${target.dongName} ${tradeType}: 조회 ${fetched.length}건 → 동 일치 ${kept.length}건` +
        (capHit ? "  ※상한 도달(잘렸을 수 있음)" : "")
    );
    await sleep(jitter(1000));
  }
  return byTradeType;
}

async function fetchAllRegions() {
  let browser = await launchStealthBrowser();
  let session;
  // 구 번호 -> { gu 정보, tradeType별 매물 배열 }
  const byGu = new Map();
  // 정밀 동(흑석동 등)은 별도 지역으로도 남기기 위해 따로 보관
  const spotlightArticles = new Map();

  try {
    session = await newStealthPage(browser);
    const { guList, targets } = await buildTargets(session.page);
    console.log(`대상 ${guList.length}개 구 / ${targets.length}개 동 (범위: ${SCOPE_CONFIG.label})`);

    for (const gu of guList) {
      byGu.set(gu.legalDivisionNumber, { gu, articles: new Map() });
    }

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];

      if (i > 0 && i % TARGETS_PER_BROWSER_SESSION === 0) {
        console.log("브라우저 세션 갱신...");
        await session.context.close();
        await browser.close();
        browser = await launchStealthBrowser();
        session = await newStealthPage(browser);
      }

      console.log(`[${i + 1}/${targets.length}] ${target.guName} ${target.dongName}`);
      try {
        const byTradeType = await fetchOneDong(session.page, target);
        const bucket = byGu.get(target.guNumber);
        for (const [tradeType, articles] of byTradeType) {
          if (!bucket.articles.has(tradeType)) bucket.articles.set(tradeType, []);
          bucket.articles.get(tradeType).push(...articles);

          const isSpotlight = SCOPE_CONFIG.includeSpotlightDongs &&
            SPOTLIGHT_DONGS.some((s) => s.gu === target.guName && s.dong === target.dongName);
          if (isSpotlight) {
            const key = `${target.guName}|${target.dongName}`;
            if (!spotlightArticles.has(key)) spotlightArticles.set(key, { target, byTradeType: new Map() });
            spotlightArticles.get(key).byTradeType.set(tradeType, articles);
          }
        }
      } catch (err) {
        console.log(`  오류(건너뜀): ${err.message}`);
      }
    }
  } finally {
    if (session) await session.context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

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
  for (const { target, byTradeType } of spotlightArticles.values()) {
    const complexes = [];
    for (const [tradeType, list] of byTradeType) complexes.push(...aggregateComplexes(list, tradeType));
    if (complexes.length === 0) continue;
    results.push({
      cortarNo: target.dongNumber,
      name: `서울 ${target.guName} ${target.dongName}`,
      si: "서울",
      gugun: target.guName,
      dong: target.dongName,
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
