import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { MongoClient } from "mongodb";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 8000);
const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
const botUsername = process.env.TELEGRAM_BOT_USERNAME || "";
const channelId = process.env.TELEGRAM_CHANNEL_ID || "";
const reviewChannelId = process.env.TELEGRAM_REVIEW_CHANNEL_ID || "";
const channelUsername = process.env.TELEGRAM_CHANNEL_USERNAME || "";
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const jwtSecret = process.env.JWT_SECRET || "local-development-secret-change-me";
const moderatorIds = new Set((process.env.MODERATOR_TELEGRAM_IDS || "").split(",").map((id) => id.trim()).filter(Boolean));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
let db;
let telegramWebhookReady = false;

app.use(express.json({ limit: "2mb" }));
app.use("/static", express.static(path.join(root, "static")));
const requireDb = (_req, res, next) => db ? next() : res.status(503).json({ error: "MongoDB is not configured" });
async function requireAuth(req, res, next) {
  const token = req.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return res.status(401).json({ error: "Нужно войти через Telegram" });
  try {
    const payload = jwt.verify(token, jwtSecret);
    req.user = await db.collection("users").findOne({ telegram_id: Number(payload.sub) });
    if (!req.user) return res.status(401).json({ error: "Аккаунт не найден" });
    req.user.is_moderator = req.user.role === "moderator" || moderatorIds.has(String(req.user.telegram_id));
    next();
  } catch { res.status(401).json({ error: "Сессия истекла. Войди снова." }); }
}
function requireModerator(req, res, next) {
  if (req.user?.is_moderator) return next();
  res.status(403).json({ error: "Доступ только для модераторов" });
}
app.get("/", (_req, res) => res.sendFile(path.join(root, "static", "index.html")));
app.get("/api/health", (_req, res) => res.json({
  ok: true,
  database: Boolean(db),
  telegram_configured: Boolean(botToken && botUsername),
  telegram_webhook: telegramWebhookReady,
}));
app.get("/api/config", (_req, res) => res.json({ channel_username: channelUsername, bot_ready: Boolean(botUsername && telegramWebhookReady) }));

app.get("/api/mods", requireDb, async (req, res, next) => {
  try {
    const filter = { status: "published" };
    if (req.query.q?.trim()) filter.$text = { $search: req.query.q.trim() };
    if (req.query.tag?.trim()) filter.tags = req.query.tag.trim();
    const mods = await db.collection("mods").find(filter).sort({ published_at: -1 }).limit(100).toArray();
    res.json({ mods: mods.map(({ _id, ...mod }) => mod) });
  } catch (error) { next(error); }
});

app.post("/api/auth/start", requireDb, async (_req, res, next) => {
  try {
    if (!botUsername || !telegramWebhookReady) return res.status(503).json({ error: "Telegram-вход пока не подключён. Проверь переменные бота и webhook в Render." });
    const ticket = crypto.randomBytes(20).toString("base64url");
    await db.collection("auth_tickets").insertOne({ ticket, created_at: new Date(), expires_at: new Date(Date.now() + 600_000) });
    res.json({ ticket, bot_url: `https://t.me/${botUsername}?start=${ticket}` });
  } catch (error) { next(error); }
});

app.get("/api/auth/status/:ticket", requireDb, async (req, res, next) => {
  try {
    const record = await db.collection("auth_tickets").findOne({ ticket: req.params.ticket, expires_at: { $gt: new Date() } });
    if (!record) return res.status(404).json({ error: "Ссылка истекла. Начни вход заново." });
    if (!record.telegram_id) return res.json({ linked: false });
    const user = await db.collection("users").findOne({ telegram_id: record.telegram_id });
    if (!user) return res.status(401).json({ error: "Аккаунт не найден" });
    const token = jwt.sign({ sub: String(user.telegram_id) }, jwtSecret, { expiresIn: "14d" });
    res.json({ linked: true, token, user: user.display_name || "Игрок" });
  } catch (error) { next(error); }
});

app.get("/api/me", requireDb, requireAuth, (req, res) => {
  res.json({
    user: {
      telegram_id: req.user.telegram_id,
      username: req.user.username,
      display_name: req.user.display_name,
      created_at: req.user.created_at,
      is_moderator: req.user.is_moderator,
    },
  });
});

app.get("/api/submissions/mine", requireDb, requireAuth, async (req, res, next) => {
  try {
    const submissions = await db.collection("submissions").find(
      { telegram_id: req.user.telegram_id },
      { projection: { _id: 0, submission_id: 1, title: 1, status: 1, created_at: 1, rejection_reason: 1 } },
    ).sort({ created_at: -1 }).limit(50).toArray();
    res.json({ submissions });
  } catch (error) { next(error); }
});

