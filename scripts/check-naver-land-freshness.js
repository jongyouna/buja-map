// naver-land-daily.json의 최신 수집 시각이 오래됐으면 GitHub Actions output(stale=true)을
// 낸다. naver-scraper 러너 없이 ubuntu-latest에서도 돌 수 있도록 Playwright/네트워크를
// 쓰지 않는다. 날짜 키 문자열이 아니라 실제 updatedAt 타임스탬프로 경과 시간을 재므로
// KST/UTC 날짜 키 표기와 무관하게 정확하다.
const fs = require("fs");
const path = require("path");

const STALE_THRESHOLD_HOURS = 30; // 매일 새벽 2시(KST) 수집 주기 + 6시간 여유

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function main() {
  const dailyPath = path.join(__dirname, "..", "data", "naver-land-daily.json");
  let daily;
  try {
    daily = JSON.parse(fs.readFileSync(dailyPath, "utf8"));
  } catch (e) {
    setOutput("stale", "true");
    setOutput("message", `naver-land-daily.json을 읽지 못했습니다: ${e.message}`);
    return;
  }

  const dateKeys = Object.keys(daily).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
  if (dateKeys.length === 0) {
    setOutput("stale", "true");
    setOutput("message", "naver-land-daily.json에 날짜별 데이터가 없습니다.");
    return;
  }

  const latestKey = dateKeys.sort().at(-1);
  const updatedAt = daily[latestKey]?.updatedAt ? new Date(daily[latestKey].updatedAt) : null;
  const ageHours = updatedAt ? (Date.now() - updatedAt.getTime()) / 3600000 : Infinity;
  console.log(`[신선도] 최신 날짜: ${latestKey}, 경과 ${ageHours.toFixed(1)}시간`);

  if (ageHours > STALE_THRESHOLD_HOURS) {
    setOutput("stale", "true");
    setOutput(
      "message",
      `최신 네이버 매물 수집(${latestKey})이 ${ageHours.toFixed(1)}시간 전입니다. ` +
        "naver-scraper 러너(집 PC)가 켜져 있는지, 서비스로 정상 등록돼 있는지 확인해 주세요."
    );
  } else {
    setOutput("stale", "false");
  }
}

main();
