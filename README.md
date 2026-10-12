# NoomiHub

Фанатский каталог модов NoomiClone. Backend — **Node.js + Express**; интерфейс адаптивный, в духе Material You. MongoDB хранит аккаунты, заявки и индекс модов; Telegram хранит файлы.

## Локальный запуск

Нужен Node.js 20+ и доступная MongoDB (можно MongoDB Atlas).

```bash
cd Projects/NoomiHub
npm install
cp .env.example .env
```

Заполни `.env`, включая публичный HTTPS `SITE_URL`, затем запусти `npm run dev`. Telegram не может отправлять webhook на `localhost`; для локальной проверки нужен публичный HTTPS-адрес. На Render приложение использует публичный адрес сервиса автоматически.

## Подача модов и модерация

Пользователь входит через Telegram, заполняет форму на сайте и прикрепляет файл. Бот отправляет файл в **приватный канал проверки**. Модератор одобряет заявку — бот копирует пост в публичный канал, а сайт показывает мод в каталоге. Отклонённые и ожидающие заявки видны в профиле.

Создай бота через @BotFather. Создай публичный канал модов и отдельный приватный канал проверки; добавь бота администратором в оба. Заполни `TELEGRAM_CHANNEL_ID` и `TELEGRAM_REVIEW_CHANNEL_ID` числовыми ID вида `-100...`, а также `TELEGRAM_CHANNEL_USERNAME` без `@`.

Форма принимает файлы до **50 МБ** — это лимит загрузки обычного Telegram Bot API. Для файлов больше 50 МБ потребуется отдельный локальный Bot API Server.

Чтобы назначить модератора, войди на сайт, скопируй свой Telegram ID из профиля и добавь его в Render в `MODERATOR_TELEGRAM_IDS`. Несколько ID разделяй запятыми.

## Render

1. Создай GitHub-репозиторий из этой папки, подключи его к Render как Web Service. `render.yaml` задаёт Node runtime, запуск и health check.
2. Создай MongoDB Atlas cluster и скопируй connection string.
3. В Render → Environment добавь `MONGODB_URI`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_CHANNEL_ID`, `TELEGRAM_CHANNEL_USERNAME`, `TELEGRAM_REVIEW_CHANNEL_ID`, `TELEGRAM_WEBHOOK_SECRET` и `JWT_SECRET`. Для `TELEGRAM_WEBHOOK_SECRET` сгенерируй hex-строку командой `openssl rand -hex 32`; Telegram принимает в ней только буквы, цифры, `_` и `-`. Для `JWT_SECRET` используй отдельную случайную строку. `MODERATOR_TELEGRAM_IDS` задай после входа в профиль.
4. Сохрани переменные и дождись нового деплоя. При старте приложение само зарегистрирует webhook на URL Render. Не запускай отдельно `setWebhook` и не настраивай long polling: используется только webhook.
5. Открой `/api/health`. Должно быть `{"ok":true,"database":true,"telegram_configured":true,"telegram_webhook":true}`. Затем войди через сайт, назначь Telegram ID модератором и подай тестовый мод через форму.

Не публикуй токен бота или URI MongoDB в репозитории.
