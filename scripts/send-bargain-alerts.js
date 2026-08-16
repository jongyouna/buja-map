// 급매 알림 이메일 발송.
//
// data/naver-land.json(수집 결과)과 Firestore의 사용자별 알림 설정을 맞춰 보고,
// 조건에 드는 급매가 있으면 그 사용자의 계정 이메일로 목록을 보낸다.
//
// 왜 브라우저가 아니라 여기서 보내는가:
// 정적 페이지에서는 메일을 보낼 수 없고, Firestore만으로도 보낼 수 없다. 매물 수집을
// 이미 자체 러너에서 돌리고 있으므로 발송도 같은 자리에서 처리한다.
//
// 실행에 필요한 것(둘 다 GitHub Actions 시크릿):
//   FIREBASE_SERVICE_ACCOUNT  Firebase 콘솔 > 프로젝트 설정 > 서비스 계정에서 받은 JSON 전체
//   SMTP_URL                  smtps://아이디:앱비밀번호@smtp.gmail.com:465 형식
//                             (Gmail은 2단계 인증 후 "앱 비밀번호"를 발급해 써야 한다)
// 하나라도 없으면 아무것도 보내지 않고 이유를 남기고 끝낸다. 조용히 실패하지 않는다.
//
// 보내기 전 확인만 하고 싶으면 DRY_RUN=1 로 실행한다. 받는 사람과 건수만 찍는다.
const fs = require("fs");
const path = require("path");

const PYEONG_M2 = 3.305785;
const DRY_RUN = process.env.DRY_RUN === "1";
const MAX_ROWS_PER_MAIL = 50; // 메일이 끝없이 길어지지 않도록

function readData() {
  const p = path.join(__dirname, "..", "data", "naver-land.json");
  const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  return { regions: parsed.regions || [], updatedAt: parsed.updatedAt || null };
}

// 화면(index.html)의 칩 판정과 같은 규칙. 동 칩은 매물 주소의 동을 본다.
function matchesChip(region, row, c) {
  if (region.si !== c.si) return false;
  if (c.level === "si") return true;
  if (region.gugun !== c.gugun) return false;
  if (c.level === "gugun") return true;
  return (row.dong || region.dong) === c.dong;
}

function rowArea(c) {
  return c.exclusiveArea ?? c.supplyArea ?? c.avgArea ?? null;
}

function pyeongAskMin(c) {
  if (c.pyeongAskMin != null) return c.pyeongAskMin;
  const supply = c.supplyArea ?? c.avgArea ?? null;
  if (c.minPrice == null || supply == null) return null;
  return Math.round(c.minPrice / (supply / PYEONG_M2));
}

const fmtEok = (manwon) => (manwon == null ? "–" : `${(manwon / 10000).toFixed(1)}억`);

