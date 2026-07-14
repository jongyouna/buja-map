// 일회성 디버그: 기간(period) 파라미터 값에 따른 날짜리스트 범위 확인. 사용 후 삭제 예정.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36";

async function tryPeriod(기간) {
  const url = "https://data-api.kbland.kr/bfmstat/weekMnthlyHuseTrnd/priceIndex";
  const params = new URLSearchParams({
    월간주간구분코드: "01",
    매물종별구분: "01",
    매매전세코드: "01",
    지역코드: "11",
    기간: 기간,
  });
  try {
    const res = await fetch(`${url}?${params.toString()}`, { headers: { "User-Agent": UA } });
    const json = await res.json();
    const data = json?.dataBody?.data;
    if (!data) {
      console.log(`기간=${기간}: data 없음, resultCode=${json?.dataBody?.resultCode}`);
      return;
    }
    const dates = data.날짜리스트 || [];
    console.log(`기간=${기간}: 날짜리스트 길이=${dates.length}, 범위=${dates[0]}~${dates[dates.length - 1]}`);
  } catch (e) {
    console.log(`기간=${기간}: ERROR ${e.message}`);
  }
}

async function main() {
  for (const p of ["1", "3", "5", "10", "20", "0", "99", "30", "MAX", "ALL", ""]) {
    await tryPeriod(p);
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
