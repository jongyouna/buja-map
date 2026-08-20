// API 백엔드 + 정적 파일 서빙
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".js": "application/javascript",
  ".css": "text/css",
};

// 캐시된 데이터 (30분 유지)
let cachedData = null;
let cachedDataTime = 0;
let cachedNaverLand = null;
let cachedNaverLandTime = 0;

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function loadDataJson() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "data.json"), "utf-8"));
    return data;
  } catch (err) {
    console.error("Failed to load data.json:", err.message);
    return null;
  }
}

async function loadNaverLandJson() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "naver-land.json"), "utf-8"));
    return data;
  } catch (err) {
    console.error("Failed to load naver-land.json:", err.message);
    return null;
  }
}

async function handleApiData(req, res) {
  const now = Date.now();

  // 캐시가 30분 이내면 재사용
  if (cachedData && now - cachedDataTime < 30 * 60 * 1000) {
    setCorsHeaders(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cachedData));
    return;
  }

  const data = await loadDataJson();
  if (!data) {
    setCorsHeaders(res);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to load data" }));
    return;
  }

  cachedData = data;
  cachedDataTime = now;

  setCorsHeaders(res);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function handleApiNaverLand(req, res) {
  const now = Date.now();

  // 캐시가 1시간 이내면 재사용
  if (cachedNaverLand && now - cachedNaverLandTime < 60 * 60 * 1000) {
    setCorsHeaders(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(cachedNaverLand));
    return;
  }

  const data = await loadNaverLandJson();
  if (!data) {
    setCorsHeaders(res);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to load naver-land data" }));
    return;
  }

  cachedNaverLand = data;
  cachedNaverLandTime = now;

  setCorsHeaders(res);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

http
  .createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    let urlPath = decodeURIComponent(parsedUrl.pathname);

    // OPTIONS 요청 처리 (CORS preflight)
    if (req.method === "OPTIONS") {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // API 엔드포인트
    if (urlPath === "/api/data") {
      handleApiData(req, res);
      return;
    }

    if (urlPath === "/api/naver-land") {
      handleApiNaverLand(req, res);
      return;
    }

    // 정적 파일 서빙
    if (urlPath === "/") urlPath = "/index.html";
    const filePath = path.join(ROOT, urlPath);

    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
