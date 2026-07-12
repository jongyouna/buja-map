// 일회성 디버그: 901Y105(주택건설인허가실적) 서울 항목의 세부(아파트 등) 분류 확인 + 901Y103 확인. 사용 후 삭제 예정.
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

async function listItems(pathSuffix, label) {
  console.log(`\n=== StatisticItemList ${pathSuffix} (${label}) ===`);
  const json = await fetchJson(`StatisticItemList/{KEY}/json/kr/1/200/${pathSuffix}`);
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

async function testSearch(tableCode, itemPath, label) {
  console.log(`\n=== StatisticSearch 테스트: ${label} ===`);
  const json = await fetchJson(`StatisticSearch/{KEY}/json/kr/1/15/${tableCode}/M/202301/202412/${itemPath}`);
  if (!json) return;
  if (json.RESULT) {
    console.log("  RESULT:", JSON.stringify(json.RESULT));
    return;
  }
  const rows = json.StatisticSearch?.row || [];
  console.log(`  rows: ${rows.length}`);
  console.log("  sample:", JSON.stringify(rows.slice(0, 3)));
}

async function main() {
  // 901Y105 서울 항목 하위에 아파트 등 유형별 세분류가 있는지 확인
  await listItems("901Y105/SEO", "901Y105 서울 하위");

  // 901Y103 건축착공현황
  await listItems("901Y103", "건축착공현황");

  // 901Y105 서울(SEO) 자체로 실제 값 조회가 되는지 확인 (전체 주택유형 합계)
  await testSearch("901Y105", "SEO", "901Y105/SEO (서울 전체 주택유형)");
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
