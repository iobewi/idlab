"""Loopback HTTP API and WebSocket broker for browser-owned serial ports."""
import asyncio
from dataclasses import dataclass
import hmac
import ipaddress
import os
from pathlib import Path
import re
import secrets
import uuid

from aiohttp import WSMsgType, web

ROOT = Path(__file__).resolve().parent
BUNDLE = ROOT / "node_modules/esptool-js/bundle.js"
MAX_READ = 4 * 1024 * 1024
BOARD_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}")
MAC = re.compile(r"(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", re.IGNORECASE)


@dataclass
class Operation:
    id: str
    future: asyncio.Future


@dataclass
class Board:
    generation: str
    socket: web.WebSocketResponse
    identity: dict
    pending: Operation | None = None

    def describe(self):
        return {"generation": self.generation, **self.identity}


def problem(status, code):
    return web.json_response({"error": code}, status=status)


def validate_identity(value):
    if not isinstance(value, dict):
        raise ValueError("invalid_identity")
    chip, mac = value.get("chip"), value.get("mac")
    size, transport, loader = (value.get(key) for key in ("flash_size", "transport", "loader"))
    if not isinstance(chip, str) or not re.fullmatch(r"esp32[a-z0-9]*", chip):
        raise ValueError("invalid_chip")
    if not isinstance(mac, str) or not MAC.fullmatch(mac) or mac.lower() in {"00:" * 5 + "00", "ff:" * 5 + "ff"}:
        raise ValueError("invalid_mac")
    if size is not None and (type(size) is not int or not 0 < size <= 2**26):
        raise ValueError("invalid_flash_capacity")
    if transport not in ("usb_uart", "usb_serial_jtag", "usb_otg", "unknown"):
        raise ValueError("invalid_transport")
    if loader not in ("rom", "stub"):
        raise ValueError("invalid_loader")
    return {
        "chip": chip, "mac": mac.lower(), "flash_size": size, "transport": transport, "loader": loader,
        "capabilities": ["identify", "flash.read"] if loader == "stub" and size else ["identify"],
    }


