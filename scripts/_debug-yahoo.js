// 일회성 디버그: 야후 파이낸스에서 코스피200 관련 티커 후보 탐색. 사용 후 삭제 예정.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) buja-map-dashboard";

const candidates = [
  "^KS200",
  "KS200=F",
  "101S9000",
  "101S06.KS",
  "^KOSPI200",
  "KOSPI200.KS",
  "K200",
];

async function tryTicker(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=5d&interval=1d`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const json = await res.json().catch(() => null);
    const result = json && json.chart && json.chart.result && json.chart.result[0];
    if (result) {
      console.log(
        `OK   ${symbol}: status=${res.status} longName=${result.meta.longName || result.meta.shortName} currency=${result.meta.currency} lastClose=${result.meta.regularMarketPrice}`
      );
    } else {
      console.log(`FAIL ${symbol}: status=${res.status} error=${JSON.stringify(json && json.chart && json.chart.error)}`);
    }
  } catch (e) {
    console.log(`ERR  ${symbol}: ${e.message}`);
  }
}

async function trySearch(query) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const json = await res.json().catch(() => null);
    console.log(`SEARCH "${query}": status=${res.status}`);
    if (json && json.quotes) {
      for (const q of json.quotes.slice(0, 10)) {
        console.log("  ", JSON.stringify({ symbol: q.symbol, shortname: q.shortname, longname: q.longname, quoteType: q.quoteType, exchange: q.exchange }));
      }
    } else {
      console.log("  raw:", JSON.stringify(json).slice(0, 500));
    }
  } catch (e) {
    console.log(`SEARCH ERR "${query}": ${e.message}`);
  }
}

async function main() {
  for (const c of candidates) {
    await tryTicker(c);
  }
  await trySearch("KOSPI 200 futures");
  await trySearch("KOSPI200");
}
main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
