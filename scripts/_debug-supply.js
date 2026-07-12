// 일회성 디버그: odcloud 인증키 형식/인코딩 문제 진단. 사용 후 삭제 예정.
// 주의: 키 값 자체는 절대 로그에 출력하지 않음 — 길이/특수문자 존재 여부만 출력.
const RAW = process.env.MOLIT_DATA_API_KEY || "";
const KEY = RAW.trim();

console.log("키 원본 길이:", RAW.length, "trim 후 길이:", KEY.length);
console.log("trim으로 제거된 문자 있음:", RAW.length !== KEY.length);
console.log("키에 %가 포함되어 있음(이미 URL 인코딩된 키일 가능성):", KEY.includes("%"));
console.log("키에 +가 포함되어 있음:", KEY.includes("+"));
console.log("키에 개행문자 포함:", /[\r\n]/.test(RAW));

const PATH = "15111714/v1/uddi:0b257760-ac19-4841-adb4-b38b4d153397";

async function attempt(label, url, opts) {
  console.log(`\n=== ${label} ===`);
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    console.log("status:", res.status, "length:", text.length);
    console.log("body head:", text.slice(0, 300));
  } catch (e) {
    console.log("ERROR:", e.message);
  }
}

async function main() {
  // 1) trim된 키를 그대로(추가 인코딩 없이) 쿼리파라미터로 사용 - 이미 encoding된 키라고 가정
  await attempt(
    "A: trim한 키를 인코딩 없이 그대로 쿼리파라미터",
    `https://api.odcloud.kr/api/${PATH}?page=1&perPage=5&serviceKey=${KEY}`
  );

  // 2) trim된 키를 encodeURIComponent로 인코딩 - decoding 키라고 가정
  await attempt(
    "B: trim한 키를 encodeURIComponent로 인코딩",
    `https://api.odcloud.kr/api/${PATH}?page=1&perPage=5&serviceKey=${encodeURIComponent(KEY)}`
  );

  // 3) Authorization 헤더 (trim된 키)
  await attempt(
    "C: Authorization: Infuser {trim된 키}",
    `https://api.odcloud.kr/api/${PATH}?page=1&perPage=5`,
    { headers: { Authorization: `Infuser ${KEY}` } }
  );
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
