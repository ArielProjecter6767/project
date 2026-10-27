import os
import uuid
import base64
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.sessions import SessionMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pwdlib import PasswordHash

APP_NAME = "CommonSpace"
SECRET_KEY = os.getenv("SECRET_KEY", "change-this-secret-before-deploying")
MONGODB_URI = os.getenv("MONGODB_URI", "")
DATABASE_NAME = os.getenv("DATABASE_NAME", "commonspace")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
CLOUDFLARE_ACCOUNT_ID = os.getenv("CLOUDFLARE_ACCOUNT_ID", "")
CLOUDFLARE_API_TOKEN = os.getenv("CLOUDFLARE_API_TOKEN", "")
CLOUDFLARE_IMAGE_MODEL = os.getenv("CLOUDFLARE_IMAGE_MODEL", "@cf/black-forest-labs/flux-1-schnell")
OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY", "")
CESIUM_ION_TOKEN = os.getenv("CESIUM_ION_TOKEN", "")
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "true").lower() == "true"

app = FastAPI(title=APP_NAME, version="0.1.0")
app.add_middleware(
    SessionMiddleware,
    secret_key=SECRET_KEY,
    session_cookie="commonspace_session",
    same_site="lax",
    https_only=COOKIE_SECURE,
    max_age=60 * 60 * 24 * 14,
)
app.mount("/static", StaticFiles(directory="static"), name="static")

mongo_client: Optional[AsyncIOMotorClient] = None
db = None
password_hash = PasswordHash.recommended()


def utcnow():
    return datetime.now(timezone.utc)


def require_db():
    if db is None:
        raise HTTPException(status_code=503, detail="MongoDB не настроена. Добавьте MONGODB_URI в Render Environment.")
    return db


async def current_user(request: Request):
    database = require_db()
    uid = request.session.get("uid")
    if not uid:
        raise HTTPException(status_code=401, detail="Войдите в аккаунт.")
    user = await database.users.find_one({"_id": uid}, {"password_hash": 0})
    if not user:
        request.session.clear()
        raise HTTPException(status_code=401, detail="Сессия истекла. Войдите снова.")
    return user


class Credentials(BaseModel):
    nickname: str = Field(min_length=2, max_length=24)
    password: str = Field(min_length=8, max_length=128)


class ChatInput(BaseModel):
    message: str = Field(min_length=1, max_length=12000)


class ImageInput(BaseModel):
    prompt: str = Field(min_length=3, max_length=2000)


class PreferencesInput(BaseModel):
    globe_mode: str = Field(default="normal", max_length=30)


class RoomManager:
    def __init__(self):
        self.connections: dict[str, WebSocket] = {}
        self.users: dict[str, dict] = {}

    async def send(self, peer_id: str, payload: dict):
        ws = self.connections.get(peer_id)
        if ws:
            try:
                await ws.send_json(payload)
            except Exception:
                pass

    async def broadcast(self, payload: dict, exclude: Optional[str] = None):
        for peer_id in list(self.connections):
            if peer_id != exclude:
                await self.send(peer_id, payload)

    async def join(self, websocket: WebSocket, user: dict):
        peer_id = uuid.uuid4().hex
        existing = [
            {"peerId": pid, "nickname": self.users[pid]["nickname"]}
            for pid in self.connections
        ]
        await websocket.accept()
        self.connections[peer_id] = websocket
        self.users[peer_id] = {"nickname": user["nickname"], "uid": user["_id"]}
        await websocket.send_json({
            "type": "welcome", "peerId": peer_id, "nickname": user["nickname"],
            "peers": existing, "count": len(self.connections)
        })
        await self.broadcast({
            "type": "peer-joined", "peerId": peer_id,
            "nickname": user["nickname"], "count": len(self.connections)
        }, exclude=peer_id)
        await self.broadcast({"type": "count", "count": len(self.connections)})
        return peer_id

    async def leave(self, peer_id: str):
        user = self.users.pop(peer_id, None)
        self.connections.pop(peer_id, None)
        if user:
            await self.broadcast({"type": "peer-left", "peerId": peer_id, "count": len(self.connections)})
            await self.broadcast({"type": "count", "count": len(self.connections)})


