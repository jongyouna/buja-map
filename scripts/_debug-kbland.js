// 일회성 디버그: KB부동산 데이터허브(data-api.kbland.kr) 주택가격동향조사 API 응답 구조 확인. 사용 후 삭제 예정.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36";

async function main() {
  const url = "https://data-api.kbland.kr/bfmstat/weekMnthlyHuseTrnd/priceIndex";
  const params = new URLSearchParams({
    월간주간구분코드: "01",
    매물종별구분: "01",
    매매전세코드: "01",
    지역코드: "11",
  });
  const res = await fetch(`${url}?${params.toString()}`, { headers: { "User-Agent": UA } });
  const text = await res.text();
  console.log("status:", res.status, "length:", text.length);
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.log("JSON 파싱 실패, 원문 앞부분:", text.slice(0, 1000));
    return;
  }
  console.log("resultCode:", json?.dataBody?.resultCode);
  const data = json?.dataBody?.data;
  if (!data) {
    console.log("data 없음. 전체 응답 앞부분:", JSON.stringify(json).slice(0, 1500));
    return;
  }
  console.log("날짜리스트 길이:", data.날짜리스트?.length, "첫/마지막:", data.날짜리스트?.[0], data.날짜리스트?.[data.날짜리스트.length - 1]);
  console.log("데이터리스트 길이(지역 수):", data.데이터리스트?.length);
  for (const row of data.데이터리스트 || []) {
    console.log(`  지역코드=${row.지역코드} 지역명=${row.지역명} dataList길이=${row.dataList?.length}`);
  }
  console.log("\n첫 번째 지역 dataList 앞부분:", JSON.stringify((data.데이터리스트?.[0]?.dataList || []).slice(0, 10)));
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
