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

from campaigns import CampaignError, Campaigns, search_parameters

ROOT = Path(__file__).resolve().parent
BUNDLE = ROOT / "node_modules/esptool-js/bundle.js"
MAX_READ = 4 * 1024 * 1024
BOARD_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}")
MAC = re.compile(r"(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", re.IGNORECASE)


@dataclass
class Operation:
    id: str
    future: asyncio.Future
    cancelled: bool = False


@dataclass
class Control:
    credential: str
    socket: web.WebSocketResponse
    stopped: str | None = None


@dataclass
class Board:
    generation: str
    socket: web.WebSocketResponse
    identity: dict
    pending: Operation | None = None
    control: Control | None = None
    returning_to_console: bool = False

    def describe(self):
        state = ("stopping" if self.control and self.control.stopped else
                 "busy" if self.pending or self.returning_to_console else "external" if self.control else "available")
        return {"generation": self.generation, **self.identity, "control": state}


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
    metadata = {}
    if "model" in value:
        model = value["model"]
        if not isinstance(model, str) or not 1 <= len(model) <= 160:
            raise ValueError("invalid_model")
        metadata["model"] = model
    for key, maximum in (("flash_id", 0xffffff), ("usb_vid", 0xffff), ("usb_pid", 0xffff)):
        if key in value:
            field = value[key]
            if field is not None and (type(field) is not int or not 0 <= field <= maximum):
                raise ValueError(f"invalid_{key}")
            metadata[key] = field
    return {
        "chip": chip, "mac": mac.lower(), "flash_size": size, "transport": transport, "loader": loader,
        "capabilities": ["identify", "flash.read"] if loader == "stub" and size else ["identify"],
        **metadata,
    }


async def text_field(request, field, limit):
    try:
        payload = await request.json()
    except (TypeError, ValueError) as error:
        raise CampaignError(400, "invalid_json") from error
    if not isinstance(payload, dict) or set(payload) != {field}:
        raise CampaignError(400, "invalid_arguments")
    value = payload[field]
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= limit:
        raise CampaignError(400, "invalid_arguments")
    return value.strip()


