// 임시 조사용 스크립트. 어느 시세 소스가 실제로 동작하는지 GitHub Actions에서 확인한다.
// (개발 환경에서는 외부 망이 막혀 있어 직접 확인할 수 없다.)
// 확인이 끝나면 이 파일과 probe-quotes.yml 은 지운다.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function head(s, n = 400) {
  return String(s).slice(0, n).replace(/\n/g, " ");
}

async function probe(label, fn) {
  console.log(`\n=== ${label} ===`);
  try {
    await fn();
  } catch (err) {
    console.log(`  실패: ${err.message}`);
  }
}

function yyyymmdd(back) {
  const d = new Date();
  d.setDate(d.getDate() - back);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

async function krx(bld, extra, trdDd) {
  const body = new URLSearchParams({ bld, locale: "ko_KR", trdDd, share: "1", money: "1", csvxls_isNo: "false", ...extra });
  const res = await fetch("https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": UA,
      Referer: "https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd",
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
  });
  const text = await res.text();
  console.log(`  status=${res.status} len=${text.length}`);
  console.log(`  body: ${head(text)}`);
  try {
    const j = JSON.parse(text);
    const rows = j.output || j.OutBlock_1 || [];
    console.log(`  rows=${Array.isArray(rows) ? rows.length : "n/a"}`);
    if (Array.isArray(rows) && rows[0]) console.log(`  keys: ${Object.keys(rows[0]).join(",")}`);
    if (Array.isArray(rows) && rows[0]) console.log(`  sample: ${JSON.stringify(rows[0])}`);
  } catch (e) {
    /* JSON이 아니면 위의 body만 본다 */
  }
}

async function main() {
  const d0 = yyyymmdd(0);
  const d1 = yyyymmdd(1);
  const d3 = yyyymmdd(3);
  console.log(`오늘=${d0} 어제=${d1} 3일전=${d3}`);

  await probe("네이버 ETF 목록 API", async () => {
    const res = await fetch("https://finance.naver.com/api/sise/etfItemList.nhn", { headers: { "User-Agent": UA } });
    const text = await res.text();
    console.log(`  status=${res.status} len=${text.length}`);
    console.log(`  body: ${head(text, 500)}`);
    try {
      const j = JSON.parse(text);
      const list = j?.result?.etfItemList || [];
      console.log(`  items=${list.length}`);
      if (list[0]) console.log(`  keys: ${Object.keys(list[0]).join(",")}`);
    } catch (e) {}
  });

  await probe("네이버 실시간 시세(단일종목 069500)", async () => {
    const res = await fetch("https://polling.finance.naver.com/api/realtime/domestic/stock/069500", { headers: { "User-Agent": UA } });
    const text = await res.text();
    console.log(`  status=${res.status}`);
    console.log(`  CORS: ${res.headers.get("access-control-allow-origin")}`);
    console.log(`  body: ${head(text, 600)}`);
  });

  await probe("네이버 모바일 basic(069500)", async () => {
    const res = await fetch("https://m.stock.naver.com/api/stock/069500/basic", { headers: { "User-Agent": UA } });
    const text = await res.text();
    console.log(`  status=${res.status}`);
    console.log(`  CORS: ${res.headers.get("access-control-allow-origin")}`);
    console.log(`  body: ${head(text, 600)}`);
  });

  await probe("KRX ETF 시세 MDCSTAT04301 (오늘)", () => krx("dbms/MDC/STAT/standard/MDCSTAT04301", {}, d0));
  await probe("KRX ETF 시세 MDCSTAT04301 (3일전)", () => krx("dbms/MDC/STAT/standard/MDCSTAT04301", {}, d3));
  await probe("KRX 주식 시세 MDCSTAT01501 (3일전, mktId=ALL)", () => krx("dbms/MDC/STAT/standard/MDCSTAT01501", { mktId: "ALL" }, d3));
  await probe("KRX ETF 기본정보 MDCSTAT04601 (3일전)", () => krx("dbms/MDC/STAT/standard/MDCSTAT04601", {}, d3));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