room = RoomManager()


@app.on_event("startup")
async def startup():
    global mongo_client, db
    if MONGODB_URI:
        mongo_client = AsyncIOMotorClient(MONGODB_URI, serverSelectionTimeoutMS=10000)
        db = mongo_client[DATABASE_NAME]
        try:
            await mongo_client.admin.command("ping")
            await db.users.create_index("nickname_lower", unique=True)
            await db.ai_messages.create_index([("uid", 1), ("created_at", 1)])
            await db.preferences.create_index("uid", unique=True)
        except Exception as exc:
            print(f"MongoDB startup check failed: {exc}")


@app.on_event("shutdown")
async def shutdown():
    if mongo_client:
        mongo_client.close()


@app.get("/")
async def home():
    return FileResponse("static/index.html")


@app.get("/api/health")
async def health():
    mongo_ok = False
    if mongo_client:
        try:
            await mongo_client.admin.command("ping")
            mongo_ok = True
        except Exception:
            pass
    return {
        "ok": True, "service": APP_NAME, "mongodb": mongo_ok,
        "groq_configured": bool(GROQ_API_KEY),
        "weather_configured": bool(OPENWEATHER_API_KEY),
        "image_generation_configured": bool(CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN),
        "cesium_configured": bool(CESIUM_ION_TOKEN),
    }


@app.get("/api/config")
async def public_config():
    return {"cesiumIonToken": CESIUM_ION_TOKEN}


@app.post("/api/auth/register")
async def register(payload: Credentials, request: Request):
    database = require_db()
    nickname = payload.nickname.strip()
    if not nickname or any(ch.isspace() for ch in nickname):
        raise HTTPException(status_code=400, detail="Никнейм должен быть без пробелов.")
    if not all(ch.isalnum() or ch in "_-" for ch in nickname):
        raise HTTPException(status_code=400, detail="Используй буквы, цифры, _ или - в никнейме.")
    key = nickname.lower()
    if await database.users.find_one({"nickname_lower": key}):
        raise HTTPException(status_code=409, detail="Этот никнейм уже занят.")
    user_id = uuid.uuid4().hex
    user = {
        "_id": user_id, "nickname": nickname, "nickname_lower": key,
        "password_hash": password_hash.hash(payload.password), "created_at": utcnow()
    }
    try:
        await database.users.insert_one(user)
    except Exception:
        raise HTTPException(status_code=409, detail="Этот никнейм уже занят.")
    request.session.clear()
    request.session["uid"] = user_id
    request.session["nickname"] = nickname
    return {"ok": True, "user": {"id": user_id, "nickname": nickname}, "autoJoin": True}


