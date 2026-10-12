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
const channelUsername = process.env.TELEGRAM_CHANNEL_USERNAME || "";
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const jwtSecret = process.env.JWT_SECRET || "local-development-secret-change-me";
let db;

app.use(express.json({ limit: "2mb" }));
app.use("/static", express.static(path.join(root, "static")));
const requireDb = (_req, res, next) => db ? next() : res.status(503).json({ error: "MongoDB is not configured" });
app.get("/", (_req, res) => res.sendFile(path.join(root, "static", "index.html")));
app.get("/api/health", (_req, res) => res.json({ ok: true, database: Boolean(db) }));
app.get("/api/config", (_req, res) => res.json({ channel_username: channelUsername, bot_ready: Boolean(botUsername) }));

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
    if (!botUsername) return res.status(503).json({ error: "Telegram bot is not configured" });
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

function parseCaption(caption = "") {
  const fields = {};
  for (const line of caption.split(/\r?\n/)) {
    const match = line.match(/^\s*(название|title|версия|version|тип|type|теги|tags|описание|description)\s*:\s*(.*)/i);
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }
  const tags = fields["теги"] || fields.tags || fields["тип"] || fields.type || "Другое";
  return {
    title: (fields["название"] || fields.title || "Новый мод").slice(0, 120),
    description: (fields["описание"] || fields.description || caption).slice(0, 2000),
    game_version: (fields["версия"] || fields.version || "Не указана").slice(0, 40),
    tags: tags.split(/[,;]/).map((tag) => tag.trim()).filter(Boolean).slice(0, 10),
  };
}

function getTelegramFile(message) {
  for (const kind of ["document", "video", "animation", "audio"]) {
    if (message[kind]) {
      const file = message[kind];
      return { file_id: file.file_id, file_name: file.file_name || message.caption || "mod.zip", file_size: file.file_size || 0 };
    }
  }
  return null;
}

async function sendBotMessage(chatId, text) {
  if (!botToken) return;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function handleUpdate(update) {
  const message = update.message;
  if (message) {
    const match = message.text?.match(/^\/start(?:@\w+)?\s+([\w-]+)/);
    if (match) {
      const telegramUser = message.from;
      const ticket = await db.collection("auth_tickets").updateOne(
        { ticket: match[1], expires_at: { $gt: new Date() } }, { $set: { telegram_id: telegramUser.id } },
      );
      if (ticket.modifiedCount) {
        const displayName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(" ") || telegramUser.username || "Игрок";
        await db.collection("users").updateOne({ telegram_id: telegramUser.id }, {
          $set: { display_name: displayName, username: telegramUser.username || null, updated_at: new Date() },
          $setOnInsert: { created_at: new Date() },
        }, { upsert: true });
        await sendBotMessage(telegramUser.id, "Готово! Вернись на сайт — аккаунт NoomiHub подключён.");
      } else await sendBotMessage(telegramUser.id, "Ссылка истекла или уже использована. Создай новую на сайте.");
    }
  }

  const post = update.channel_post || update.edited_channel_post;
  if (post && channelId && String(post.chat.id) === String(channelId)) {
    const file = getTelegramFile(post);
    if (!file) return;
    const username = post.chat.username || channelUsername;
    const mod = {
      mod_id: `tg-${post.chat.id}-${post.message_id}`,
      ...parseCaption(post.caption || ""), ...file,
      telegram_post_url: username ? `https://t.me/${username}/${post.message_id}` : null,
      author: post.author_signature || "Сообщество", status: "published", published_at: new Date(),
    };
    await db.collection("mods").updateOne({ mod_id: mod.mod_id }, { $set: mod }, { upsert: true });
  }
}

app.post("/telegram/webhook", requireDb, async (req, res, next) => {
  const expected = Buffer.from(webhookSecret);
  const actual = Buffer.from(req.get("x-telegram-bot-api-secret-token") || "");
  if (!webhookSecret || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return res.status(403).json({ error: "Invalid Telegram webhook secret" });
  }
  try { await handleUpdate(req.body); res.json({ ok: true }); }
  catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(`Request failed: ${error.name}`);
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
  app.listen(port, "0.0.0.0", () => console.log(`NoomiHub listening on ${port}`));
}

start().catch((error) => { console.error(`Startup failed: ${error.name}`); process.exit(1); });