def create_app(*, port=8080, token=None, read_timeout=600, loopback_forwarded=False,
               campaign_db=":memory:"):
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    session = secrets.token_urlsafe(32)
    boards = {}
    tokens = {}
    sockets = set()
    CAMPAIGNS = web.AppKey("campaigns", Campaigns)
    LOCAL_OPERATOR = web.RequestKey("local_operator", bool)

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
            scoped = re.fullmatch(r"/api/v1/devices/([\w-]+)(/flash/read)?", request.path)
            board = boards.get(scoped[1]) if scoped else None
            control = board.control if board else None
            control_request = control and hmac.compare_digest(
                bearer.encode(), f"Bearer {control.credential}".encode(),
            )
            if request.path == "/agent":
                if not browser or origin is None:
                    return problem(403, "browser_session_required")
            elif request.path.endswith("/control/connect") and request.headers.get("Upgrade", "").lower() == "websocket":
                pass  # This handshake authenticates with the per-card token.
            elif not control_request and not script and (not browser or (request.method == "POST" and origin is None)):
                return problem(401, "authentication_required")
            request[LOCAL_OPERATOR] = browser and origin is not None and not bearer
        try:
            return await handler(request)
        except CampaignError as error:
            return problem(error.status, error.code)

    async def campaign_storage(app):
        campaigns = Campaigns(campaign_db)
        app[CAMPAIGNS] = campaigns
        try:
            yield
        finally:
            campaigns.close()

    async def list_campaigns(request):
        result = request.app[CAMPAIGNS].search(**search_parameters(request.query))
        return web.json_response(result, headers={"Cache-Control": "no-store"})

    async def start_campaign(request):
        name = await text_field(request, "name", 120)
        campaign = request.app[CAMPAIGNS].start(name)
        return web.json_response(
            campaign, status=201, headers={"Location": f"/api/v1/campaigns/{campaign['id']}"},
        )

    async def get_campaign(request):
        return web.json_response(request.app[CAMPAIGNS].get(request.match_info["id"]))

    async def finish_campaign(request):
        verdict = await text_field(request, "verdict", 80)
        return web.json_response(request.app[CAMPAIGNS].finish(request.match_info["id"], verdict))

    async def abort_campaign(request):
        reason = await text_field(request, "reason", 500)
        campaign = request.app[CAMPAIGNS].abort(request.match_info["id"], reason)
        return web.json_response(campaign, status=202 if campaign["state"] == "abort_requested" else 200)

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

    async def publish_control(board, name):
        if not board.socket.closed:
            try:
                await board.socket.send_json({
                    "control": board.describe()["control"], "has_token": name in tokens,
                })
            except ConnectionError:
                pass

    async def stop_control(name, board, control, reason):
        if board.control is not control or control.stopped:
            return
        control.stopped = reason
        pending = board.pending
        cancelled = pending and not pending.future.done() and not pending.cancelled
        if cancelled:
            pending.cancelled = True
        if not pending:
            board.control = None
        await publish_control(board, name)
        if cancelled and not board.socket.closed:
            try:
                await board.socket.send_json({"cancel": pending.id})
            except ConnectionError:
                pass
        if not control.socket.closed:
            await control.socket.close(code=1008, message=control.stopped.encode())

    async def manage_control(request):
        if not request[LOCAL_OPERATOR]:
            return problem(403, "local_operator_required")
        name = request.match_info["name"]
        action = request.match_info["action"]
        board = boards.get(name)
        if action == "return-console":
            generation = await text_field(request, "generation", 32)
            board = boards.get(name)
            if not board or board.socket.closed or board.generation != generation:
                return problem(409, "device_session_changed")
            if board.control:
                return problem(409, "externally_controlled")
            if board.pending or board.returning_to_console:
                return problem(409, "device_busy")
            board.returning_to_console = True
            return web.json_response({"control": "busy"})
        if action == "token":
            if not board or board.socket.closed:
                return problem(404, "device_disconnected")
            if "flash.read" not in board.identity["capabilities"]:
                return problem(409, "operation_unsupported")
            if name in tokens:
                return problem(409, "control_token_exists")
            credential = secrets.token_urlsafe(32)
            tokens[name] = (credential, board.identity["mac"])
            await publish_control(board, name)
            return web.json_response({"token": credential}, headers={"Cache-Control": "no-store"})
        if action == "revoke":
            tokens.pop(name, None)
        if board and board.control:
            await stop_control(name, board, board.control,
                               "control_revoked" if action == "revoke" else "control_stopped")
        elif board:
            await publish_control(board, name)
        return web.json_response({"control": board.describe()["control"] if board else "disconnected"})

    async def connect_control(request):
        name = request.match_info["name"]
        grant = tokens.get(name)
        supplied = request.headers.get("Authorization", "")
        if not grant or not hmac.compare_digest(supplied.encode(), f"Bearer {grant[0]}".encode()):
            return problem(403, "invalid_control_token")
        board = boards.get(name)
        if not board or board.socket.closed:
            return problem(404, "device_disconnected")
        if board.identity["mac"] != grant[1]:
            return problem(403, "control_token_device_mismatch")
        if "flash.read" not in board.identity["capabilities"]:
            return problem(409, "operation_unsupported")
        if board.control or board.pending or board.returning_to_console:
            return problem(409, "device_busy")
        socket = web.WebSocketResponse(heartbeat=20)
        control = Control(secrets.token_urlsafe(32), socket)
        board.control = control
        sockets.add(socket)
        try:
            await socket.prepare(request)
            await publish_control(board, name)
            await socket.send_json({"session": control.credential, "generation": board.generation})
            async for _ in socket:
                break  # The connection holds control. Commands use the HTTP API.
        finally:
            await stop_control(name, board, control, "control_stopped")
            sockets.discard(socket)
        return socket

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
            await socket.send_json({"generation": board.generation, "has_token": name in tokens})
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
                if board.control:
                    await stop_control(name, board, board.control, "device_session_changed")
            await socket.close()
            sockets.discard(socket)
        return socket

    async def read_flash(request):
        try:
            params = await request.json()
        except (TypeError, ValueError):
            return problem(400, "invalid_json")
        required = {"generation", "address", "size"}
        if not isinstance(params, dict) or not required <= params.keys() <= required | {"campaign_id"}:
            return problem(400, "invalid_arguments")
        campaign_id = params.get("campaign_id")
        if "campaign_id" in params and (not isinstance(campaign_id, str) or
                                        not re.fullmatch(r"[0-9a-f]{32}", campaign_id)):
            return problem(400, "invalid_arguments")
        board = boards.get(request.match_info["name"])
        if not board or board.socket.closed or params["generation"] != board.generation:
            return problem(409, "device_session_changed")
        control = board.control
        if request[LOCAL_OPERATOR]:
            if control:
                return problem(409, "externally_controlled")
        elif not control or not hmac.compare_digest(
            request.headers.get("Authorization", "").encode(), f"Bearer {control.credential}".encode(),
        ):
            return problem(403, "control_session_required")
        elif control.stopped:
            return problem(403, control.stopped)
        if "flash.read" not in board.identity["capabilities"]:
            return problem(409, "operation_unsupported")
        address, size = params["address"], params["size"]
        if (type(address) is not int or type(size) is not int or address < 0
                or not 0 < size <= MAX_READ or address + size > board.identity["flash_size"]):
            return problem(400, "invalid_flash_range")
        if board.pending or board.returning_to_console:
            return problem(409, "device_busy")

        campaigns = request.app[CAMPAIGNS]
        if campaign_id is not None:
            campaigns.enter(campaign_id)
        operation = Operation(uuid.uuid4().hex, asyncio.get_running_loop().create_future())
        board.pending = operation
        complete = False
        try:
            await board.socket.send_json({"id": operation.id, "command": "flash.read", "address": address, "size": size})
            data = await asyncio.wait_for(operation.future, timeout=read_timeout)
            complete = data is not None and len(data) == size
            if control and control.stopped:
                return problem(403, control.stopped)
            if complete:
                return web.Response(body=data, content_type="application/octet-stream")
        except (ConnectionError, TimeoutError):
            pass
        finally:
            try:
                if not complete:
                    await board.socket.close(code=1011)
            finally:
                board.pending = None
                if control and control.stopped and board.control is control:
                    board.control = None
                    await publish_control(board, request.match_info["name"])
                if campaign_id is not None:
                    campaigns.leave(campaign_id)
        if control and control.stopped in {"control_stopped", "control_revoked"}:
            return problem(403, control.stopped)
        return problem(502, "read_incomplete_reconnect_required")

    async def identify(request):
        board = boards.get(request.match_info["name"])
        return web.json_response(board.describe()) if board and not board.socket.closed else problem(404, "device_disconnected")

    async def close_agents(app):
        await asyncio.gather(*(socket.close(code=1001) for socket in tuple(sockets)))

    async def revalidate_browser_files(request, response):
        if request.path in {"/", "/esptool.js"} or request.path.startswith("/web/"):
            response.headers["Cache-Control"] = "no-cache"

    app = web.Application(middlewares=[local_access], client_max_size=4096)
    app.cleanup_ctx.append(campaign_storage)
    app.on_shutdown.append(close_agents)
    app.on_response_prepare.append(revalidate_browser_files)
    app.add_routes([
        web.get("/", index),
        web.get("/health", health),
        web.get("/api/v1/campaigns", list_campaigns),
        web.post("/api/v1/campaigns", start_campaign),
        web.get("/api/v1/campaigns/{id}", get_campaign),
        web.post("/api/v1/campaigns/{id}/finish", finish_campaign),
        web.post("/api/v1/campaigns/{id}/abort", abort_campaign),
        web.get("/api/v1/devices", devices),
        web.get("/api/v1/devices/{name}", identify),
        web.post("/api/v1/devices/{name}/control/{action:token|stop|revoke|return-console}", manage_control),
        web.get("/api/v1/devices/{name}/control/connect", connect_control),
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
    public_port = int(os.environ.get("IDLAB_PUBLIC_PORT", str(port)))
    state_dir = Path(os.environ.get("IDLAB_STATE_DIR", Path.home() / ".local/state/idlab"))
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    app = create_app(port=public_port, token=os.environ.get("IDLAB_TOKEN"),
                     loopback_forwarded=forwarded, campaign_db=state_dir / "campaigns.sqlite3")
    web.run_app(app, host="0.0.0.0" if forwarded else "127.0.0.1", port=port, shutdown_timeout=3)