function submissionCaption(data) {
  const tags = data.tags.join(", ").slice(0, 120);
  const description = data.description.replace(/\s+/g, " ").slice(0, 650);
  return [
    `Название: ${data.title}`,
    `Автор: ${data.author}`,
    `Версия: ${data.game_version || "Не указана"}`,
    `Теги: ${tags || "Другое"}`,
    `Описание: ${description}`,
  ].join("\n").slice(0, 1000);
}

app.post("/api/submissions", requireDb, requireAuth, upload.single("file"), async (req, res, next) => {
  try {
    if (!botToken || !reviewChannelId) return res.status(503).json({ error: "Не настроен канал модерации Telegram" });
    if (!req.file) return res.status(400).json({ error: "Прикрепи файл мода" });
    const title = String(req.body.title || "").trim().slice(0, 120);
    const description = String(req.body.description || "").trim().slice(0, 2000);
    const gameVersion = String(req.body.game_version || "").trim().slice(0, 40);
    const tags = String(req.body.tags || "").split(/[,;]/).map((tag) => tag.trim().slice(0, 32)).filter(Boolean).slice(0, 10);
    if (!title || !description) return res.status(400).json({ error: "Заполни название и описание" });

    const submissionId = crypto.randomUUID();
    const caption = submissionCaption({ title, author: req.user.username ? `@${req.user.username}` : req.user.display_name, description, game_version: gameVersion, tags });
    const form = new FormData();
    form.set("chat_id", reviewChannelId);
    form.set("caption", caption);
    form.set("document", new Blob([req.file.buffer], { type: req.file.mimetype || "application/octet-stream" }), req.file.originalname);
    const tgResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, { method: "POST", body: form });
    const tgResult = await tgResponse.json();
    if (!tgResponse.ok || !tgResult.ok) {
      console.error(`Telegram upload failed: ${tgResult.error_code || tgResponse.status} ${tgResult.description || ""}`);
      return res.status(502).json({ error: "Telegram не принял файл. Проверь размер и настройки бота." });
    }
    const sent = tgResult.result;
    await db.collection("submissions").insertOne({
      submission_id: submissionId,
      telegram_id: req.user.telegram_id,
      author: req.user.username ? `@${req.user.username}` : req.user.display_name || "Игрок",
      title,
      description,
      game_version: gameVersion || "Не указана",
      tags: tags.length ? tags : ["Другое"],
      file_id: sent.document?.file_id,
      file_name: sent.document?.file_name || req.file.originalname,
      file_size: sent.document?.file_size || req.file.size,
      review_message_id: sent.message_id,
      caption,
      status: "pending",
      created_at: new Date(),
    });
    res.status(201).json({ ok: true, submission_id: submissionId, status: "pending" });
  } catch (error) { next(error); }
});

app.get("/api/moderation/pending", requireDb, requireAuth, requireModerator, async (_req, res, next) => {
  try {
    const submissions = await db.collection("submissions").find(
      { status: "pending" }, { projection: { _id: 0, submission_id: 1, title: 1, description: 1, game_version: 1, tags: 1, author: 1, file_name: 1, file_size: 1, created_at: 1 } },
    ).sort({ created_at: 1 }).limit(100).toArray();
    res.json({ submissions });
  } catch (error) { next(error); }
});

app.post("/api/moderation/:id/approve", requireDb, requireAuth, requireModerator, async (req, res, next) => {
  try {
    if (!channelId || !reviewChannelId) return res.status(503).json({ error: "Не настроены каналы публикации и модерации" });
    const submissions = db.collection("submissions");
    const submission = await submissions.findOne({ submission_id: req.params.id, status: "pending" });
    if (!submission) return res.status(404).json({ error: "Заявка не найдена" });
    const copied = await telegramRequest("copyMessage", {
      chat_id: channelId,
      from_chat_id: reviewChannelId,
      message_id: submission.review_message_id,
      caption: submission.caption,
    });
    const postUrl = channelUsername ? `https://t.me/${channelUsername}/${copied.message_id}` : null;
    const publishedAt = new Date();
    const mod = {
      mod_id: `tg-${channelId}-${copied.message_id}`,
      title: submission.title,
      description: submission.description,
      game_version: submission.game_version,
      tags: submission.tags,
      file_id: submission.file_id,
      file_name: submission.file_name,
      file_size: submission.file_size,
      telegram_post_url: postUrl,
      author: submission.author,
      status: "published",
      published_at: publishedAt,
    };
    await db.collection("mods").updateOne({ mod_id: mod.mod_id }, { $set: mod }, { upsert: true });
    await submissions.updateOne({ submission_id: submission.submission_id }, { $set: { status: "approved", reviewed_at: publishedAt, reviewed_by: req.user.telegram_id, telegram_post_url: postUrl } });
    res.json({ ok: true, telegram_post_url: postUrl });
  } catch (error) { next(error); }
});

