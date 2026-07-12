// 일회성 디버그: 실제 배포된 대시보드를 스크린샷으로 확인. 사용 후 삭제 예정.
const { chromium } = require("playwright");

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  await page.goto("https://jongyouna.github.io/buja-map/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "screenshot-default.png", fullPage: true });

  await page.click('button[data-period="1y"]');
  await page.waitForTimeout(800);
  await page.screenshot({ path: "screenshot-1y.png", fullPage: true });

  console.log("console/page errors:", JSON.stringify(consoleErrors));
  await browser.close();
}
main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
