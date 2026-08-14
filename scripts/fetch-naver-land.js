// 네이버 부동산에서 지역별 아파트 매물을 단지 단위로 집계해 ../data/naver-land.json 생성
//
// m.land.naver.com의 구형 AJAX API(cluster/ajax/articleList)는 더 이상 실데이터를
// 반환하지 않는다(호출은 200을 반환하지만 매물 0건). 네이버 부동산은 fin.land.naver.com
// (Next.js) 로 전면 개편되었고, 이 도메인은 일반 fetch로 호출하면 즉시 429가 뜬다.
// 대신 Playwright로 실제 브라우저를 띄운 뒤 그 페이지 컨텍스트 안에서 내부 API
// (front-api)를 호출하면 정상적으로 데이터를 받아올 수 있다(브라우저 실행 환경/TLS
// 지문이 필요한 것으로 보임). 그래도 네이버가 이 패턴을 재탐지해 막을 수 있으므로
// 재시도 후 실패하면 기존 데이터 파일을 그대로 둔다(빈 데이터로 덮어쓰지 않음).
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// 집계 대상 지역. cortarNo는 네이버 법정동 코드(front-api/v1/legalDivision 기준).
// 구 단위 5곳은 기존 범위를 유지하고, 흑석동은 개별 요청으로 흑석동만 정밀하게 집계한다.
const REGIONS = [
  { cortarNo: "1168000000", name: "서울 강남구", legalDivisionLevelType: "GUN" },
  { cortarNo: "1171000000", name: "서울 송파구", legalDivisionLevelType: "GUN" },
  { cortarNo: "1165000000", name: "서울 서초구", legalDivisionLevelType: "GUN" },
  { cortarNo: "1144000000", name: "서울 마포구", legalDivisionLevelType: "GUN" },
  { cortarNo: "1120000000", name: "서울 성동구", legalDivisionLevelType: "GUN" },
  { cortarNo: "1159010500", name: "서울 동작구 흑석동", legalDivisionLevelType: "EUP" },
];

const TRADE_TYPES = ["A1"]; // A1=매매
const REAL_ESTATE_TYPES = ["A01"]; // A01=아파트
const PYEONG_M2 = 3.305785;

const PAGE_SIZE = 20; // 네이버 API가 20 초과 시 400을 반환함
const MAX_PAGES_PER_QUERY = 25;
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (baseMs) => baseMs + Math.floor(Math.random() * baseMs * 0.5);

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

async function getRegionCoordinates(page, region) {
  const res = await callApi(
    page,
    `/front-api/v1/legalDivision/subInfoList?legalDivisionLevelType=SI&legalDivisionNumber=1100000000`
  );
  const json = JSON.parse(res.text);
  const guList = json.result || [];
  if (region.legalDivisionLevelType === "GUN") {
    const match = guList.find((g) => region.name.endsWith(g.legalDivisionName));
    if (match) return match.coordinates;
  }
  // 동(흑석동) 단위는 소속 구를 먼저 찾은 뒤 하위 동 목록에서 조회한다.
  for (const gu of guList) {
    const dongRes = await callApi(
      page,
      `/front-api/v1/legalDivision/subInfoList?legalDivisionLevelType=GUN&legalDivisionNumber=${gu.legalDivisionNumber}`
    );
    const dongJson = JSON.parse(dongRes.text);
    const dongMatch = (dongJson.result || []).find((d) => d.legalDivisionNumber === region.cortarNo);
    if (dongMatch) return dongMatch.coordinates;
  }
  throw new Error(`지역 좌표를 찾을 수 없음: ${region.name}`);
}

function boundingBoxFor(region, coords) {
  const delta = region.legalDivisionLevelType === "EUP" ? { lat: 0.013, lon: 0.016 } : { lat: 0.035, lon: 0.045 };
  return {
    left: coords.xCoordinate - delta.lon,
    right: coords.xCoordinate + delta.lon,
    top: coords.yCoordinate + delta.lat,
    bottom: coords.yCoordinate - delta.lat,
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
      byComplex.set(key, { complexNo: a.complexNumber ?? null, complexName: a.complexName, tradeType, prices: [], areas: [] });
    }
    const bucket = byComplex.get(key);
    const rawPrice = tradeType === "A1" ? a.priceInfo?.dealPrice : a.priceInfo?.warrantyPrice;
    if (rawPrice > 0) bucket.prices.push(rawPrice / 10000); // 원 -> 만원
    if (a.spaceInfo?.supplySpace > 0) bucket.areas.push(a.spaceInfo.supplySpace);
  }

  const complexes = [];
  for (const bucket of byComplex.values()) {
    const prices = bucket.prices.slice().sort((x, y) => x - y);
    const areas = bucket.areas;
    const avgArea = areas.length ? areas.reduce((s, v) => s + v, 0) / areas.length : null;
    const pyeongPrices = bucket.prices
      .map((p, i) => (areas[i] ? p / (areas[i] / PYEONG_M2) : null))
      .filter((v) => v != null);
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
    });
  }
  return complexes;
}

async function fetchAllRegions(page) {
  const regions = [];
  for (const region of REGIONS) {
    console.log(`[${region.name}] 좌표 조회 중...`);
    const coords = await getRegionCoordinates(page, region);
    const boundingBox = boundingBoxFor(region, coords);

    // 동(EUP) 단위 지역은 바운딩 박스가 인접 동까지 걸치므로 실제 소재지로 한 번 더 거른다.
    const dongName = region.legalDivisionLevelType === "EUP" ? region.name.split(" ").pop() : null;

    const complexes = [];
    for (const tradeType of TRADE_TYPES) {
      console.log(`[${region.name}] ${tradeType} 매물 수집 중...`);
      let articles = await fetchArticlesForRegion(page, boundingBox, tradeType);
      if (dongName) articles = articles.filter((a) => a.address?.sector === dongName);
      console.log(`  ${articles.length}건 원자료 → ${new Set(articles.map((a) => a.complexNumber)).size}개 단지`);
      complexes.push(...aggregateComplexes(articles, tradeType));
      await sleep(jitter(1500));
    }

    regions.push({ cortarNo: region.cortarNo, name: region.name, complexes });
  }
  return regions;
}

async function attemptFetch() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
  });
  try {
    const { context, page } = await newStealthPage(browser);
    try {
      return await fetchAllRegions(page);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const outPath = path.join(__dirname, "..", "data", "naver-land.json");
  let regions = [];
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[시도 ${attempt}/${MAX_ATTEMPTS}] 네이버 부동산 매물 수집 중...`);
      regions = await attemptFetch();
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

  const data = { updatedAt: new Date().toISOString(), regions };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`[성공] ${regions.length}개 지역, ${totalComplexes}개 단지×거래유형 조합 → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