app.post("/api/moderation/:id/reject", requireDb, requireAuth, requireModerator, async (req, res, next) => {
  try {
    const result = await db.collection("submissions").updateOne(
      { submission_id: req.params.id, status: "pending" },
      { $set: { status: "rejected", rejection_reason: String(req.body.reason || "").trim().slice(0, 300), reviewed_at: new Date(), reviewed_by: req.user.telegram_id } },
    );
    if (!result.modifiedCount) return res.status(404).json({ error: "Заявка не найдена" });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

async function sendBotMessage(chatId, text) {
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram sendMessage failed (${result.error_code || response.status})`);
}

async function handleUpdate(update) {
  const message = update.message;
  if (message) {
    const startCommand = message.text?.match(/^\/start(?:@\w+)?(?:\s+([\w-]+))?/);
    if (startCommand) {
      const match = startCommand[1];
      if (!match) {
        await sendBotMessage(message.chat.id, "Привет! Чтобы создать аккаунт NoomiHub, открой сайт и нажми «Войти через Telegram». Вернись сюда по ссылке с сайта и нажми Start.");
        return;
      }
      if (!db) {
        await sendBotMessage(message.chat.id, "Сайт пока не подключён к базе данных. Попробуй войти позже.");
        return;
      }
      const telegramUser = message.from;
      const ticket = await db.collection("auth_tickets").updateOne(
        { ticket: match, expires_at: { $gt: new Date() } }, { $set: { telegram_id: telegramUser.id } },
      );
      if (ticket.matchedCount) {
        const displayName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(" ") || telegramUser.username || "Игрок";
        await db.collection("users").updateOne({ telegram_id: telegramUser.id }, {
          $set: { display_name: displayName, username: telegramUser.username || null, updated_at: new Date() },
          $setOnInsert: { created_at: new Date() },
        }, { upsert: true });
        await sendBotMessage(telegramUser.id, "Готово! Вернись на сайт — аккаунт NoomiHub подключён.");
      } else await sendBotMessage(telegramUser.id, "Ссылка истекла или уже использована. Создай новую на сайте.");
    }
  }

}

async function telegramRequest(method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${method} failed (${result.error_code}): ${result.description || "unknown error"}`);
  return result.result;
}

async function configureTelegramWebhook() {
  if (!botToken || !webhookSecret) {
    console.error("Telegram webhook not configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET in Render Environment");
    return;
  }
  const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.SITE_URL;
  if (!baseUrl) {
    console.error("Telegram webhook not configured: Render did not provide RENDER_EXTERNAL_URL and SITE_URL is empty");
    return;
  }
  const webhookUrl = `${baseUrl.replace(/\/$/, "")}/telegram/webhook`;
  try {
    await telegramRequest("setWebhook", {
      url: webhookUrl,
      secret_token: webhookSecret,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    });
    telegramWebhookReady = true;
    console.log(`Telegram webhook configured: ${webhookUrl}`);
  } catch (error) {
    telegramWebhookReady = false;
    console.error(`Telegram webhook setup failed: ${error.message}`);
  }
}

app.post("/telegram/webhook", async (req, res, next) => {
  const expected = Buffer.from(webhookSecret);
  const actual = Buffer.from(req.get("x-telegram-bot-api-secret-token") || "");
  if (!webhookSecret || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return res.status(403).json({ error: "Invalid Telegram webhook secret" });
  }
  try {
    await handleUpdate(req.body);
    console.log(`Telegram update handled: ${req.body.update_id ?? "unknown"}`);
    res.json({ ok: true });
  }
  catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(`Request failed: ${error.message}`);
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Размер файла превышает лимит 50 МБ" });
  }
  res.status(500).json({ error: "Internal server error" });
});

async function start() {
  if (process.env.MONGODB_URI) {
    const mongo = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await mongo.connect();
    db = mongo.db(process.env.MONGODB_DB || "noomihub");
    await Promise.all([
      db.collection("users").createIndex({ telegram_id: 1 }, { unique: true }),
      db.collection("auth_tickets").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
      db.collection("mods").createIndex({ published_at: -1 }),
      db.collection("mods").createIndex({ title: "text", description: "text", tags: "text" }),
    ]);
    console.log("MongoDB connected");
  } else console.warn("MONGODB_URI missing; database routes return 503");
  app.listen(port, "0.0.0.0", async () => {
    console.log(`NoomiHub listening on ${port}`);
    await configureTelegramWebhook();
  });
}

start().catch((error) => { console.error(`Startup failed: ${error.name}`); process.exit(1); });
