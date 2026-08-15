// KRX 전종목(ETF + 주식) 코드·이름·종가를 받아 data/krx-quotes.json 으로 저장한다.
//
// 자산 배분 탭에서 쓰는 용도가 두 가지다.
//   1) 종목명 검색: 사용자가 "미국S&P500"이라고 치면 후보를 찾아 종목코드를 붙여 준다.
//   2) 현재가 대체값: 브라우저에서 실시간 시세를 직접 못 받아오면(아래 설명) 이 값을 쓴다.
//
// 브라우저에서 증권사·네이버 시세 API를 직접 부르는 것은 CORS 정책에 막힐 수 있다.
// 막히는지 여부는 그 서버가 정하는 것이라 우리가 어떻게 할 수 없으므로, 실시간 호출이
// 실패해도 화면이 비지 않도록 이 스냅샷을 항상 함께 배포한다. 화면에는 어느 쪽 값인지와
// 기준 시각을 같이 보여 준다.
//
// KRX 정보데이터시스템(data.krx.co.kr)은 브라우저에서 직접 부르면 CORS에 막히지만,
// GitHub Actions(서버)에서는 아무 문제 없이 호출된다. 그래서 수집은 여기서 한다.

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "data", "krx-quotes.json");
const ENDPOINT = "https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd";
const REFERER = "https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// 조회할 화면(bld)들. ETF와 주식을 모두 담아야 검색에서 둘 다 찾을 수 있다.
const BOARDS = [
  { kind: "etf", bld: "dbms/MDC/STAT/standard/MDCSTAT04301" }, // ETF 전종목 시세
  { kind: "stock", bld: "dbms/MDC/STAT/standard/MDCSTAT01501" }, // 주식 전종목 시세
];

function yyyymmdd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// KRX는 숫자를 "1,234" 같은 문자열로 준다. 빈 값("-", "")은 null로 둔다.
function num(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/,/g, "").trim();
  if (!s || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function fetchBoard(bld, trdDd) {
  const body = new URLSearchParams({
    bld,
    locale: "ko_KR",
    trdDd,
    share: "1",
    money: "1",
    csvxls_isNo: "false",
  });
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": UA,
      Referer: REFERER,
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
  });
  if (!res.ok) throw new Error(`KRX ${bld} ${trdDd} 응답 ${res.status}`);
  const json = await res.json();
  // 화면에 따라 output / OutBlock_1 로 키 이름이 다르다.
  const rows = json.output || json.OutBlock_1 || [];
  if (!Array.isArray(rows)) throw new Error(`KRX ${bld} 응답 형식이 예상과 다릅니다`);
  return rows;
}

function normalize(rows, kind) {
  return rows
    .map((r) => {
      const code = String(r.ISU_SRT_CD || "").trim();
      const name = String(r.ISU_ABBRV || "").trim();
      const price = num(r.TDD_CLSPRC);
      if (!/^\d{6}$/.test(code) || !name || !price) return null;
      const change = num(r.CMPPREVDD_PRC);
      return {
        code,
        name,
        kind,
        price,
        // 전일종가. 화면의 "전일대비(%)"를 시세와 같은 기준으로 계산하기 위해 함께 담는다.
        prevClose: change === null ? null : price - change,
      };
    })
    .filter(Boolean);
}

// 주말·공휴일에는 그날 데이터가 비어 있다. 최근 영업일을 찾을 때까지 하루씩 뒤로 간다.
async function fetchLatest() {
  const today = new Date();
  for (let back = 0; back < 10; back++) {
    const d = new Date(today);
    d.setDate(d.getDate() - back);
    const trdDd = yyyymmdd(d);
    const items = [];
    for (const board of BOARDS) {
      const rows = await fetchBoard(board.bld, trdDd);
      items.push(...normalize(rows, board.kind));
    }
    if (items.length) return { tradeDate: trdDd, items };
    console.log(`${trdDd}: 데이터 없음(휴장일로 보임), 하루 전으로 재시도`);
  }
  throw new Error("최근 10일 안에 거래일 데이터를 찾지 못했습니다");
}

async function main() {
  const { tradeDate, items } = await fetchLatest();
  // 같은 코드가 두 화면에 겹쳐 나오면 먼저 담긴 쪽(ETF)을 남긴다.
  const byCode = new Map();
  for (const it of items) if (!byCode.has(it.code)) byCode.set(it.code, it);
  const list = [...byCode.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));

  const payload = {
    updatedAt: new Date().toISOString(),
    tradeDate, // 이 종가가 어느 거래일 것인지. 화면에 그대로 보여 준다.
    source: "KRX 정보데이터시스템(data.krx.co.kr)",
    count: list.length,
    items: list,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload), "utf-8");
  console.log(`${list.length}종목 저장 (거래일 ${tradeDate}) -> ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