@app.post("/api/auth/login")
async def login(payload: Credentials, request: Request):
    database = require_db()
    user = await database.users.find_one({"nickname_lower": payload.nickname.strip().lower()})
    if not user or not password_hash.verify(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Неверный никнейм или пароль.")
    request.session.clear()
    request.session["uid"] = user["_id"]
    request.session["nickname"] = user["nickname"]
    return {"ok": True, "user": {"id": user["_id"], "nickname": user["nickname"]}, "autoJoin": True}


@app.post("/api/auth/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/api/auth/me")
async def me(request: Request):
    user = await current_user(request)
    return {"user": {"id": user["_id"], "nickname": user["nickname"]}}


@app.get("/api/ai/history")
async def ai_history(request: Request, limit: int = Query(100, ge=1, le=200)):
    user = await current_user(request)
    cursor = require_db().ai_messages.find({"uid": user["_id"]}).sort("created_at", 1).limit(limit)
    items = []
    async for item in cursor:
        item.pop("_id", None)
        item.pop("uid", None)
        items.append(item)
    return {"messages": items}


@app.post("/api/ai/chat")
async def ai_chat(payload: ChatInput, request: Request):
    user = await current_user(request)
    database = require_db()
    prompt = payload.message.strip()
    if not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="ИИ не подключён: добавьте GROQ_API_KEY в Render Environment.")
    try:
        from groq import AsyncGroq
        client = AsyncGroq(api_key=GROQ_API_KEY)
        history_cursor = database.ai_messages.find({"uid": user["_id"], "kind": "text"}).sort("created_at", -1).limit(12)
        history = [x async for x in history_cursor]
        history.reverse()
        messages = [{"role": "system", "content": "Ты — дружелюбный ИИ-помощник CommonSpace. Отвечай на языке пользователя, по умолчанию на русском. Будь точным и безопасным."}]
        for item in history:
            if item.get("role") in ("user", "assistant"):
                messages.append({"role": item["role"], "content": item["content"]})
        messages.append({"role": "user", "content": prompt})
        result = await client.chat.completions.create(model=GROQ_MODEL, messages=messages, temperature=0.7, max_tokens=1500)
        answer = result.choices[0].message.content or "Не удалось сформировать ответ."
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Groq request failed: {type(exc).__name__}: {exc}")
        raise HTTPException(status_code=502, detail=f"Groq не ответил. Проверьте GROQ_MODEL и GROQ_API_KEY. ({type(exc).__name__})")
    now = utcnow()
    await database.ai_messages.insert_many([
        {"uid": user["_id"], "role": "user", "content": prompt, "kind": "text", "created_at": now},
        {"uid": user["_id"], "role": "assistant", "content": answer, "kind": "text", "created_at": utcnow()},
    ])
    return {"answer": answer}


@app.post("/api/ai/image")
async def ai_image(payload: ImageInput, request: Request):
    user = await current_user(request)
    database = require_db()
    if not CLOUDFLARE_ACCOUNT_ID or not CLOUDFLARE_API_TOKEN:
        raise HTTPException(status_code=503, detail="Генерация изображений не настроена: нужны CLOUDFLARE_ACCOUNT_ID и CLOUDFLARE_API_TOKEN.")
    url = f"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/{CLOUDFLARE_IMAGE_MODEL}"
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(url, headers={"Authorization": f"Bearer {CLOUDFLARE_API_TOKEN}"}, json={"prompt": payload.prompt})
        if response.status_code >= 400:
            print(f"Cloudflare image error {response.status_code}: {response.text[:500]}")
            raise HTTPException(status_code=502, detail="Cloudflare AI не смог создать изображение. Проверьте токен, аккаунт и модель.")
        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            data = response.json()
            result = data.get("result") or {}
            encoded = result.get("image")
            if not encoded:
                raise HTTPException(status_code=502, detail="Cloudflare вернул неожиданный ответ без изображения.")
            image_url = "data:image/png;base64," + encoded
        else:
            image_url = "data:image/png;base64," + base64.b64encode(response.content).decode("ascii")
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Cloudflare request failed: {exc}")
        raise HTTPException(status_code=502, detail="Не удалось связаться с Cloudflare AI.")
    now = utcnow()
    await database.ai_messages.insert_many([
        {"uid": user["_id"], "role": "user", "content": "Создать изображение: " + payload.prompt, "kind": "image", "created_at": now},
        {"uid": user["_id"], "role": "assistant", "content": "Изображение создано по запросу: " + payload.prompt, "kind": "image", "created_at": utcnow()},
    ])
    return {"image": image_url, "prompt": payload.prompt}


