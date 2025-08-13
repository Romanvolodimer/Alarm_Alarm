import express from "express";
import { WebSocketServer } from "ws";
import puppeteer from "puppeteer";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const requiredEnv = [
  "LOGIN_URL",
  "USERNAME",
  "PASSWORD",
  "USERNAME_SELECTOR",
  "PASSWORD_SELECTOR",
  "SUBMIT_SELECTOR",
  "METRIC_SELECTOR",
];
const missing = requiredEnv.filter(
  (k) => !process.env[k] || process.env[k].trim() === ""
);
if (missing.length) {
  console.error("❌ У файлі .env відсутні або порожні такі змінні:");
  missing.forEach((k) => console.error(`   - ${k}`));
  process.exit(1);
}

const {
  LOGIN_URL,
  USERNAME,
  PASSWORD,
  USERNAME_SELECTOR,
  PASSWORD_SELECTOR,
  SUBMIT_SELECTOR,
  METRIC_SELECTOR,
} = process.env;

let TH = Number(process.env.THRESHOLD || "0");
let INTERVAL_MS = Number(process.env.POLL_INTERVAL || "15") * 1000;
const PORT = Number(process.env.PORT || 3000);

const app = express();

// статичний фронтенд
app.use(express.static(path.join(__dirname, "public")));

// легкий пінг-роут (для UptimeRobot/браузера)
app.get("/ping", (_req, res) => res.status(200).send("ok"));

const server = app.listen(PORT, () => {
  console.log(`✅ Веб інтерфейс: http://localhost:${PORT}`);
});

const wss = new WebSocketServer({ server });

function broadcast(obj) {
  const data = JSON.stringify(obj);
  wss.clients.forEach((c) => {
    try {
      c.send(data);
    } catch {}
  });
}

function sendConfig(ws) {
  ws?.send(
    JSON.stringify({
      type: "config",
      threshold: TH,
      pollIntervalMs: INTERVAL_MS,
    })
  );
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  // Логін
  console.log("🔐 Вхід…", LOGIN_URL);
  await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });
  await page.waitForSelector(USERNAME_SELECTOR, { timeout: 30000 });
  await page.type(USERNAME_SELECTOR, USERNAME, { delay: 20 });
  await page.waitForSelector(PASSWORD_SELECTOR, { timeout: 30000 });
  await page.type(PASSWORD_SELECTOR, PASSWORD, { delay: 20 });
  await Promise.all([
    page.click(SUBMIT_SELECTOR),
    page.waitForNavigation({ waitUntil: "networkidle2" }),
  ]);
  console.log("✅ Увійшли. Починаю моніторинг…");

  async function checkMetric() {
    try {
      await page.waitForSelector(METRIC_SELECTOR, { timeout: 15000 });
      const raw = await page.$eval(METRIC_SELECTOR, (el) =>
        (el.innerText || el.textContent || "").trim()
      );
      const num = Number(
        String(raw)
          .replace(/[^\d.,-]/g, "")
          .replace(",", ".")
      );
      const ts = new Date().toISOString();
      broadcast({ type: "metric", value: num, raw, threshold: TH, ts });
      if (!Number.isNaN(num) && num < TH) {
        broadcast({ type: "alert", value: num, threshold: TH, ts });
      }
    } catch (err) {
      broadcast({
        type: "error",
        message: err.message,
        ts: new Date().toISOString(),
      });
    }
  }

  await checkMetric();
  let intervalHandle = setInterval(checkMetric, INTERVAL_MS);

  function resetInterval(newMs) {
    if (intervalHandle) clearInterval(intervalHandle);
    intervalHandle = setInterval(checkMetric, newMs);
  }

  // WebSocket керування
  wss.on("connection", (ws) => {
    sendConfig(ws);
    ws.on("message", (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === "setThreshold") {
          const v = Number(data.value);
          if (!Number.isNaN(v)) {
            TH = v;
            broadcast({
              type: "config",
              threshold: TH,
              pollIntervalMs: INTERVAL_MS,
            });
            broadcast({ type: "info", message: `Поріг оновлено до ${TH}` });
          }
        }
        if (data.type === "setPollIntervalMs") {
          const v = Number(data.value);
          if (!Number.isNaN(v) && v >= 1000) {
            INTERVAL_MS = v;
            resetInterval(INTERVAL_MS);
            broadcast({
              type: "config",
              threshold: TH,
              pollIntervalMs: INTERVAL_MS,
            });
            broadcast({
              type: "info",
              message: `Інтервал опитування ${Math.round(
                INTERVAL_MS / 1000
              )} с`,
            });
          }
        }
        if (data.type === "getConfig") sendConfig(ws);
        if (data.type === "checkNow") checkMetric();
      } catch {}
    });
  });

  process.on("SIGINT", async () => {
    console.log("\n🛑 Зупинка…");
    try {
      await browser.close();
    } catch {}
    process.exit(0);
  });
})();
