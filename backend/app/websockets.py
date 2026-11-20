from typing import Any

from fastapi import FastAPI
from socketio import AsyncServer
from socketio.asgi import ASGIApp

sio = AsyncServer(async_mode="asgi", cors_allowed_origins=[])
socket_app = ASGIApp(sio, socketio_path="/ws/socket.io")


def init_websockets(app: FastAPI) -> None:
    app.mount("/ws", socket_app)


async def connect(sid: str, environ: dict[str, Any]) -> None:
    print(f"Client connected: {sid}")


async def disconnect(sid: str) -> None:
    print(f"Client disconnected: {sid}")


sio.on("connect", connect)
sio.on("disconnect", disconnect)
