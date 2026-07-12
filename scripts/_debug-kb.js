// 일회성 디버그: 한국 서울 아파트 매매가격지수(KB 등) 데이터 소스 탐색. 사용 후 삭제 예정.
// 주의: URL(인증키 포함)은 절대 로그에 출력하지 않음 — 파싱된 JSON 내용만 출력.
const API_KEY = process.env.BOK_ECOS_API_KEY;

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch (e) {
    return { status: res.status, json: null, textLen: text.length, textHead: text.slice(0, 200) };
  }
}

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

async function ecosListChildren(code) {
  const suffix = code ? `/${code}` : "";
  const json = await ecosFetchJson(`StatisticTableList/{KEY}/json/kr/1/100${suffix}`);
  await sleep(80);
  if (!json) return [];
  if (json.RESULT) return [];
  return json.StatisticTableList?.row || [];
}

async function searchEcosForHousing() {
  console.log("=== ECOS 최상위 카테고리 조회 ===");
  const roots = await ecosListChildren("");
  for (const r of roots) {
    console.log(`  STAT_CODE=${r.STAT_CODE}  STAT_NAME=${r.STAT_NAME}  SRCH_YN=${r.SRCH_YN}`);
  }
  const relevant = roots.filter((r) => /주택|부동산|아파트|지가|가격/.test(r.STAT_NAME));
  console.log(`\n관련 최상위 카테고리 ${relevant.length}개 발견`);

  let callCount = 0;
  const found = [];
  async function walk(code, pathLabel, depth) {
    if (depth > 6 || callCount > 150) return;
    callCount++;
    const rows = await ecosListChildren(code);
    for (const r of rows) {
      const label = `${r.STAT_CODE} ${r.STAT_NAME} (SRCH_YN=${r.SRCH_YN})`;
      const newPath = pathLabel ? `${pathLabel} > ${label}` : label;
      if (/주택|부동산|아파트|KB|지가/.test(r.STAT_NAME)) {
        console.log("FOUND:", newPath);
        found.push(newPath);
      }
      if (r.SRCH_YN !== "Y") {
        await walk(r.STAT_CODE, newPath, depth + 1);
      }
    }
  }
  for (const r of relevant) {
    await walk(r.STAT_CODE, `${r.STAT_CODE} ${r.STAT_NAME}`, 1);
  }
  console.log(`\n총 ECOS API 호출 수: ${callCount}`);
  console.log(`=== 주택/부동산 매칭 결과 ${found.length}건 ===`);
  for (const f of found) console.log(f);
}

async function probeKosis() {
  console.log("\n=== KOSIS Open API 프로브 (키 없이) ===");
  const r = await fetchJson(
    "https://kosis.kr/openapi/Param/statisticsParameterData.do?method=getList&format=json&jsonVD=Y&prdSe=M"
  );
  console.log("  status:", r.status, "json:", JSON.stringify(r.json), "textHead:", r.textHead);
}

async function probeKbLand() {
  console.log("\n=== KB부동산 데이터허브 프로브 ===");
  const candidates = [
    "https://data.kbland.kr/kbland-data/publicdata/list",
    "https://data.kbland.kr/api/price/main",
  ];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
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
    await searchEcosForHousing();
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
