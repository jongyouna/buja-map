// 국내 상장 ETF의 종목코드·이름·현재가·전일대비를 받아 data/etf-quotes.json 으로 저장한다.
// 자산 배분 탭의 종목 검색과 현재가가 이 파일을 쓴다.
//
// 왜 브라우저에서 직접 안 받고 여기서 받는가:
//   네이버 시세 API는 Access-Control-Allow-Origin 헤더를 주지 않는다(2026-08 확인).
//   즉 브라우저에서 직접 호출하면 CORS에 무조건 막힌다. KRX 정보데이터시스템은
//   세션 쿠키 없이 부르면 400 "LOGOUT"을 돌려준다.
//   그래서 서버(GitHub Actions)에서 받아 정적 파일로 배포하고, 화면은 그 파일을 읽는다.
//   갱신 주기는 워크플로의 cron이 정한다(update-etf-quotes.yml).
//
// 한 번의 호출로 ETF 전 종목(1,100여 개)의 현재가가 오므로 종목 수와 무관하게 요청은 1건이다.

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "data", "etf-quotes.json");
const URL = "https://finance.naver.com/api/sise/etfItemList.nhn";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// 이 API는 EUC-KR로 응답한다. UTF-8로 읽으면 종목명이 전부 깨진다.
function decodeEucKr(buffer) {
  const decoded = new TextDecoder("euc-kr").decode(buffer);
  // ICU가 euc-kr을 모르면 TextDecoder가 조용히 대체문자를 채운다. 그대로 저장하면
  // 검색이 전혀 안 되므로 여기서 잡는다.
  if (decoded.includes("�")) throw new Error("EUC-KR 디코딩 실패(런타임 ICU 확인 필요)");
  return decoded;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const res = await fetch(URL, { headers: { "User-Agent": UA, Referer: "https://finance.naver.com/sise/etf.naver" } });
  if (!res.ok) throw new Error(`ETF 목록 응답 ${res.status}`);
  const text = decodeEucKr(await res.arrayBuffer());

  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`ETF 목록이 JSON이 아닙니다: ${text.slice(0, 200)}`);
  }
  const list = json?.result?.etfItemList;
  if (!Array.isArray(list) || !list.length) throw new Error("ETF 목록이 비어 있습니다");

  const items = list
    .map((it) => {
      const code = String(it.itemcode || "").trim();
      const name = String(it.itemname || "").trim();
      const price = num(it.nowVal);
      if (!/^\d{6}$/.test(code) || !name || !price) return null;
      return {
        code,
        name,
        price,
        // 전일대비 등락률(%). 표의 "전일대비(%)" 열에 그대로 쓴다.
        changeRate: num(it.changeRate),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));

  if (!items.length) throw new Error("쓸 수 있는 종목이 하나도 없습니다");

  const payload = {
    updatedAt: new Date().toISOString(),
    source: "네이버 금융 ETF 시세",
    count: items.length,
    items,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload), "utf-8");
  console.log(`${items.length}종목 저장 -> ${OUT}`);
  console.log(`예시: ${items.slice(0, 3).map((i) => `${i.name}(${i.code}) ${i.price}`).join(" / ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
