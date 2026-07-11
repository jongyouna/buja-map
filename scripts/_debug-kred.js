// 일회성 디버그 스크립트: kred.dev 페이지 구조 확인용. 사용 후 삭제 예정.
async function main() {
  const url = "https://kred.dev/ko/kospi-200-night-futures";
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9",
    },
  });
  console.log("status:", res.status);
  const html = await res.text();
  console.log("length:", html.length);
  console.log("---- first 4000 chars ----");
  console.log(html.slice(0, 4000));
  console.log("---- script tags with json/NEXT_DATA/NUXT/__INITIAL ----");
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  for (const s of scripts) {
    if (/__NEXT_DATA__|__NUXT__|__INITIAL_STATE__|application\/json/i.test(s[0].slice(0, 200))) {
      console.log(s[0].slice(0, 2000));
      console.log("----");
    }
  }
  console.log("---- tables ----");
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)];
  console.log("table count:", tables.length);
  if (tables[0]) console.log(tables[0][0].slice(0, 2000));
}
main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
