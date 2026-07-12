// 일회성 디버그: ECOS 901Y062/P63ACA(서울 아파트 매매가격지수, KB) StatisticSearch 테스트. 사용 후 삭제 예정.
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
  console.log("=== StatisticSearch 테스트: 서울 아파트 매매가격지수(KB) 901Y062/P63ACA ===");
  const json = await fetchJson("StatisticSearch/{KEY}/json/kr/1/500/901Y062/M/200301/202612/P63ACA");
  if (!json) return;
  if (json.RESULT) {
    console.log("  RESULT:", JSON.stringify(json.RESULT));
    return;
  }
  const rows = json.StatisticSearch?.row || [];
  console.log(`  rows: ${rows.length}`);
  console.log("  first 3:", JSON.stringify(rows.slice(0, 3)));
  console.log("  last 3:", JSON.stringify(rows.slice(-3)));
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
