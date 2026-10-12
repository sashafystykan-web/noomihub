# NoomiHub

Стартовый фанатский каталог модов NoomiClone. Backend — **Node.js + Express**; интерфейс адаптивный, в духе Material You. MongoDB хранит аккаунты и индекс модов, Telegram — исходные файлы.

## Запуск локально

Нужен Node.js 20+ и доступная MongoDB (можно MongoDB Atlas).

```bash
cd Projects/NoomiHub
npm install
cp .env.example .env
```

Заполни `.env`, затем запусти `npm run dev` и открой http://localhost:8000. Без `MONGODB_URI` сервер стартует, но API каталога и регистрации ответит ошибкой конфигурации.

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

Допустимы английские ключи `Title`, `Version`, `Type`, `Tags`, `Description`. Webhook сам сохранит метаданные, Telegram `file_id`, имя и размер в MongoDB. Изменение подписи к посту обновит карточку.

Кнопка скачивания открывает пост публичного канала. Файл по 60 МБ бот не проксирует на сайт: в обычном Telegram Bot API скачивание ограничено 20 МБ. Через пост канала посетитель скачивает его из Telegram.

## Render

1. Создай GitHub-репозиторий из этой папки, подключи его к Render как Web Service. `render.yaml` задаёт Node runtime, запуск и health check.
2. Создай MongoDB Atlas cluster. Добавь доступ для подключения Render и скопируй connection string.
3. В Render → Environment добавь `MONGODB_URI`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_CHANNEL_ID`, `TELEGRAM_CHANNEL_USERNAME`. Сгенерируй длинный `JWT_SECRET` и `TELEGRAM_WEBHOOK_SECRET` (только буквы, цифры, `_` и `-`).
4. После первого деплоя установи webhook:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<render-service>.onrender.com/telegram/webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message","channel_post","edited_channel_post"]'
```

5. Открой `/api/health` — должно быть `{"ok":true,"database":true}`. Нажми вход на сайте, затем Start у бота. Опубликуй тестовый архив в канале.

Не публикуй токен бота или URI MongoDB в репозитории. На момент первой настройки ID канала можно узнать из Telegram update, полученного ботом до установки webhook.