// 사용자가 저장해 둔 필터로 급매만 골라낸다.
function pickBargains(regions, f) {
  const include = Array.isArray(f.include) ? f.include : [];
  const exclude = Array.isArray(f.exclude) ? f.exclude : [];
  if (include.length === 0) return [];
  const pct = Number(f.bargainPct) > 0 ? Number(f.bargainPct) : 5;
  const trade = f.trade || "A1";
  const minDeals = f.dealCount ? Number(f.dealCount) : null;
  const out = [];
  // 흑석동처럼 구 지역과 동 지역에 같은 단지가 함께 들어 있어, 화면과 똑같이
  // (단지 × 면적)으로 한 번만 센다. 안 그러면 메일에 같은 줄이 두 번 실린다.
  const seen = new Set();

  for (const region of regions) {
    for (const c of region.complexes) {
      if (c.tradeType !== trade) continue;
      if (!include.some((chip) => matchesChip(region, c, chip))) continue;
      if (exclude.some((chip) => matchesChip(region, c, chip))) continue;

      const area = rowArea(c);
      if (f.pyeongMin != null || f.pyeongMax != null) {
        const lo = Number(f.pyeongMin) || 0;
        const hi = Number(f.pyeongMax);
        const openTop = !Number.isFinite(hi) || hi >= 60;
        if (!(lo === 0 && openTop)) {
          if (area == null) continue;
          const py = area / PYEONG_M2;
          if (py < lo) continue;
          if (!openTop && py >= hi) continue;
        }
      }

      const priceMin = (Number(f.priceMin) || 0) * 10000;
      const priceMaxStep = Number(f.priceMax);
      const priceMax = !Number.isFinite(priceMaxStep) || priceMaxStep >= 50 ? Infinity : priceMaxStep * 10000;
      if (c.minPrice == null) continue;
      if (c.minPrice < priceMin || c.minPrice > priceMax) continue;

      if (f.age) {
        if (c.approvalElapsedYear == null) continue;
        if (f.age === "20+" ? c.approvalElapsedYear <= 20 : c.approvalElapsedYear > Number(f.age)) continue;
      }
      if (minDeals != null && c.count < minDeals) continue;

      if (!(c.realMaxPrice > 0)) continue;
      const off = ((c.realMaxPrice - c.minPrice) / c.realMaxPrice) * 100;
      if (off < pct) continue;

      const key = `${c.complexNo ?? c.complexName}|${area == null ? "" : area.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push({
        region: [region.si ? `${region.si}시` : null, region.gugun, c.dong || region.dong].filter(Boolean).join(" "),
        name: c.complexName,
        area,
        minPrice: c.minPrice,
        realMaxPrice: c.realMaxPrice,
        off,
        count: c.count,
        pyeongAsk: pyeongAskMin(c),
        complexNo: c.complexNo,
      });
    }
  }
  // 많이 빠진 순으로. 같은 단지의 다른 평형이 여러 줄 나올 수 있다.
  out.sort((a, b) => b.off - a.off);
  return out;
}

function buildHtml(rows, f, updatedAt, total) {
  const head = ["지역", "단지명", "전용", "최저가", "실거래 최고가", "하락률", "매물"];
  const body = rows
    .map((r) => {
      const link = r.complexNo
        ? `<a href="https://fin.land.naver.com/complexes/${r.complexNo}?tab=article" style="color:#111;">${r.name}</a>`
        : r.name;
      return (
        "<tr>" +
        [
          r.region,
          link,
          r.area == null ? "–" : `${r.area.toFixed(1)}㎡`,
          fmtEok(r.minPrice),
          fmtEok(r.realMaxPrice),
          `<b style="color:#d33;">-${r.off.toFixed(1)}%</b>`,
          `${r.count}건`,
        ]
          .map((v) => `<td style="padding:6px 10px;border-bottom:1px solid #eee;">${v}</td>`)
          .join("") +
        "</tr>"
      );
    })
    .join("");
  const more = total > rows.length ? `<p>이 밖에 ${total - rows.length}건이 더 있습니다.</p>` : "";
  return `<div style="font-family:system-ui,sans-serif;color:#111;">
  <h2>급매 ${total}건</h2>
  <p style="color:#666;font-size:13px;">
    조건: 지역 ${(f.include || []).map((c) => c.label).join(", ") || "(없음)"} ·
    급매 기준 실거래 최고가 대비 ${f.bargainPct || 5}% 이상 하락<br/>
    매물 수집 기준 시각: ${updatedAt ? new Date(updatedAt).toLocaleString("ko-KR") : "알 수 없음"}
  </p>
  <table style="border-collapse:collapse;font-size:13px;">
    <tr>${head.map((h) => `<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #333;">${h}</th>`).join("")}</tr>
    ${body}
  </table>
  ${more}
  <p style="color:#888;font-size:12px;margin-top:18px;">
    이 메일은 buja-map에서 직접 신청하신 급매 알림입니다. 급매 Now! 탭의 "급매 알림"에서 끌 수 있습니다.
  </p>
</div>`;
}

function shouldSendToday(frequency) {
  if (frequency !== "weekly") return true;
  // 주 1회는 월요일에만 보낸다(한국 시간 기준).
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return kst.getUTCDay() === 1;
}

async function main() {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  const smtp = process.env.SMTP_URL;
  if (!sa || !smtp) {
    console.error(
      "[건너뜀] 발송에 필요한 시크릿이 없습니다. " +
        `FIREBASE_SERVICE_ACCOUNT=${sa ? "있음" : "없음"}, SMTP_URL=${smtp ? "있음" : "없음"}. ` +
        "docs/bargain-alerts.md 를 참고해 저장소 시크릿을 등록해 주세요."
    );
    return;
  }

  // firebase-admin은 버전마다 루트 export가 다르다(v11은 admin.credential.cert,
  // v14는 admin.cert). 어느 쪽이든 있는 서브패스 진입점을 쓴다.
  const { initializeApp, cert } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const nodemailer = require("nodemailer");
  initializeApp({ credential: cert(JSON.parse(sa)) });
  const db = getFirestore();

  const { regions, updatedAt } = readData();
  const snap = await db.collection("users").get();
  const transport = nodemailer.createTransport(smtp);

  let sent = 0;
  let skipped = 0;
  for (const docSnap of snap.docs) {
    const u = docSnap.data();
    const alert = u.bargainAlert;
    if (!alert?.enabled) continue;
    if (u.alertsAllowed === false) {
      console.log(`  건너뜀(관리자 차단): ${u.email}`);
      skipped++;
      continue;
    }
    if (u.blocked) {
      skipped++;
      continue;
    }
    if (!shouldSendToday(alert.frequency)) continue;
    const to = alert.email || u.email;
    if (!to) continue;

    const rows = pickBargains(regions, alert.filters || {});
    if (rows.length === 0) {
      console.log(`  보낼 것 없음: ${to}`);
      continue;
    }
    const html = buildHtml(rows.slice(0, MAX_ROWS_PER_MAIL), alert.filters || {}, updatedAt, rows.length);
    if (DRY_RUN) {
      console.log(`  [연습] ${to} <- 급매 ${rows.length}건`);
      sent++;
      continue;
    }
    try {
      await transport.sendMail({
        from: process.env.SMTP_FROM || to,
        to,
        subject: `[buja-map] 급매 ${rows.length}건`,
        html,
      });
      await docSnap.ref.set(
        { bargainAlert: { ...alert, lastSentAt: new Date().toISOString(), lastSentCount: rows.length } },
        { merge: true }
      );
      console.log(`  보냄: ${to} (${rows.length}건)`);
      sent++;
    } catch (err) {
      console.error(`  실패: ${to} — ${err.message}`);
    }
  }
  console.log(`[완료] 발송 ${sent}건 / 건너뜀 ${skipped}건${DRY_RUN ? " (연습 실행)" : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
