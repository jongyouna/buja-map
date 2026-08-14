// 매일 실행: 네이버 부동산에서 동작구 흑석동 아파트 매물을 수집해 ../data/naver-land.json 생성
//
// 네이버 부동산(fin.land.naver.com)은 Next.js 기반이며 일반 fetch로는 접근이 막혀 있어
// (요청 즉시 429 TOO_MANY_REQUESTS) 실제 브라우저(Playwright)로 페이지를 띄운 뒤
// 그 브라우저 컨텍스트 안에서 내부 API(front-api)를 호출하는 방식으로 우회한다.
// 그럼에도 네이버가 이 트래픽 패턴을 재탐지해 차단할 수 있으므로, 실패 시 재시도 후
// 기존 데이터 파일을 그대로 보존한다(빈 데이터로 덮어쓰지 않음).
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const REGION = {
  name: "서울시 동작구 흑석동",
  legalDivisionNumber: "1159010500",
  // 흑석동 중심 좌표 기준 바운딩 박스(약 1.3km 반경). 인접 동 매물은 sector로 걸러낸다.
  boundingBox: { left: 126.9495, right: 126.9765, top: 37.5117, bottom: 37.4987 },
};

const FILTER = {
  tradeTypes: ["A1", "B1", "B2"], // A1=매매, B1=전세, B2=월세
  realEstateTypes: ["A01"], // A01=아파트
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
};

const TRADE_TYPE_LABEL = { A1: "매매", B1: "전세", B2: "월세" };
const PAGE_SIZE = 20; // 네이버 API가 20 초과 시 400을 반환함
const MAX_PAGES = 60;
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

async function callApi(page, path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, text };
    },
    { path, body }
  );
}

function flattenGroup(group) {
  const out = [];
  const rep = group.representativeArticleInfo;
  const dupList = group.duplicatedArticleInfo?.articleInfoList || [rep];
  for (const a of dupList) {
    if (a.address?.sector !== "흑석동") continue;
    out.push({
      articleNumber: a.articleNumber,
      complexName: a.complexName,
      complexNumber: a.complexNumber,
      dongName: a.dongName,
      tradeType: a.tradeType,
      tradeTypeLabel: TRADE_TYPE_LABEL[a.tradeType] || a.tradeType,
      supplySpace: a.spaceInfo?.supplySpace ?? null,
      exclusiveSpace: a.spaceInfo?.exclusiveSpace ?? null,
      floorInfo: a.articleDetail?.floorInfo ?? null,
      direction: a.articleDetail?.direction ?? null,
      description: a.articleDetail?.articleFeatureDescription ?? null,
      dealPrice: a.priceInfo?.dealPrice ?? null,
      warrantyPrice: a.priceInfo?.warrantyPrice ?? null,
      rentPrice: a.priceInfo?.rentPrice ?? null,
      managementFeeAmount: a.priceInfo?.managementFeeAmount ?? null,
      brokerName: a.brokerInfo?.brokerName ?? null,
      brokerageName: a.brokerInfo?.brokerageName ?? null,
      exposureStartDate: a.verificationInfo?.exposureStartDate ?? null,
      imageUrl: a.articleMediaDto?.imageUrl ?? a.articleMedia?.photos?.[0]?.imagePath ?? null,
    });
  }
  return out;
}

async function fetchAllListings(page) {
  const collected = [];
  const seenArticleNumbers = new Set();
  let cursor = { seed: undefined, lastInfo: undefined };

  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
    const articlePagingRequest = { size: PAGE_SIZE };
    if (cursor.seed) articlePagingRequest.seed = cursor.seed;
    if (cursor.lastInfo) articlePagingRequest.lastInfo = cursor.lastInfo;

    const body = {
      filter: FILTER,
      boundingBox: REGION.boundingBox,
      precision: 15,
      userChannelType: "PC",
      articlePagingRequest,
    };

    const res = await callApi(page, "/front-api/v1/article/boundedArticles", body);
    if (res.status !== 200) {
      throw new Error(`boundedArticles HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    }
    const json = JSON.parse(res.text);
    if (!json.isSuccess) {
      throw new Error(`boundedArticles API error: ${res.text.slice(0, 200)}`);
    }

    const groups = json.result?.list || [];
    for (const group of groups) {
      for (const listing of flattenGroup(group)) {
        if (seenArticleNumbers.has(listing.articleNumber)) continue;
        seenArticleNumbers.add(listing.articleNumber);
        collected.push(listing);
      }
    }

    if (!json.result?.hasNextPage) break;
    cursor = { seed: json.result.seed, lastInfo: json.result.lastInfo };
    await sleep(jitter(1200));
  }

  return collected;
}

async function attemptFetch() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"],
  });
  try {
    const { context, page } = await newStealthPage(browser);
    try {
      const listings = await fetchAllListings(page);
      return listings;
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const outPath = path.join(__dirname, "..", "data", "naver-land.json");
  let listings = [];
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[시도 ${attempt}/${MAX_ATTEMPTS}] ${REGION.name} 매물 수집 중...`);
      listings = await attemptFetch();
      if (listings.length > 0) break;
      console.log("  0건 수집됨, 재시도 전 대기...");
    } catch (err) {
      lastError = err;
      console.log(`  오류: ${err.message}`);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(jitter(5000 * attempt));
  }

  if (listings.length === 0) {
    console.error(
      "[실패] 수집된 매물이 한 건도 없습니다. 네이버 차단 여부를 확인하세요. 기존 파일을 유지합니다."
    );
    if (lastError) console.error(lastError.stack || lastError.message);
    process.exit(1);
  }

  const data = {
    updatedAt: new Date().toISOString(),
    region: REGION.name,
    count: listings.length,
    listings,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`[성공] ${listings.length}건 수집 → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
