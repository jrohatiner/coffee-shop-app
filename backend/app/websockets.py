from fastapi import FastAPI
from socketio import AsyncServer
from socketio.asgi import ASGIApp

sio = AsyncServer(async_mode='asgi', cors_allowed_origins='*')
socket_app = ASGIApp(sio)

def init_websockets(app: FastAPI):
    app.mount('/ws', socket_app)

@sio.event
async def connect(sid, environ): print(f"Client connected: {sid}")

@sio.event
async def disconnect(sid): print(f"Client disconnected: {sid}")
