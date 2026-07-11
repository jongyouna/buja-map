// 일회성 디버그: apt2.me 페이지 구조 확인용. 사용 후 삭제 예정.
async function main() {
  const url = "https://apt2.me/global_index.jsp";
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
  console.log("---- full html (first 8000 chars) ----");
  console.log(html.slice(0, 8000));
  console.log("---- tables ----");
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)];
  console.log("table count:", tables.length);
  tables.forEach((t, i) => {
    console.log(`-- table ${i} (first 1500 chars) --`);
    console.log(t[0].slice(0, 1500));
  });
  console.log("---- script tags (first 200 chars each) ----");
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  scripts.forEach((s, i) => {
    console.log(`-- script ${i} --`);
    console.log(s[0].slice(0, 300));
  });
}
main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
