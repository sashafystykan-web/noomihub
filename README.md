# NoomiHub

Стартовый фанатский каталог модов NoomiClone. Backend — **Node.js + Express**; интерфейс адаптивный, в духе Material You. MongoDB хранит аккаунты и индекс модов, Telegram — исходные файлы.

## Локальный запуск

Нужен Node.js 20+ и доступная MongoDB (можно MongoDB Atlas).

```bash
cd Projects/NoomiHub
npm install
cp .env.example .env
```

Заполни `.env`, включая публичный HTTPS `SITE_URL`, затем запусти `npm run dev`. Telegram не может отправлять webhook на `localhost`; для локальной проверки нужен публичный HTTPS-адрес. На Render приложение использует публичный адрес сервиса автоматически.

## Telegram

1. Создай бота у @BotFather и публичный канал; добавь бота администратором канала.
2. Заполни токен, username бота, числовой ID канала вида `-100...` и username канала без `@`.
3. Публикуй моды в канале с документом и подписью:

```text
Название: Neon Gym
Версия: 2.2.0
Тип: Скин
Теги: скин, визуал
Описание: Неоновый набор оформления для персонажа.
```

Допустимы английские ключи `Title`, `Version`, `Type`, `Tags`, `Description`. Webhook сохраняет метаданные, Telegram `file_id`, имя и размер в MongoDB. Изменение подписи к посту обновит карточку.

Кнопка скачивания открывает пост публичного канала. Файл по 60 МБ бот не проксирует на сайт: Bot API ограничивает скачивание обычным ботом, поэтому посетитель скачивает файл из Telegram.

## Render

1. Создай GitHub-репозиторий из этой папки, подключи его к Render как Web Service. `render.yaml` задаёт Node runtime, запуск и health check.
2. Создай MongoDB Atlas cluster и скопируй connection string.
3. В Render → Environment добавь `MONGODB_URI`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_CHANNEL_ID`, `TELEGRAM_CHANNEL_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` и `JWT_SECRET`. Для `TELEGRAM_WEBHOOK_SECRET` сгенерируй hex-строку командой `openssl rand -hex 32`; Telegram принимает в ней только буквы, цифры, `_` и `-`. Для `JWT_SECRET` используй отдельную случайную строку.
4. Сохрани переменные и дождись нового деплоя. При старте приложение само зарегистрирует webhook на URL Render. Не запускай отдельно `setWebhook` и не настраивай long polling: используется только webhook.
5. Открой `/api/health`. Должно быть `{"ok":true,"database":true,"telegram_configured":true,"telegram_webhook":true}`. Затем нажми вход на сайте, открой бота по ссылке и нажми Start. Опубликуй тестовый архив в канале.

Не публикуй токен бота или URI MongoDB в репозитории.
