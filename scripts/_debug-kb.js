// 일회성 디버그: 한국 서울 아파트 매매가격지수(KB 등) 데이터 소스 탐색. 사용 후 삭제 예정.
// 주의: URL(인증키 포함)은 절대 로그에 출력하지 않음 — 파싱된 JSON 내용만 출력.
const API_KEY = process.env.BOK_ECOS_API_KEY;

async function ecosFetchJson(path) {
  const url = `https://ecos.bok.or.kr/api/${path.replace("{KEY}", API_KEY)}`;
  const res = await fetch(url);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 최상위 카테고리를 페이지네이션하며 전부 수집 (100건 제한 때문에 1페이지로는 카테고리 1번만 보임)
async function ecosAllRootCategories() {
  const all = [];
  let start = 1;
  const pageSize = 100;
  for (let page = 0; page < 15; page++) {
    const end = start + pageSize - 1;
    const json = await ecosFetchJson(`StatisticTableList/{KEY}/json/kr/${start}/${end}/`);
    await sleep(100);
    if (!json || json.RESULT) break;
    const rows = json.StatisticTableList?.row || [];
    if (rows.length === 0) break;
    all.push(...rows);
    if (rows.length < pageSize) break;
    start += pageSize;
  }
  return all;
}

async function ecosListChildren(code) {
  const json = await ecosFetchJson(`StatisticTableList/{KEY}/json/kr/1/100/${code}`);
  await sleep(100);
  if (!json || json.RESULT) return [];
  return json.StatisticTableList?.row || [];
}

async function searchEcosForHousing() {
  console.log("=== ECOS 전체 최상위 카테고리 조회(페이지네이션) ===");
  const all = await ecosAllRootCategories();
  console.log(`  총 ${all.length}건 수집`);

  // 최상위(레벨1, 예: "1.", "2." 로 시작하는 이름) 카테고리만 추려서 출력
  const topLevel = all.filter((r) => /^\d+\.\s/.test(r.STAT_NAME));
  console.log(`  최상위 레벨(N. ...) 카테고리 ${topLevel.length}건:`);
  for (const r of topLevel) {
    console.log(`    STAT_CODE=${r.STAT_CODE}  STAT_NAME=${r.STAT_NAME}`);
  }

  const housingMatch = all.filter((r) => /주택|부동산|아파트|지가|전세|매매가격/.test(r.STAT_NAME));
  console.log(`\n  주택/부동산 키워드 매칭 ${housingMatch.length}건 (전체 수집분 내):`);
  for (const r of housingMatch) {
    console.log(`    STAT_CODE=${r.STAT_CODE}  STAT_NAME=${r.STAT_NAME}  SRCH_YN=${r.SRCH_YN}`);
  }

  // 관련 카테고리 하위 탐색
  const relevant = all.filter((r) => /주택|부동산|아파트|지가/.test(r.STAT_NAME) && r.SRCH_YN !== "Y");
  let callCount = 0;
  const found = [];
  async function walk(code, pathLabel, depth) {
    if (depth > 6 || callCount > 100) return;
    callCount++;
    const rows = await ecosListChildren(code);
    for (const r of rows) {
      const label = `${r.STAT_CODE} ${r.STAT_NAME} (SRCH_YN=${r.SRCH_YN})`;
      const newPath = pathLabel ? `${pathLabel} > ${label}` : label;
      console.log("  CHILD:", newPath);
      if (r.SRCH_YN !== "Y") await walk(r.STAT_CODE, newPath, depth + 1);
    }
  }
  for (const r of relevant) {
    await walk(r.STAT_CODE, `${r.STAT_CODE} ${r.STAT_NAME}`, 1);
  }
  console.log(`\n총 ECOS API 호출 수(하위탐색): ${callCount}`);
}

async function probeKosis() {
  console.log("\n=== KOSIS Open API 프로브 (키 없이) ===");
  try {
    const res = await fetch(
      "https://kosis.kr/openapi/Param/statisticsParameterData.do?method=getList&format=json&jsonVD=Y&prdSe=M",
      { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } }
    );
    const text = await res.text();
    console.log("  status:", res.status, "length:", text.length, "head:", text.slice(0, 300));
  } catch (e) {
    console.log("  ERROR:", e.message, e.cause ? JSON.stringify(e.cause) : "");
  }
}

async function probeKbLand() {
  console.log("\n=== KB부동산 데이터허브 프로브 ===");
  const candidates = [
    "https://data.kbland.kr/kbland-data/publicdata/list",
    "https://data.kbland.kr/api/price/main",
    "https://data.kbland.kr",
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
      const text = await res.text();
      console.log(`  ${url} -> status=${res.status} contentType=${res.headers.get("content-type")} length=${text.length}`);
      console.log(`    head: ${text.slice(0, 150).replace(/\n/g, " ")}`);
    } catch (e) {
      console.log(`  ${url} -> ERROR: ${e.message}`);
    }
  }
}

async function main() {
  if (API_KEY) {
    try {
      await searchEcosForHousing();
    } catch (e) {
      console.log("ECOS 탐색 오류:", e.message);
    }
  } else {
    console.log("BOK_ECOS_API_KEY 없음, ECOS 탐색 건너뜀");
  }
  await probeKosis();
  await probeKbLand();
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
