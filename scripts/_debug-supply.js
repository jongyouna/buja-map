// 일회성 디버그: 입주예정물량정보 전체 규모/날짜범위/서울 필터링 확인. 사용 후 삭제 예정.
const RAW = process.env.MOLIT_DATA_API_KEY || "";
const KEY = RAW.replace(/[\r\n\t ]/g, "");
const PATH = "15111714/v1/uddi:0b257760-ac19-4841-adb4-b38b4d153397";

async function fetchPage(page, perPage) {
  const url = `https://api.odcloud.kr/api/${PATH}?page=${page}&perPage=${perPage}&serviceKey=${KEY}`;
  const res = await fetch(url);
  const json = await res.json();
  return json;
}

async function main() {
  const first = await fetchPage(1, 1);
  console.log("totalCount:", first.totalCount);

  // 전체 데이터를 가져와 지역/월 범위 확인 (perPage 최대치 시도)
  const all = await fetchPage(1, 3000);
  const rows = all.data || [];
  console.log("가져온 행 수:", rows.length, "(totalCount:", all.totalCount, ")");

  const months = rows.map((r) => r["입주예정월"]).filter(Boolean).sort();
  console.log("입주예정월 범위:", months[0], "~", months[months.length - 1]);

  const regions = [...new Set(rows.map((r) => r["지역"]))];
  console.log("지역 목록:", JSON.stringify(regions));

  const seoul = rows.filter((r) => r["지역"] === "서울");
  console.log("서울 행 수:", seoul.length);
  const seoulMonths = seoul.map((r) => r["입주예정월"]).filter(Boolean).sort();
  console.log("서울 입주예정월 범위:", seoulMonths[0], "~", seoulMonths[seoulMonths.length - 1]);

  // 서울 연도별 세대수 합산
  const byYear = {};
  for (const r of seoul) {
    const y = (r["입주예정월"] || "").slice(0, 4);
    if (!y) continue;
    byYear[y] = (byYear[y] || 0) + (r["세대수"] || 0);
  }
  console.log("서울 연도별 세대수 합계:", JSON.stringify(byYear, null, 2));

  console.log("\n샘플 서울 행 3개:", JSON.stringify(seoul.slice(0, 3), null, 2));
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
