// 일회성 디버그: 한국은행 ECOS API에서 M1/M2 통계표·항목 코드 확인. 사용 후 삭제 예정.
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
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.log(`  (JSON 파싱 실패, status=${res.status}, length=${text.length})`);
    return null;
  }
  return json;
}

async function tryTable(tableCode) {
  console.log(`\n=== 통계표 ${tableCode} 항목 목록 ===`);
  const json = await fetchJson(`StatisticItemList/{KEY}/json/kr/1/100/${tableCode}`);
  if (!json) return;
  if (json.RESULT) {
    console.log("  RESULT:", JSON.stringify(json.RESULT));
    return;
  }
  const rows = json.StatisticItemList?.row || [];
  console.log(`  rows: ${rows.length}`);
  for (const r of rows) {
    console.log(`  ITEM_CODE=${r.ITEM_CODE}  ITEM_NAME=${r.ITEM_NAME}  STAT_NAME=${r.STAT_NAME}`);
  }
}

async function main() {
  // 후보 통계표: 통화 및 유동성지표 관련
  for (const code of ["101Y003", "101Y004", "121Y002"]) {
    await tryTable(code);
  }
}
main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
