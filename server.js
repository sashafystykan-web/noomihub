import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import jwt from "jsonwebtoken";
import { MongoClient } from "mongodb";
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
app.get("/api/config", (_req, res) => res.json({ channel_username: channelUsername, bot_ready: Boolean(botUsername && telegramWebhookReady), submission_bot_url: botUsername ? `https://t.me/${botUsername}?start=submit` : null }));

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

async function sendBotMessage(chatId, text, extra = {}) {
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram sendMessage failed (${result.error_code || response.status})`);
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message || message.chat.type !== "private" || !message.from) return;
  const telegramUser = message.from;
  const chatId = message.chat.id;
  if (!db) return sendBotMessage(chatId, "База данных сайта пока недоступна. Попробуй позже.");
  const displayName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(" ") || telegramUser.username || "Игрок";
  await db.collection("users").updateOne({ telegram_id: telegramUser.id }, {
    $set: { display_name: displayName, username: telegramUser.username || null, updated_at: new Date() },
    $setOnInsert: { created_at: new Date() },
  }, { upsert: true });

  const startCommand = message.text?.match(/^\/start(?:@\w+)?(?:\s+([\w-]+))?/);
  const submitCommand = message.text?.match(/^\/(?:submit|new)(?:@\w+)?(?:\s|$)/);
  if (startCommand || submitCommand) {
    const argument = startCommand?.[1];
    if (argument === "submit" || submitCommand) {
      if (!botToken || !reviewChannelId) return sendBotMessage(chatId, "Подача модов пока не настроена. Сообщи администратору сайта.");
      await db.collection("submission_drafts").updateOne({ telegram_id: telegramUser.id }, {
        $set: { telegram_id: telegramUser.id, stage: "title", updated_at: new Date() },
        $unset: { title: "", description: "", game_version: "", tags: "" },
      }, { upsert: true });
      return sendBotMessage(chatId, "Подача мода · шаг 1 из 5\nНапиши название. Для отмены отправь /cancel.");
    }
    if (argument) {
      const ticket = await db.collection("auth_tickets").updateOne(
        { ticket: argument, expires_at: { $gt: new Date() } }, { $set: { telegram_id: telegramUser.id } },
      );
      if (ticket.matchedCount) return sendBotMessage(chatId, "Готово! Вернись на сайт — аккаунт NoomiHub подключён.");
      return sendBotMessage(chatId, "Ссылка входа истекла или уже использована. Создай новую на сайте.");
    }
    return sendBotMessage(chatId, "Привет! Чтобы подать мод, отправь /submit. Для входа на сайт нажми «Войти через Telegram» и вернись сюда по ссылке.");
  }

  if (message.text?.match(/^\/cancel(?:@\w+)?(?:\s|$)/)) {
    await db.collection("submission_drafts").deleteOne({ telegram_id: telegramUser.id });
    return sendBotMessage(chatId, "Подачу отменил.");
  }

  const draft = await db.collection("submission_drafts").findOne({ telegram_id: telegramUser.id });
  if (!draft) return;
  if (draft.stage === "file") {
    const document = message.document;
    if (!document) return sendBotMessage(chatId, "Пришли файл мода как документ (скрепка → Файл). Для отмены /cancel.");
    if (!reviewChannelId) return sendBotMessage(chatId, "Канал проверки не настроен. Сообщи администратору сайта.");
    const author = telegramUser.username ? `@${telegramUser.username}` : displayName;
    const submissionId = crypto.randomUUID();
    const submission = {
      submission_id: submissionId,
      telegram_id: telegramUser.id,
      author,
      title: draft.title,
      description: draft.description,
      game_version: draft.game_version || "Не указана",
      tags: draft.tags.length ? draft.tags : ["Другое"],
      file_id: document.file_id,
      file_name: document.file_name || "mod",
      file_size: document.file_size || 0,
      caption: submissionCaption({ title: draft.title, author, description: draft.description, game_version: draft.game_version, tags: draft.tags }),
      status: "pending",
      created_at: new Date(),
    };
    try {
      const copied = await telegramRequest("copyMessage", {
        chat_id: reviewChannelId,
        from_chat_id: chatId,
        message_id: message.message_id,
        caption: submission.caption,
      });
      submission.review_message_id = copied.message_id;
      await db.collection("submissions").insertOne(submission);
      await db.collection("submission_drafts").deleteOne({ telegram_id: telegramUser.id });
      return sendBotMessage(chatId, "Заявка отправлена на модерацию. Статус появится в профиле на сайте.");
    } catch (error) {
      console.error(`Submission copy failed: ${error.message}`);
      return sendBotMessage(chatId, "Не получилось передать файл на проверку. Попробуй отправить его ещё раз чуть позже.");
    }
  }

  if (!message.text) return sendBotMessage(chatId, "Ответь текстом на вопрос бота. Для отмены /cancel.");
  const value = message.text.trim();
  if (draft.stage === "title") {
    if (!value || value.length > 120) return sendBotMessage(chatId, "Название должно быть от 1 до 120 символов. Попробуй ещё раз.");
    await db.collection("submission_drafts").updateOne({ telegram_id: telegramUser.id }, { $set: { title: value, stage: "description", updated_at: new Date() } });
    return sendBotMessage(chatId, "Шаг 2 из 5\nКоротко опиши мод (до 2000 символов).");
  }
  if (draft.stage === "description") {
    if (!value || value.length > 2000) return sendBotMessage(chatId, "Описание должно быть от 1 до 2000 символов. Попробуй ещё раз.");
    await db.collection("submission_drafts").updateOne({ telegram_id: telegramUser.id }, { $set: { description: value, stage: "game_version", updated_at: new Date() } });
    return sendBotMessage(chatId, "Шаг 3 из 5\nУкажи версию игры, например 2.2.0. Если не знаешь — отправь «-».");
  }
  if (draft.stage === "game_version") {
    await db.collection("submission_drafts").updateOne({ telegram_id: telegramUser.id }, { $set: { game_version: value === "-" ? "" : value.slice(0, 40), stage: "tags", updated_at: new Date() } });
    return sendBotMessage(chatId, "Шаг 4 из 5\nУкажи теги через запятую (например: скин, карта). Если тегов нет — отправь «-».");
  }
  if (draft.stage === "tags") {
    const tags = value === "-" ? [] : value.split(/[,;]/).map((tag) => tag.trim().slice(0, 32)).filter(Boolean).slice(0, 10);
    await db.collection("submission_drafts").updateOne({ telegram_id: telegramUser.id }, { $set: { tags, stage: "file", updated_at: new Date() } });
    return sendBotMessage(chatId, "Шаг 5 из 5\nПришли файл мода как документ (скрепка → Файл). Файл уйдёт в канал проверки, не на сервер сайта.");
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
      db.collection("submission_drafts").createIndex({ updated_at: 1 }, { expireAfterSeconds: 86400 }),
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
