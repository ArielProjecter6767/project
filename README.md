# CommonSpace

Адаптивный онлайн-звонок, персональный ИИ, погода и интерактивный глобус. Backend: FastAPI + MongoDB Atlas; deployment: Render Web Service.

## Что реализовано в первом этапе
- Регистрация и вход по уникальному никнейму и паролю; пароль хешируется Argon2, сессия хранится в защищённой подписанной cookie.
- Автоматическое подключение к общей комнате после входа, количество участников и выход/повторное подключение.
- WebRTC mesh-аудио/видео, mute/unmute, управление локальной камерой, переключение передней/задней камеры на мобильном устройстве, громкость удалённых участников.
- Персональная история чата ИИ в MongoDB, Groq API.
- Генерация изображений через Cloudflare Workers AI.
- Поиск погоды по названию или координатам, OpenWeather tiles для температуры, осадков, ветра, давления и облаков.
- Cesium World Terrain/глобус, границы, метка геолокации, сохранение выбранного режима Земли.
- Адаптивный интерфейс desktop/tablet/mobile.

## Важно о звонке
Сигналинг и список участников используют WebSocket, медиа передаётся напрямую между браузерами через WebRTC. Это mesh-архитектура без SFU: для небольшой общей комнаты она удобна, но нагрузка растёт с каждым участником, а в некоторых сетях понадобится TURN. Для публичного крупного сервиса следующий этап — отдельный SFU (например, LiveKit) и TURN. Пока список участников находится в памяти одного процесса Render; для нескольких инстансов потребуется Redis/внешний realtime-сервис.

## Render
Создайте Web Service через **New → Blueprint** и выберите этот репозиторий, либо создайте Web Service вручную:
- Build Command: `pip install -r requirements.txt`
- Start Command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Health Check Path: `/api/health`

Добавьте Environment Variables:
- `SECRET_KEY`: случайный длинный секрет (Blueprint может сгенерировать).
- `MONGODB_URI`: строка подключения MongoDB Atlas. В Atlas разрешите сетевой доступ для Render (для начальной проверки можно временно разрешить 0.0.0.0/0, лучше ограничить после настройки).
- `DATABASE_NAME`: `commonspace`
- `COOKIE_SECURE`: `true` на Render HTTPS.
- `GROQ_API_KEY`: ключ из https://console.groq.com/keys
- `GROQ_MODEL`: `openai/gpt-oss-120b` (доступность зависит от аккаунта Groq).
- `CLOUDFLARE_ACCOUNT_ID` и `CLOUDFLARE_API_TOKEN`: токен Cloudflare с доступом Workers AI.
- `CLOUDFLARE_IMAGE_MODEL`: `@cf/black-forest-labs/flux-1-schnell`
- `OPENWEATHER_API_KEY`: API key OpenWeather с доступом к нужным endpoints/tiles.
- `CESIUM_ION_TOKEN`: Cesium ion token для глобуса и terrain.

Секреты храните только в Render Environment — не помещайте их в JavaScript или GitHub.

## MongoDB Atlas
Создайте database user и database `commonspace`, скопируйте URI в `MONGODB_URI`. Убедитесь, что пароль в URI URL-encoded, если содержит специальные символы.

## Локальный запуск
```bash
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
# скопируйте .env.example в .env и задайте переменные
uvicorn main:app --reload
``

Откройте http://127.0.0.1:8000. Локально задайте `COOKIE_SECURE=false`.

## Проверка
1. Откройте `/api/health` — сервис должен ответить JSON.
2. Зарегистрируйте два аккаунта в разных браузерах/устройствах.
3. Разрешите браузеру использовать микрофон/камеру и проверьте звук/видео.
4. Проверьте ИИ, погоду и глобус после добавления соответствующих API keys.

## Ограничения первого этапа
- Видеозвонок — WebRTC mesh и без встроенного TURN; часть корпоративных/мобильных сетей может требовать TURN.
- Автоматическое распознавание речи зависит от поддержки Web Speech API браузером. Можно отправить сообщение текстом.
- Для OpenWeather погодных тайлов нужен соответствующий доступ по тарифу/ключу.
- Cloudflare Workers AI image model availability depends on account/region.
