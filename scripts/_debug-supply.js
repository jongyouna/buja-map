// 일회성 디버그: 서울 아파트 연도별 공급량(주택건설인허가실적 등) 데이터 소스 탐색. 사용 후 삭제 예정.
const API_KEY = process.env.BOK_ECOS_API_KEY;
if (!API_KEY) {
  console.error("BOK_ECOS_API_KEY 없음");
  process.exit(1);
}

async function fetchJson(path) {
  const url = `https://ecos.bok.or.kr/api/${path.replace("{KEY}", API_KEY)}`;
  const res = await fetch(url);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.log(`  (JSON 파싱 실패, status=${res.status}, length=${text.length})`);
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ecosAllRootCategories() {
  const all = [];
  let start = 1;
  const pageSize = 100;
  for (let page = 0; page < 15; page++) {
    const end = start + pageSize - 1;
    const json = await fetchJson(`StatisticTableList/{KEY}/json/kr/${start}/${end}/`);
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

async function listItems(tableCode, label) {
  console.log(`\n=== 통계표 ${tableCode} (${label}) 항목 목록 ===`);
  const json = await fetchJson(`StatisticItemList/{KEY}/json/kr/1/200/${tableCode}`);
  if (!json) return [];
  if (json.RESULT) {
    console.log("  RESULT:", JSON.stringify(json.RESULT));
    return [];
  }
  const rows = json.StatisticItemList?.row || [];
  console.log(`  rows: ${rows.length}`);
  for (const r of rows) {
    console.log(`  ITEM_CODE=${r.ITEM_CODE}  ITEM_NAME=${r.ITEM_NAME}  ITEM_NAME2=${r.ITEM_NAME2}  ITEM_NAME3=${r.ITEM_NAME3}  CYCLE=${r.CYCLE}`);
  }
  return rows;
}

async function main() {
  console.log("=== ECOS 전체 카테고리 조회(페이지네이션) ===");
  const all = await ecosAllRootCategories();
  console.log(`  총 ${all.length}건 수집`);

  const keywords = /공급|입주|준공|인허가|착공|건설실적|미분양/;
  const matches = all.filter((r) => keywords.test(r.STAT_NAME));
  console.log(`\n  공급 관련 키워드 매칭 ${matches.length}건:`);
  for (const r of matches) {
    console.log(`    STAT_CODE=${r.STAT_CODE}  STAT_NAME=${r.STAT_NAME}  SRCH_YN=${r.SRCH_YN}`);
  }

  // 이미 알려진 후보(주택건설인허가실적) 항목 목록 확인
  await listItems("901Y105", "주택건설인허가실적");
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
