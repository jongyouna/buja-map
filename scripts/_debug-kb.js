// 일회성 디버그: ECOS 901Y062(주택매매가격지수, KB)에서 서울 아파트 항목코드 확인 + 조회 테스트. 사용 후 삭제 예정.
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

async function main() {
  console.log("=== 통계표 901Y062 (주택매매가격지수, KB) 항목 목록 ===");
  const json = await fetchJson("StatisticItemList/{KEY}/json/kr/1/200/901Y062");
  if (!json) return;
  if (json.RESULT) {
    console.log("  RESULT:", JSON.stringify(json.RESULT));
    return;
  }
  const rows = json.StatisticItemList?.row || [];
  console.log(`  rows: ${rows.length}`);
  const seoulOrApt = rows.filter((r) => /서울|아파트/.test(r.ITEM_NAME) || /서울|아파트/.test(r.ITEM_NAME2 || ""));
  for (const r of seoulOrApt) {
    console.log(`  ITEM_CODE=${r.ITEM_CODE}  ITEM_NAME=${r.ITEM_NAME}  ITEM_NAME2=${r.ITEM_NAME2}  ITEM_NAME3=${r.ITEM_NAME3}  CYCLE=${r.CYCLE}`);
  }
  console.log(`\n(참고: 서울/아파트 매칭 ${seoulOrApt.length}건, 전체 ${rows.length}건 중)`);
  console.log("\n=== 전체 항목 (처음 40개) ===");
  for (const r of rows.slice(0, 40)) {
    console.log(`  ITEM_CODE=${r.ITEM_CODE}  ITEM_NAME=${r.ITEM_NAME}  ITEM_NAME2=${r.ITEM_NAME2}  ITEM_NAME3=${r.ITEM_NAME3}  CYCLE=${r.CYCLE}`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
