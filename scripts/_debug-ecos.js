// 일회성 디버그: M1/M2(신지표, 161Y001/161Y005) 항목코드 확인 + StatisticSearch 실제 조회 테스트. 사용 후 삭제 예정.
// 주의: URL(인증키 포함)은 절대 로그에 출력하지 않음 — 파싱된 JSON 내용만 출력.
const API_KEY = process.env.BOK_ECOS_API_KEY;
if (!API_KEY) {
  console.error("BOK_ECOS_API_KEY 환경변수가 설정되지 않음");
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

async function listItems(tableCode) {
  console.log(`\n=== 통계표 ${tableCode} 항목 목록 ===`);
  const json = await fetchJson(`StatisticItemList/{KEY}/json/kr/1/100/${tableCode}`);
  if (!json) return [];
  if (json.RESULT) {
    console.log("  RESULT:", JSON.stringify(json.RESULT));
    return [];
  }
  const rows = json.StatisticItemList?.row || [];
  for (const r of rows) {
    console.log(`  ITEM_CODE=${r.ITEM_CODE}  ITEM_NAME=${r.ITEM_NAME}  CYCLE=${r.CYCLE}`);
  }
  return rows;
}

async function testSearch(tableCode, itemCode, label) {
  console.log(`\n=== StatisticSearch 테스트: ${label} (${tableCode}/${itemCode}) ===`);
  const json = await fetchJson(
    `StatisticSearch/{KEY}/json/kr/1/15/${tableCode}/M/202401/202412/${itemCode}`
  );
  if (!json) return;
  if (json.RESULT) {
    console.log("  RESULT:", JSON.stringify(json.RESULT));
    return;
  }
  const rows = json.StatisticSearch?.row || [];
  console.log(`  rows: ${rows.length}`);
  for (const r of rows.slice(0, 5)) {
    console.log(`  TIME=${r.TIME}  DATA_VALUE=${r.DATA_VALUE}  UNIT_NAME=${r.UNIT_NAME}  ITEM_NAME1=${r.ITEM_NAME1}`);
  }
}

async function main() {
  const m1Items = await listItems("161Y001");
  const m2Items = await listItems("161Y005");

  // 총량(헤드라인) 항목으로 보이는 것 우선 테스트 - 목록 첫 항목으로 시도
  if (m1Items[0]) {
    await testSearch("161Y001", m1Items[0].ITEM_CODE, `M1 (${m1Items[0].ITEM_NAME})`);
  }
  if (m2Items[0]) {
    await testSearch("161Y005", m2Items[0].ITEM_CODE, `M2 (${m2Items[0].ITEM_NAME})`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