@app.get("/api/weather")
async def weather(request: Request, q: Optional[str] = None, lat: Optional[float] = None, lon: Optional[float] = None):
    await current_user(request)
    if not OPENWEATHER_API_KEY:
        raise HTTPException(status_code=503, detail="Погода не подключена: добавьте OPENWEATHER_API_KEY.")
    async with httpx.AsyncClient(timeout=20) as client:
        if q and q.strip():
            geo = await client.get("https://api.openweathermap.org/geo/1.0/direct", params={"q": q.strip(), "limit": 1, "appid": OPENWEATHER_API_KEY})
            if geo.status_code >= 400:
                raise HTTPException(status_code=502, detail="OpenWeather не смог найти это место.")
            places = geo.json()
            if not places:
                raise HTTPException(status_code=404, detail="Место не найдено. Попробуйте другое название или координаты.")
            lat, lon = places[0]["lat"], places[0]["lon"]
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            raise HTTPException(status_code=400, detail="Укажите название места или корректные координаты.")
        res = await client.get("https://api.openweathermap.org/data/2.5/weather", params={"lat": lat, "lon": lon, "appid": OPENWEATHER_API_KEY, "units": "metric", "lang": "ru"})
    if res.status_code >= 400:
        raise HTTPException(status_code=502, detail="OpenWeather не смог получить погоду.")
    data = res.json()
    return {
        "name": data.get("name") or f"{lat:.3f}, {lon:.3f}",
        "country": data.get("sys", {}).get("country", ""),
        "lat": lat, "lon": lon, "temp": round(data.get("main", {}).get("temp", 0)),
        "feels_like": round(data.get("main", {}).get("feels_like", 0)),
        "humidity": data.get("main", {}).get("humidity"),
        "wind": data.get("wind", {}).get("speed"),
        "description": data.get("weather", [{}])[0].get("description", "Погода"),
        "icon": data.get("weather", [{}])[0].get("icon", "01d"),
        "weather_id": data.get("weather", [{}])[0].get("id", 800),
        "sunrise": data.get("sys", {}).get("sunrise"), "sunset": data.get("sys", {}).get("sunset"),
    }


@app.get("/api/weather/tiles/{layer}/{z}/{x}/{y}.png")
async def weather_tile(layer: str, z: int, x: int, y: int):
    if not OPENWEATHER_API_KEY:
        raise HTTPException(status_code=503, detail="OpenWeather API key is not configured.")
    layers = {"temperature": "TA2", "precipitation": "PR0", "wind": "WS10", "pressure": "PA0", "clouds": "CL"}
    if layer not in layers or not (0 <= z <= 18) or x < 0 or y < 0:
        raise HTTPException(status_code=400, detail="Invalid tile request.")
    url = f"https://maps.openweathermap.org/maps/2.0/weather/{layers[layer]}/{z}/{x}/{y}"
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(url, params={"appid": OPENWEATHER_API_KEY, "fill_bound": "true"})
    if response.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"OpenWeather tiles error ({response.status_code}).")
    return Response(response.content, media_type=response.headers.get("content-type", "image/png"), headers={"Cache-Control": "public, max-age=600"})


@app.get("/api/preferences")
async def get_preferences(request: Request):
    user = await current_user(request)
    prefs = await require_db().preferences.find_one({"uid": user["_id"]})
    return {"globe_mode": prefs.get("globe_mode", "normal") if prefs else "normal", "geolocation_enabled": prefs.get("geolocation_enabled", False) if prefs else False}


@app.put("/api/preferences")
async def save_preferences(payload: PreferencesInput, request: Request):
    user = await current_user(request)
    allowed = {"normal", "temperature", "precipitation", "wind", "pressure", "clouds"}
    if payload.globe_mode not in allowed:
        raise HTTPException(status_code=400, detail="Неизвестный режим Земли.")
    await require_db().preferences.update_one({"uid": user["_id"]}, {"$set": {"globe_mode": payload.globe_mode, "updated_at": utcnow()}}, upsert=True)
    return {"ok": True, "globe_mode": payload.globe_mode}


@app.websocket("/ws/room")
async def room_socket(websocket: WebSocket):
    uid = (websocket.scope.get("session") or {}).get("uid")
    if not uid or db is None:
        await websocket.close(code=4401)
        return
    user = await db.users.find_one({"_id": uid}, {"password_hash": 0})
    if not user:
        await websocket.close(code=4401)
        return
    peer_id = await room.join(websocket, user)
    try:
        while True:
            payload = await websocket.receive_json()
            kind = payload.get("type")
            if kind == "signal":
                target = payload.get("target")
                if target in room.connections and target != peer_id:
                    await room.send(target, {
                        "type": "signal", "from": peer_id,
                        "signal": payload.get("signal", {})
                    })
            elif kind == "heartbeat":
                await websocket.send_json({"type": "heartbeat"})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"Room socket error: {exc}")
    finally:
        await room.leave(peer_id)
