# NoomiHub

Каталог модов NoomiClone с подачей ссылок на внешние источники и проверкой модераторами. Сервер: Node.js + Express, данные аккаунтов и каталога: MongoDB. Telegram бот используется только для входа и получения аватара профиля.

## Локальный запуск

Нужны Node.js 20+ и MongoDB.

```sh
npm install
cp .env.example .env
npm start
```

Заполни `MONGODB_URI`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` и `JWT_SECRET`. Секрет webhook сгенерируй командой `openssl rand -hex 32`. Для назначения модераторов укажи их Telegram ID в `MODERATOR_TELEGRAM_IDS`, через запятую.

Пользователь входит через Telegram, затем отправляет форму на сайте: название, описание, URL источника, теги и до пяти скриншотов. Принимаются ссылки HTTP/HTTPS. Сервер не скачивает содержимое ссылки, чтобы проверить её; модератор открывает источник самостоятельно. Повторная подача доступна раз в 24 часа, одинаковые URL отклоняются.

Модератор публикует мод со статусом «Проверено» или «Небезопасно» либо отклоняет заявку. Скриншоты и полученные от Telegram аватары сжимаются в JPEG и хранятся на серверном диске; MongoDB хранит метаданные и имена файлов.

## Render

`render.yaml` объявляет постоянный диск на 1 GB в `/var/data` и задаёт `MEDIA_DIR=/var/data/noomihub-media`. Persistent Disk Render доступен платным Web Services; бесплатный Web Service не может к нему подключить диск. Сам диск тарифицируется отдельно от вычислительного плана. Бот настроит webhook при запуске, если в Render заданы `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` и `MONGODB_URI`.
