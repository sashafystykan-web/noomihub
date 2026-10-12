import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { MongoClient } from "mongodb";
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = path.resolve(process.env.MEDIA_DIR || path.join(root, "data"));
const avatarDir = path.join(mediaDir, "avatars");
const screenshotDir = path.join(mediaDir, "screenshots");
const app = express();
const port = Number(process.env.PORT || 8000);
const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
const botUsername = process.env.TELEGRAM_BOT_USERNAME || "";
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const jwtSecret = process.env.JWT_SECRET || "local-development-secret-change-me";
const moderatorIds = new Set((process.env.MODERATOR_TELEGRAM_IDS || "").split(",").map((id) => id.trim()).filter(Boolean));
let db;
let telegramWebhookReady = false;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 5 } });

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
function mediaUrl(name) { return name ? `/media/${encodeURIComponent(name)}` : null; }
async function writeCompressedImage(buffer, directory, targetBytes, maxWidth) {
  let width = maxWidth;
  let quality = 76;
  let output;
  for (let attempt = 0; attempt < 9; attempt += 1) {
    output = await sharp(buffer, { failOn: "error" }).rotate().resize({ width, height: width, fit: "inside", withoutEnlargement: true }).jpeg({ quality, progressive: true, mozjpeg: true }).toBuffer();
    if (output.length <= targetBytes) break;
    width = Math.max(240, Math.round(width * 0.82));
    quality = Math.max(30, quality - 6);
  }
  const name = `${directory === avatarDir ? "avatar" : "shot"}-${crypto.randomUUID()}.jpg`;
  await fs.writeFile(path.join(directory, name), output, { flag: "wx" });
  return name;
}
async function deleteMedia(names, directory) { await Promise.all((names || []).map((name) => fs.rm(path.join(directory, name), { force: true }).catch(() => {}))); }
function normalizeSource(raw) {
  let url;
  try { url = new URL(String(raw || "").trim()); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}
function publicMod(mod) {
  const shots = mod.screenshot_files || [];
  return { ...mod, cover_url: mediaUrl(shots[0]), screenshot_urls: shots.map(mediaUrl), author_avatar_url: mediaUrl(mod.author_avatar) };
}
function submissionCooldownMs(latest) {
  return latest ? Math.max(0, 24 * 60 * 60 * 1000 - (Date.now() - new Date(latest.created_at).getTime())) : 0;
}

app.get("/", (_req, res) => res.sendFile(path.join(root, "static", "index.html")));
app.get("/api/health", (_req, res) => res.json({ ok: true, database: Boolean(db), telegram_configured: Boolean(botToken && botUsername), telegram_webhook: telegramWebhookReady }));
app.get("/api/config", (_req, res) => res.json({ bot_ready: Boolean(botUsername && telegramWebhookReady) }));

app.get("/api/mods", requireDb, async (req, res, next) => {
  try {
    const filter = { status: "published" };
    if (req.query.q?.trim()) filter.$text = { $search: req.query.q.trim() };
    if (req.query.tag?.trim()) filter.tags = req.query.tag.trim();
    const mods = await db.collection("mods").find(filter).sort({ published_at: -1 }).limit(100).toArray();
    res.json({ mods: mods.map(({ _id, ...mod }) => publicMod(mod)) });
  } catch (error) { next(error); }
});
app.get("/api/mods/:id", requireDb, async (req, res, next) => {
  try {
    const mod = await db.collection("mods").findOne({ mod_id: req.params.id, status: "published" }, { projection: { _id: 0 } });
    if (!mod) return res.status(404).json({ error: "Мод не найден" });
    res.json({ mod: publicMod(mod) });
  } catch (error) { next(error); }
});
app.get("/media/:name", async (req, res, next) => {
  try {
    const name = path.basename(req.params.name);
    if (!/^[\w-]+\.jpg$/.test(name)) return res.sendStatus(404);
    const directory = name.startsWith("avatar-") ? avatarDir : name.startsWith("shot-") ? screenshotDir : null;
    if (!directory) return res.sendStatus(404);
    const file = await fs.readFile(path.join(directory, name));
    res.set({ "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=2592000, immutable", "X-Content-Type-Options": "nosniff" }).send(file);
  } catch (error) { if (error.code === "ENOENT") res.sendStatus(404); else next(error); }
});

app.post("/api/auth/start", requireDb, async (_req, res, next) => {
  try {
    if (!botUsername || !telegramWebhookReady) return res.status(503).json({ error: "Telegram-вход пока не подключён." });
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
app.get("/api/me", requireDb, requireAuth, (req, res) => res.json({ user: {
  telegram_id: req.user.telegram_id, username: req.user.username, display_name: req.user.display_name,
  avatar_url: mediaUrl(req.user.avatar_file), created_at: req.user.created_at, is_moderator: req.user.is_moderator,
} }));

app.post("/api/submissions", requireDb, requireAuth, upload.array("screenshots", 5), async (req, res, next) => {
  const saved = [];
  try {
    const title = String(req.body.title || "").trim();
    const description = String(req.body.description || "").trim();
    const gameVersion = String(req.body.game_version || "").trim().slice(0, 40);
    const downloadUrl = normalizeSource(req.body.download_url);
    const tags = String(req.body.tags || "").split(/[,;]/).map((tag) => tag.trim().slice(0, 32)).filter(Boolean).slice(0, 10);
    if (title.length < 2 || title.length > 120) return res.status(400).json({ error: "Название должно содержать от 2 до 120 символов." });
    if (!description || description.length > 2000) return res.status(400).json({ error: "Описание должно содержать от 1 до 2000 символов." });
    if (!downloadUrl) return res.status(400).json({ error: "Укажи корректную ссылку http или https." });
    if ((req.files || []).some((file) => !file.mimetype.startsWith("image/"))) return res.status(400).json({ error: "Можно загрузить только изображения." });
    const latest = await db.collection("submissions").findOne({ telegram_id: req.user.telegram_id }, { sort: { created_at: -1 }, projection: { created_at: 1 } });
    const waitMs = submissionCooldownMs(latest);
    if (waitMs) return res.status(429).json({ error: `Повторная подача будет доступна через ${Math.ceil(waitMs / 3600000)} ч.` });
    const duplicate = await Promise.all([
      db.collection("submissions").findOne({ normalized_url: downloadUrl }, { projection: { status: 1 } }),
      db.collection("mods").findOne({ normalized_url: downloadUrl }, { projection: { mod_id: 1 } }),
    ]);
    if (duplicate.some(Boolean)) return res.status(409).json({ error: "Эта ссылка уже есть в каталоге или очереди модерации." });
    for (const file of req.files || []) saved.push(await writeCompressedImage(file.buffer, screenshotDir, 250 * 1024, 1440));
    const submission = {
      submission_id: crypto.randomUUID(), telegram_id: req.user.telegram_id,
      author: req.user.username ? `@${req.user.username}` : req.user.display_name,
      author_avatar: req.user.avatar_file || null, title, description, game_version: gameVersion,
      tags, download_url: downloadUrl, normalized_url: downloadUrl, screenshot_files: saved,
      status: "pending", safety_status: "pending", created_at: new Date(),
    };
    await db.collection("submissions").insertOne(submission);
    res.status(201).json({ ok: true, submission: { submission_id: submission.submission_id, title, status: "pending" } });
  } catch (error) { await deleteMedia(saved, screenshotDir); next(error); }
});
app.get("/api/submissions/mine", requireDb, requireAuth, async (req, res, next) => {
  try {
    const submissions = await db.collection("submissions").find({ telegram_id: req.user.telegram_id }, { projection: { _id: 0, submission_id: 1, title: 1, status: 1, safety_status: 1, created_at: 1, rejection_reason: 1 } }).sort({ created_at: -1 }).limit(50).toArray();
    res.json({ submissions });
  } catch (error) { next(error); }
});
app.get("/api/moderation/pending", requireDb, requireAuth, requireModerator, async (_req, res, next) => {
  try {
    const submissions = await db.collection("submissions").find({ status: "pending" }, { projection: { _id: 0, submission_id: 1, title: 1, description: 1, game_version: 1, tags: 1, author: 1, download_url: 1, screenshot_files: 1, created_at: 1 } }).sort({ created_at: 1 }).limit(100).toArray();
    res.json({ submissions: submissions.map((s) => ({ ...s, screenshot_urls: (s.screenshot_files || []).map(mediaUrl) })) });
  } catch (error) { next(error); }
});
app.post("/api/moderation/:id/review", requireDb, requireAuth, requireModerator, async (req, res, next) => {
  try {
    const decision = String(req.body.decision || "");
    const submissions = db.collection("submissions");
    const submission = await submissions.findOne({ submission_id: req.params.id, status: "pending" });
    if (!submission) return res.status(404).json({ error: "Заявка не найдена" });
    const reviewedAt = new Date();
    if (decision === "reject") {
      await submissions.updateOne({ submission_id: submission.submission_id, status: "pending" }, { $set: { status: "rejected", reviewed_at: reviewedAt, reviewed_by: req.user.telegram_id, rejection_reason: String(req.body.reason || "").trim().slice(0, 300) } });
      return res.json({ ok: true });
    }
    if (!["verified", "unsafe"].includes(decision)) return res.status(400).json({ error: "Неизвестное решение модерации." });
    const safetyStatus = decision;
    const mod = {
      mod_id: submission.submission_id, title: submission.title, description: submission.description,
      game_version: submission.game_version, tags: submission.tags, screenshot_files: submission.screenshot_files,
      download_url: submission.download_url, normalized_url: submission.normalized_url,
      author: submission.author, author_telegram_id: submission.telegram_id, author_avatar: submission.author_avatar,
      status: "published", safety_status: safetyStatus, published_at: reviewedAt,
    };
    await db.collection("mods").insertOne(mod);
    await submissions.updateOne({ submission_id: submission.submission_id, status: "pending" }, { $set: { status: "approved", safety_status: safetyStatus, reviewed_at: reviewedAt, reviewed_by: req.user.telegram_id } });
    res.json({ ok: true });
  } catch (error) { if (error.code === 11000) return res.status(409).json({ error: "Эта ссылка уже опубликована." }); next(error); }
});

async function telegramRequest(method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!result.ok) throw new Error(`Telegram ${method} failed (${result.error_code}): ${result.description || "unknown error"}`);
  return result.result;
}
async function refreshTelegramAvatar(telegramId) {
  try {
    const result = await telegramRequest("getUserProfilePhotos", { user_id: telegramId, limit: 1 });
    const photo = result.photos?.[0]?.at(-1);
    if (!photo) return;
    const file = await telegramRequest("getFile", { file_id: photo.file_id });
    const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram avatar fetch failed (${response.status})`);
    const avatarFile = await writeCompressedImage(Buffer.from(await response.arrayBuffer()), avatarDir, 40 * 1024, 256);
    const previous = await db.collection("users").findOneAndUpdate({ telegram_id: telegramId }, { $set: { avatar_file: avatarFile } }, { returnDocument: "before" });
    if (previous?.avatar_file) {
      await Promise.all([
        db.collection("mods").updateMany({ author_telegram_id: telegramId }, { $set: { author_avatar: avatarFile } }),
        db.collection("submissions").updateMany({ telegram_id: telegramId }, { $set: { author_avatar: avatarFile } }),
      ]);
      await fs.rm(path.join(avatarDir, previous.avatar_file), { force: true }).catch(() => {});
    }
  } catch (error) { console.warn(`Telegram avatar lookup failed for ${telegramId}: ${error.message}`); }
}
async function sendBotMessage(chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }) });
  if (!response.ok) throw new Error(`Telegram sendMessage failed (${response.status})`);
}
async function handleUpdate(update) {
  const message = update.message;
  if (!message || message.chat.type !== "private" || !message.from) return;
  const user = message.from;
  const chatId = message.chat.id;
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "Игрок";
  await db.collection("users").updateOne({ telegram_id: user.id }, { $set: { display_name: displayName, username: user.username || null, updated_at: new Date() }, $setOnInsert: { created_at: new Date() } }, { upsert: true });
  const start = message.text?.match(/^\/start(?:@\w+)?(?:\s+([\w-]+))?/);
  if (!start) return;
  const ticketId = start[1];
  if (ticketId) {
    const ticket = await db.collection("auth_tickets").updateOne({ ticket: ticketId, expires_at: { $gt: new Date() } }, { $set: { telegram_id: user.id } });
    if (!ticket.matchedCount) return sendBotMessage(chatId, "Ссылка входа истекла. Создай новую на сайте.");
    await refreshTelegramAvatar(user.id);
    return sendBotMessage(chatId, "Готово! Вернись на сайт — вход выполнен.");
  }
  await refreshTelegramAvatar(user.id);
  return sendBotMessage(chatId, "Привет! Бот NoomiHub используется для входа на сайт. Подача и модерация модов проходят на сайте.");
}
async function configureTelegramWebhook() {
  if (!botToken || !webhookSecret) { console.error("Telegram webhook not configured: set bot token and webhook secret"); return; }
  const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.SITE_URL;
  if (!baseUrl) { console.error("Telegram webhook not configured: no public site URL"); return; }
  const webhookUrl = `${baseUrl.replace(/\/$/, "")}/telegram/webhook`;
  try {
    await telegramRequest("setWebhook", { url: webhookUrl, secret_token: webhookSecret, allowed_updates: ["message"], drop_pending_updates: false });
    telegramWebhookReady = true;
    console.log(`Telegram webhook configured: ${webhookUrl}`);
  } catch (error) { console.error(`Telegram webhook setup failed: ${error.message}`); }
}
app.post("/telegram/webhook", async (req, res, next) => {
  const expected = Buffer.from(webhookSecret);
  const actual = Buffer.from(req.get("x-telegram-bot-api-secret-token") || "");
  if (!webhookSecret || expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return res.status(403).json({ error: "Invalid Telegram webhook secret" });
  try { if (db) await handleUpdate(req.body); res.json({ ok: true }); } catch (error) { next(error); }
});
app.use((error, _req, res, _next) => {
  console.error(`Request failed: ${error.message}`);
  if (error.code === 11000) return res.status(409).json({ error: "Эта ссылка уже есть в каталоге или очереди модерации." });
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Изображение больше 8 МБ." : "Не удалось принять изображения." });
  if (/unsupported image|input buffer|corrupt header|premature end/i.test(error.message)) return res.status(400).json({ error: "Один из файлов не является корректным изображением." });
  res.status(500).json({ error: "Внутренняя ошибка сервера." });
});

async function start() {
  await fs.mkdir(avatarDir, { recursive: true });
  await fs.mkdir(screenshotDir, { recursive: true });
  if (process.env.MONGODB_URI) {
    const mongo = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await mongo.connect();
    db = mongo.db(process.env.MONGODB_DB || "noomihub");
    await Promise.all([
      db.collection("users").createIndex({ telegram_id: 1 }, { unique: true }),
      db.collection("auth_tickets").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
      db.collection("submissions").createIndex({ telegram_id: 1, created_at: -1 }),
      db.collection("submissions").createIndex({ normalized_url: 1 }, { unique: true, sparse: true }),
      db.collection("mods").createIndex({ published_at: -1 }),
      db.collection("mods").createIndex({ normalized_url: 1 }, { unique: true, sparse: true }),
      db.collection("mods").createIndex({ title: "text", description: "text", tags: "text" }),
    ]);
    console.log("MongoDB connected");
  } else console.warn("MONGODB_URI missing; database routes return 503");
  app.listen(port, "0.0.0.0", async () => { console.log(`NoomiHub listening on ${port}`); await configureTelegramWebhook(); });
}
start().catch((error) => { console.error(`Startup failed: ${error.name}`); process.exit(1); });
