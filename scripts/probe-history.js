// 임시 조사용. 국내 ETF의 과거 종가를 받아올 수 있는지 GitHub Actions에서 확인한다.
// (개발 환경에서는 외부 망이 막혀 직접 확인할 수 없다.) 확인 후 이 파일은 지운다.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const head = (s, n = 500) => String(s).slice(0, n).replace(/\s+/g, " ");

async function probe(label, fn) {
  console.log(`\n=== ${label} ===`);
  try {
    await fn();
  } catch (e) {
    console.log(`  실패: ${e.message}`);
  }
}

function ymd(back) {
  const d = new Date();
  d.setDate(d.getDate() - back);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

async function main() {
  const code = "069500"; // KODEX 200
  console.log(`오늘=${ymd(0)} 1년전=${ymd(370)}`);

  await probe("네이버 siseJson (일봉)", async () => {
    const url = `https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${ymd(370)}&endTime=${ymd(0)}&timeframe=day`;
    const res = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://finance.naver.com/" } });
    const t = await res.text();
    console.log(`  status=${res.status} len=${t.length}`);
    console.log(`  앞부분: ${head(t, 300)}`);
    console.log(`  뒷부분: ${head(t.slice(-200), 200)}`);
  });

  await probe("네이버 fchart (일봉 XML)", async () => {
    const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=day&count=300&requestType=0`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const t = await res.text();
    console.log(`  status=${res.status} len=${t.length}`);
    console.log(`  앞부분: ${head(t, 400)}`);
  });

  await probe("네이버 모바일 price API", async () => {
    const url = `https://api.stock.naver.com/chart/domestic/item/${code}/day?startDateTime=${ymd(370)}0000&endDateTime=${ymd(0)}0000`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const t = await res.text();
    console.log(`  status=${res.status} len=${t.length}`);
    console.log(`  앞부분: ${head(t, 400)}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