def create_app(*, port=8080, token=None, read_timeout=600, loopback_forwarded=False):
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    session = secrets.token_urlsafe(32)
    boards = {}
    sockets = set()

    @web.middleware
    async def local_access(request, handler):
        if request.host not in hosts or not request.remote:
            return problem(403, "local_access_required")
        if not loopback_forwarded and not ipaddress.ip_address(request.remote).is_loopback:
            return problem(403, "local_access_required")
        origin = request.headers.get("Origin")
        if origin is not None and origin != f"http://{request.host}":
            return problem(403, "origin_mismatch")
        if request.path.startswith("/api/") or request.path == "/agent":
            cookie = request.cookies.get("idlab_session", "")
            browser = hmac.compare_digest(cookie.encode(), session.encode())
            bearer = request.headers.get("Authorization", "")
            script = token and hmac.compare_digest(bearer.encode(), f"Bearer {token}".encode())
            if request.path == "/agent":
                if not browser or origin is None:
                    return problem(403, "browser_session_required")
            elif not script and (not browser or (request.method == "POST" and origin is None)):
                return problem(401, "authentication_required")
        return await handler(request)

    async def index(request):
        response = web.FileResponse(ROOT / "web/index.html")
        response.set_cookie("idlab_session", session, httponly=True, samesite="Strict")
        return response

    async def health(request):
        if not BUNDLE.is_file():
            return problem(503, "browser_bundle_unavailable")
        return web.json_response({"status": "ready"}, headers={
            "Cache-Control": "no-store", "X-IDLab-Pid": str(os.getpid()),
        })

    async def devices(request):
        return web.json_response({name: board.describe() for name, board in boards.items()})

    async def agent(request):
        name = request.query.get("device", "")
        if not BOARD_NAME.fullmatch(name):
            return problem(400, "invalid_device_name")
        if name in boards:
            return problem(409, "device_already_connected")
        socket = web.WebSocketResponse(heartbeat=20, max_msg_size=MAX_READ + 1)
        sockets.add(socket)
        board = None
        try:
            await socket.prepare(request)
            message = await socket.receive_json(timeout=90)
            if name in boards:
                raise ValueError("device_already_connected")
            board = Board(uuid.uuid4().hex, socket, validate_identity(message))
            boards[name] = board
            await socket.send_json({"generation": board.generation})
            async for message in socket:
                pending = board.pending
                if not pending or pending.future.done():
                    break
                if message.type == WSMsgType.BINARY:
                    pending.future.set_result(message.data)
                elif message.type == WSMsgType.TEXT and message.data == pending.id:
                    pending.future.set_result(None)
                else:
                    break
        except (TypeError, ValueError, TimeoutError, ConnectionError):
            pass
        finally:
            if boards.get(name) is board and board is not None:
                del boards[name]
                if board.pending and not board.pending.future.done():
                    board.pending.future.set_result(None)
            await socket.close()
            sockets.discard(socket)
        return socket

    async def read_flash(request):
        try:
            params = await request.json()
        except (TypeError, ValueError):
            return problem(400, "invalid_json")
        if not isinstance(params, dict) or set(params) != {"generation", "address", "size"}:
            return problem(400, "invalid_arguments")
        board = boards.get(request.match_info["name"])
        if not board or board.socket.closed or params["generation"] != board.generation:
            return problem(409, "device_session_changed")
        if "flash.read" not in board.identity["capabilities"]:
            return problem(409, "operation_unsupported")
        address, size = params["address"], params["size"]
        if (type(address) is not int or type(size) is not int or address < 0
                or not 0 < size <= MAX_READ or address + size > board.identity["flash_size"]):
            return problem(400, "invalid_flash_range")
        if board.pending:
            return problem(409, "device_busy")

        operation = Operation(uuid.uuid4().hex, asyncio.get_running_loop().create_future())
        board.pending = operation
        complete = False
        try:
            await board.socket.send_json({"id": operation.id, "command": "flash.read", "address": address, "size": size})
            data = await asyncio.wait_for(operation.future, timeout=read_timeout)
            complete = data is not None and len(data) == size
            if complete:
                return web.Response(body=data, content_type="application/octet-stream")
        except (ConnectionError, TimeoutError):
            pass
        finally:
            if not complete:
                await board.socket.close(code=1011)
            board.pending = None
        return problem(502, "read_incomplete_reconnect_required")

    async def identify(request):
        board = boards.get(request.match_info["name"])
        return web.json_response(board.describe()) if board and not board.socket.closed else problem(404, "device_disconnected")

    async def close_agents(app):
        await asyncio.gather(*(socket.close(code=1001) for socket in tuple(sockets)))

    app = web.Application(middlewares=[local_access], client_max_size=4096)
    app.on_shutdown.append(close_agents)
    app.add_routes([
        web.get("/", index),
        web.get("/health", health),
        web.get("/api/v1/devices", devices),
        web.get("/api/v1/devices/{name}", identify),
        web.post("/api/v1/devices/{name}/flash/read", read_flash),
        web.get("/agent", agent),
        web.static("/web", ROOT / "web"),
    ])
    async def esptool(request):
        return web.FileResponse(BUNDLE)

    app.router.add_get("/esptool.js", esptool)
    return app


if __name__ == "__main__":
    port = int(os.environ.get("IDLAB_PORT", "8080"))
    forwarded = os.environ.get("IDLAB_LOOPBACK_FORWARDED") == "1"
    app = create_app(port=port, token=os.environ.get("IDLAB_TOKEN"), loopback_forwarded=forwarded)
    web.run_app(app, host="0.0.0.0" if forwarded else "127.0.0.1", port=port, shutdown_timeout=3)
