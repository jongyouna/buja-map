// 일회성 디버그: odcloud 인증키 내부 개행문자 제거 후 재시도. 사용 후 삭제 예정.
// 주의: 키 값 자체는 절대 로그에 출력하지 않음 — 길이/특수문자 존재 여부만 출력.
const RAW = process.env.MOLIT_DATA_API_KEY || "";
const KEY = RAW.replace(/[\r\n\t ]/g, ""); // 모든 공백/개행 제거 (중간에 있어도 제거)

console.log("키 원본 길이:", RAW.length, "공백 제거 후 길이:", KEY.length);
console.log("키에 %가 포함되어 있음:", KEY.includes("%"));

const PATH = "15111714/v1/uddi:0b257760-ac19-4841-adb4-b38b4d153397";

async function attempt(label, url, opts) {
  console.log(`\n=== ${label} ===`);
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    console.log("status:", res.status, "length:", text.length);
    console.log("body head:", text.slice(0, 500));
  } catch (e) {
    console.log("ERROR:", e.message);
  }
}

async function main() {
  await attempt(
    "A: 공백제거 키를 인코딩 없이 그대로(이미 encoded key)",
    `https://api.odcloud.kr/api/${PATH}?page=1&perPage=5&serviceKey=${KEY}`
  );
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
