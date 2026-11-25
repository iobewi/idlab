"""Loopback HTTP API and WebSocket broker for browser-owned serial ports."""
import asyncio
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import uuid
from urllib.parse import urlsplit

from aiohttp import WSMsgType, web

from api_activity import ApiActivity
from campaigns import CampaignError, Campaigns, search_parameters

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT.parent / "web"
BUNDLE = ROOT / "node_modules/esptool-js/bundle.js"
SERIAL_MODULES = ("board-connector.js", "esp-driver.js", "serial-console.js", "serial-transport.js")
MAX_READ = 4 * 1024 * 1024
MAX_FLASH = 64 * 1024 * 1024
UART_BUFFER = 1024 * 1024
UART_PAGE = 64 * 1024
BOARD_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}")
MAC = re.compile(r"(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", re.IGNORECASE)


@dataclass
class Operation:
    id: str
    future: asyncio.Future
    cancelled: bool = False
    chunks: list | None = None
    size: int = 0
    received: int = 0


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
    port_key: str | None = None
    uart: bytearray = field(default_factory=bytearray)
    uart_end: int = 0
    uart_changed: asyncio.Event = field(default_factory=asyncio.Event)
    journal: deque = field(default_factory=lambda: deque(maxlen=300))
    operations: deque = field(default_factory=lambda: deque(maxlen=100))
    progress: dict | None = None

    def describe(self):
        stopping = (self.control and self.control.stopped) or (self.pending and self.pending.cancelled)
        state = ("stopping" if stopping else
                 "busy" if self.pending else "external" if self.control else "available")
        return {"generation": self.generation, **self.identity, "control": state}


def problem(status, code):
    return web.json_response({"error": code}, status=status)


def validate_identity(value):
    if not isinstance(value, dict):
        raise ValueError("invalid_identity")
    chip, mac = value.get("chip"), value.get("mac")
    size, transport, loader = (value.get(key) for key in ("flash_size", "transport", "loader"))
    if transport not in ("usb_uart", "usb_serial_jtag", "usb_otg", "unknown"):
        raise ValueError("invalid_transport")
    if value.get("mode") == "console":
        capabilities = ["identify", "uart.write", "mode.rom"]
        if transport in ("usb_uart", "usb_serial_jtag"):
            capabilities += ["mode.loader", "console.reset", "flash.read"]
        return {"mode": "console", "chip": None, "mac": None, "flash_size": None,
                "loader": None, "transport": transport, "capabilities": capabilities}
    if not isinstance(chip, str) or not re.fullmatch(r"esp32[a-z0-9]*", chip):
        raise ValueError("invalid_chip")
    if not isinstance(mac, str) or not MAC.fullmatch(mac) or mac.lower() in {"00:" * 5 + "00", "ff:" * 5 + "ff"}:
        raise ValueError("invalid_mac")
    if size is not None and (type(size) is not int or not 0 < size <= 2**26):
        raise ValueError("invalid_flash_capacity")
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
    capabilities = ["identify", "flash.read"] if loader == "stub" and size else ["identify"]
    if value.get("return_to_console") is True and transport in ("usb_uart", "usb_serial_jtag"):
        capabilities.append("mode.console")
    if value.get("mode") == "loader":
        metadata["mode"] = "loader"
        capabilities.append("rom.jedec" if loader == "rom" else "mode.rom")
    return {
        "chip": chip, "mac": mac.lower(), "flash_size": size, "transport": transport, "loader": loader,
        "capabilities": capabilities,
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


async def campaign_fields(request, *, creating=False):
    try:
        payload = await request.json()
    except (TypeError, ValueError) as error:
        raise CampaignError(400, "invalid_json") from error
    if (not isinstance(payload, dict) or not payload or set(payload) - {"name", "metadata"}
            or (creating and "name" not in payload)):
        raise CampaignError(400, "invalid_arguments")
    if "name" in payload:
        name = payload["name"]
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120:
            raise CampaignError(400, "invalid_name")
        payload["name"] = name.strip()
    if "metadata" in payload:
        try:
            metadata = payload["metadata"]
            if not isinstance(metadata, dict) or len(json.dumps(metadata, ensure_ascii=False, allow_nan=False).encode()) > 3000:
                raise ValueError
        except (TypeError, ValueError, RecursionError) as error:
            raise CampaignError(400, "invalid_metadata") from error
    return payload


def operation_campaign(payload):
    if "campaign_id" not in payload:
        return None
    campaign_id = payload["campaign_id"]
    if not isinstance(campaign_id, str) or not re.fullmatch(r"[0-9a-f]{32}", campaign_id):
        raise CampaignError(400, "invalid_campaign_id")
    return campaign_id


def create_app(*, port=8080, token=None, read_timeout=600, public_origin=None,
               campaign_db=":memory:", command_timeout=30):
    origins = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
    if public_origin:
        parsed = urlsplit(public_origin)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or public_origin != f"https://{parsed.netloc}"):
            raise ValueError("IDLAB_PUBLIC_ORIGIN must be an HTTPS origin without a path")
        origins.add(public_origin)
    boards = {}
    tokens = {}
    sockets = set()
    CAMPAIGNS = web.AppKey("campaigns", Campaigns)
    OWNER = web.RequestKey("web_owner", str)
    BOARD_KEY = web.RequestKey("board_key", tuple)
    LOCAL_OPERATOR = web.RequestKey("local_operator", bool)

    def matches_token(supplied, credential):
        return bool(credential) and hmac.compare_digest(supplied.encode(), f"Bearer {credential}".encode())

    def visible_boards(owner):
        if owner is not None:
            return {name: board for (session_id, name), board in boards.items() if session_id == owner}
        result, ambiguous = {}, set()
        for (_, name), board in boards.items():
            if name in result:
                ambiguous.add(name)
            result[name] = board
        for name in ambiguous:
            del result[name]
        return result

    @web.middleware
    async def authenticate(request, handler):
        origin = request.headers.get("Origin")
        if origin is not None and (origin not in origins or urlsplit(origin).netloc != request.host):
            return problem(403, "origin_mismatch")
        if request.path.startswith("/api/") or request.path == "/agent":
            cookie = request.cookies.get("idlab_session", "")
            owner = None
            if re.fullmatch(r"[A-Za-z0-9_-]{43}", cookie):
                candidate = hashlib.sha256(cookie.encode()).hexdigest()
                if request.app[CAMPAIGNS].has_session(candidate):
                    owner = candidate
            bearer = request.headers.get("Authorization", "")
            script = matches_token(bearer, token)
            browser = owner is not None and not bearer
            request[OWNER] = owner if not bearer else None
            request[LOCAL_OPERATOR] = browser and origin is not None
            name = request.match_info.get("name")
            key = (owner, name) if browser else None
            scoped = False
            if name and bearer and not script:
                for board_key, board in boards.items():
                    if board_key[1] == name and board.control and not board.control.stopped and matches_token(
                            bearer, board.control.credential):
                        key, scoped = board_key, True
                        request[OWNER] = board_key[0]
                        break
            if name and script:
                observed = visible_boards(None).get(name)
                key = next((key for key, board in boards.items() if board is observed), None)
            request[BOARD_KEY] = key

            if request.path == "/api/v1/web/session":
                if request.method == "POST" and (origin is None or bearer):
                    return problem(403, "browser_origin_required")
                if request.method != "POST" and not browser:
                    return problem(401, "authentication_required")
            elif request.path in {"/agent", "/api/v1/activity"}:
                if not request[LOCAL_OPERATOR]:
                    return problem(403, "browser_session_required")
            elif request.path == f"/api/v1/devices/{name}/control/connect":
                pass  # This handshake authenticates with the per-card token.
            elif not (scoped or script or (browser and (request.method in {"GET", "HEAD"} or origin))):
                return problem(401, "authentication_required")
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

    def owned_campaign(request):
        campaign_id = request.match_info["id"]
        request.app[CAMPAIGNS].require_owner(campaign_id, request[OWNER])
        return campaign_id

    async def list_campaigns(request):
        result = request.app[CAMPAIGNS].search(owner=request[OWNER], **search_parameters(request.query))
        return web.json_response(result, headers={"Cache-Control": "no-store"})

    async def start_campaign(request):
        fields = await campaign_fields(request, creating=True)
        campaign = request.app[CAMPAIGNS].start(fields["name"], fields.get("metadata", {}), owner=request[OWNER])
        return web.json_response(
            campaign, status=201, headers={"Location": f"/api/v1/campaigns/{campaign['id']}"},
        )

    async def get_campaign(request):
        return web.json_response(request.app[CAMPAIGNS].get(owned_campaign(request)),
                                 headers={"Cache-Control": "no-store"})

    async def update_campaign(request):
        fields = await campaign_fields(request)
        return web.json_response(request.app[CAMPAIGNS].update(owned_campaign(request), fields))

    async def get_campaign_operations(request):
        if set(request.query) - {"limit", "offset"}:
            return problem(400, "invalid_campaign_filters")
        pagination = search_parameters(request.query)
        page = request.app[CAMPAIGNS].operations(
            owned_campaign(request), limit=pagination["limit"], offset=pagination["offset"],
        )
        return web.json_response(page, headers={"Cache-Control": "no-store"})

    async def finish_campaign(request):
        verdict = await text_field(request, "verdict", 80)
        return web.json_response(request.app[CAMPAIGNS].finish(owned_campaign(request), verdict))

    async def abort_campaign(request):
        reason = await text_field(request, "reason", 500)
        campaign = request.app[CAMPAIGNS].abort(owned_campaign(request), reason)
        return web.json_response(campaign, status=202 if campaign["state"] == "abort_requested" else 200)

    async def index(request):
        return web.FileResponse(WEB_ROOT / "index.html")

    async def web_session(request):
        response = web.Response(status=204, headers={"Cache-Control": "no-store"})
        if request.method == "POST" and request[OWNER] is None:
            secret = secrets.token_urlsafe(32)
            request.app[CAMPAIGNS].save_session(hashlib.sha256(secret.encode()).hexdigest())
            response.set_cookie("idlab_session", secret, httponly=True, samesite="Strict",
                                secure=request.headers["Origin"].startswith("https://"))
        return response

    async def health(request):
        if not BUNDLE.is_file():
            return problem(503, "browser_bundle_unavailable")
        return web.json_response({"status": "ready"}, headers={
            "Cache-Control": "no-store", "X-IDLab-Pid": str(os.getpid()),
        })

    async def devices(request):
        return web.json_response({name: board.describe() for name, board in visible_boards(request[OWNER]).items()},
                                 headers={"Cache-Control": "no-store"})

    async def publish_control(board, key):
        if not board.socket.closed:
            try:
                await board.socket.send_json({
                    "control": board.describe()["control"], "has_token": key in tokens,
                })
            except ConnectionError:
                pass

    async def stop_control(key, board, control, reason):
        if board.control is not control or control.stopped:
            return
        control.stopped = reason
        if not board.pending:
            board.control = None
        await request_operation_stop(key, board)
        if not control.socket.closed:
            await control.socket.close(code=1008, message=control.stopped.encode())

    async def request_operation_stop(key, board):
        pending = board.pending
        cancelled = pending and not pending.future.done() and not pending.cancelled
        if cancelled:
            pending.cancelled = True
        await publish_control(board, key)
        if cancelled and not board.socket.closed:
            try:
                await board.socket.send_json({"cancel": pending.id})
            except ConnectionError:
                pass

    async def manage_control(request):
        if not request[LOCAL_OPERATOR]:
            return problem(403, "local_operator_required")
        key = request[BOARD_KEY]
        action = request.match_info["action"]
        board = boards.get(key)
        if action == "token":
            if not board or board.socket.closed:
                return problem(404, "device_disconnected")
            binding = board.port_key or board.identity["mac"]
            if not binding:
                return problem(409, "operation_unsupported")
            if key in tokens:
                return problem(409, "control_token_exists")
            credential = secrets.token_urlsafe(32)
            tokens[key] = (credential, binding)
            await publish_control(board, key)
            return web.json_response({"token": credential}, headers={"Cache-Control": "no-store"})
        if action == "revoke":
            tokens.pop(key, None)
        if board and board.control:
            await stop_control(key, board, board.control,
                               "control_revoked" if action == "revoke" else "control_stopped")
        elif board and action == "stop":
            await request_operation_stop(key, board)
        elif board:
            await publish_control(board, key)
        return web.json_response({"control": board.describe()["control"] if board else "disconnected"})

    async def connect_control(request):
        name = request.match_info["name"]
        supplied = request.headers.get("Authorization", "")
        match = next(((key, grant) for key, grant in tokens.items()
                      if key[1] == name and matches_token(supplied, grant[0])), None)
        if match is None:
            return problem(403, "invalid_control_token")
        key, grant = match
        board = boards.get(key)
        if not board or board.socket.closed:
            return problem(404, "device_disconnected")
        if (board.port_key or board.identity["mac"]) != grant[1]:
            return problem(403, "control_token_device_mismatch")
        if board.control or board.pending:
            return problem(409, "device_busy")
        socket = web.WebSocketResponse(heartbeat=20)
        control = Control(secrets.token_urlsafe(32), socket)
        board.control = control
        sockets.add(socket)
        try:
            await socket.prepare(request)
            await publish_control(board, key)
            await socket.send_json({"session": control.credential, "generation": board.generation})
            async for _ in socket:
                break  # The connection holds control. Commands use the HTTP API.
        finally:
            await stop_control(key, board, control, "control_stopped")
            sockets.discard(socket)
        return socket

    async def agent(request):
        name = request.query.get("device", "")
        if not BOARD_NAME.fullmatch(name):
            return problem(400, "invalid_device_name")
        key = (request[OWNER], name)
        if key in boards:
            return problem(409, "device_already_connected")
        socket = web.WebSocketResponse(heartbeat=20, max_msg_size=MAX_READ + 1)
        sockets.add(socket)
        board = None
        try:
            await socket.prepare(request)
            message = await socket.receive_json(timeout=90)
            if key in boards:
                raise ValueError("device_already_connected")
            identity = validate_identity(message)
            port_key = message.get("port_key")
            if port_key is not None and (not isinstance(port_key, str) or not re.fullmatch(r"[0-9a-f-]{36}", port_key)):
                raise ValueError("invalid_port_key")
            board = Board(uuid.uuid4().hex, socket, identity, port_key=port_key)
            boards[key] = board
            await socket.send_json({"generation": board.generation, "has_token": key in tokens})
            async for message in socket:
                pending = board.pending
                if message.type == WSMsgType.TEXT and message.data.startswith("{"):
                    event = message.json()
                    if not isinstance(event, dict):
                        break
                    if "identity" in event and pending:
                        board.identity = validate_identity(event["identity"])
                        await socket.send_json({"identity": board.describe()})
                    elif "uart" in event and board.identity.get("mode") == "console":
                        encoded = event["uart"]
                        if not isinstance(encoded, str) or len(encoded) > UART_PAGE * 2:
                            break
                        data = bytes.fromhex(encoded)
                        board.uart.extend(data)
                        board.uart_end += len(data)
                        del board.uart[:max(0, len(board.uart) - UART_BUFFER)]
                        if data:
                            board.uart_changed.set()
                            board.uart_changed = asyncio.Event()
                    elif isinstance(event.get("journal"), str):
                        board.journal.append({"at": datetime.now(timezone.utc).isoformat(), "message": event["journal"][:500]})
                    elif "progress" in event and pending and event.get("id") == pending.id:
                        progress = event["progress"]
                        if (not isinstance(progress, dict) or
                                any(type(progress.get(key)) is not int for key in ("address", "received", "total")) or
                                not 0 <= progress["received"] <= progress["total"] <= MAX_FLASH):
                            break
                        board.progress = progress
                    elif pending and not pending.future.done() and event.get("result") == pending.id:
                        pending.future.set_result(event)
                    else:
                        break
                    continue
                if not pending or pending.future.done():
                    break
                if message.type == WSMsgType.BINARY:
                    if pending.chunks is None:
                        pending.future.set_result(message.data)
                    elif not message.data or pending.received + len(message.data) > pending.size:
                        pending.future.set_result(None)
                    else:
                        pending.chunks.append(message.data)
                        pending.received += len(message.data)
                elif message.type == WSMsgType.TEXT and message.data == pending.id:
                    pending.future.set_result(None)
                else:
                    break
        except (TypeError, ValueError, TimeoutError, ConnectionError):
            pass
        finally:
            if boards.get(key) is board and board is not None:
                del boards[key]
                board.uart_changed.set()
                if board.pending and not board.pending.future.done():
                    board.pending.future.set_result(None)
                if board.control:
                    await stop_control(key, board, board.control, "device_session_changed")
            await socket.close()
            sockets.discard(socket)
        return socket

    def command_refusal(request, board):
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
        return None

    def start_operation(request, board, name, command, fields, campaign_id):
        operation = Operation(uuid.uuid4().hex, asyncio.get_running_loop().create_future())
        record = {"id": operation.id, "device": name, "command": command, "state": "En cours",
                  "startedAt": datetime.now(timezone.utc).isoformat(), **fields}
        if campaign_id:
            record.update(campaign_id=campaign_id, generation=board.generation)
            owners = [request[OWNER]]
            if matches_token(request.headers.get("X-IDLab-API-Authorization", ""), token):
                owners.append(None)
            request.app[CAMPAIGNS].require_owner(campaign_id, *owners)
            request.app[CAMPAIGNS].enter(campaign_id, record)
        board.pending = operation
        board.operations.appendleft(record)
        return operation, record, asyncio.get_running_loop().time()

    def finish_operation(request, board, record, started, result):
        record["state"] = "Terminée" if result else "Échec"
        if not result:
            record.setdefault("detail", "Opération interrompue ou en échec.")
        elapsed = asyncio.get_running_loop().time() - started
        record["finishedAt"] = datetime.now(timezone.utc).isoformat()
        record["duration"] = f"{round(1000 * elapsed)} ms"
        if result and record["command"] == "flash.read" and elapsed > 0:
            record["bytesPerSecond"] = round(record["bytesRead"] / elapsed)
        board.progress = board.pending = None
        if "campaign_id" in record:
            request.app[CAMPAIGNS].leave(record["campaign_id"], record)

    async def device_command(request):
        try:
            payload = await request.json()
        except (TypeError, ValueError):
            return problem(400, "invalid_json")
        if not isinstance(payload, dict) or not isinstance(payload.get("command"), str):
            return problem(400, "invalid_arguments")
        command = payload["command"]
        fields = {"generation", "command"}
        if command == "uart.write":
            fields.add("hex")
            encoded = payload.get("hex")
            if not isinstance(encoded, str) or not re.fullmatch(r"(?:[0-9a-fA-F]{2}){1,1900}", encoded):
                return problem(400, "invalid_arguments")
        elif command == "mode.rom":
            fields.add("reset")
            if type(payload.get("reset")) is not bool:
                return problem(400, "invalid_arguments")
        elif command not in ("mode.loader", "mode.console", "console.reset", "rom.jedec", "identify"):
            return problem(409, "operation_unsupported")
        if not fields <= payload.keys() <= fields | {"campaign_id"}:
            return problem(400, "invalid_arguments")
        campaign_id = operation_campaign(payload)
        name = request.match_info["name"]
        key = request[BOARD_KEY]
        board = boards.get(key)
        if not board or board.socket.closed or payload["generation"] != board.generation:
            return problem(409, "device_session_changed")
        refusal = command_refusal(request, board)
        if refusal is not None:
            return refusal
        if board.pending:
            return problem(409, "device_busy")
        if command not in board.identity["capabilities"]:
            return problem(409, "operation_unsupported")
        control = board.control
        operation, record, started = start_operation(request, board, name, command, {}, campaign_id)
        complete = False
        try:
            message = {"id": operation.id, "command": command}
            if command == "uart.write":
                message["hex"] = payload["hex"]
            elif command == "mode.rom":
                message["reset"] = payload["reset"]
            await board.socket.send_json(message)
            result = await asyncio.wait_for(operation.future, timeout=command_timeout)
            if control and control.stopped:
                return problem(403, control.stopped)
            if operation.cancelled:
                record["detail"] = "Arrêt demandé par l’opérateur."
                return problem(409, "operation_cancelled")
            if not isinstance(result, dict):
                return problem(502, "device_session_changed")
            if result.get("error"):
                detail = result.get("detail")
                if command in ("mode.loader", "identify") and isinstance(detail, str) and detail:
                    record["detail"] = detail[:500]
                    return web.json_response({"error": "device_command_failed", "detail": record["detail"]}, status=502)
                return problem(502, "device_command_failed")
            complete = True
            value = result.get("value")
            if command == "rom.jedec":
                record["detail"] = value
                board.identity["jedec"] = value
            return web.json_response(board.describe() | {"result": value})
        except TimeoutError:
            record["detail"] = "Le connecteur n’a pas répondu à temps."
            await board.socket.close(code=1011)
            return problem(504, "device_command_timeout")
        except ConnectionError:
            await board.socket.close(code=1011)
            return problem(502, "device_session_changed")
        finally:
            finish_operation(request, board, record, started, complete)
            if control and control.stopped and board.control is control:
                board.control = None
                await publish_control(board, key)
            elif operation.cancelled and not control:
                await publish_control(board, key)

    async def read_uart(request):
        key = request[BOARD_KEY]
        board = boards.get(key)
        if not board or board.socket.closed:
            return problem(404, "device_disconnected")
        if request.query.get("generation") != board.generation:
            return problem(409, "device_session_changed")
        start = board.uart_end - len(board.uart)
        try:
            cursor = int(request.query.get("cursor", start))
            wait_ms = int(request.query.get("wait_ms", "0"))
        except (TypeError, ValueError):
            return problem(400, "invalid_arguments")
        if not 0 <= cursor <= board.uart_end or not 0 <= wait_ms <= 5000:
            return problem(400, "invalid_arguments")
        if wait_ms and cursor == board.uart_end:
            control = board.control
            scoped = control and hmac.compare_digest(
                request.headers.get("Authorization", "").encode(), f"Bearer {control.credential}".encode(),
            )
            try:
                await asyncio.wait_for(board.uart_changed.wait(), timeout=wait_ms / 1000)
            except TimeoutError:
                pass
            if boards.get(key) is not board or board.socket.closed:
                return problem(404, "device_disconnected")
            if scoped and (board.control is not control or control.stopped):
                return problem(403, "control_session_required")
            start = board.uart_end - len(board.uart)
        offset = max(cursor, start)
        data = board.uart[offset - start:offset - start + UART_PAGE]
        return web.json_response({"hex": data.hex(), "cursor": offset + len(data), "dropped": offset - cursor},
                                 headers={"Cache-Control": "no-store"})

    async def read_activity(request):
        key = request[BOARD_KEY]
        board = boards.get(key)
        if not board or board.socket.closed:
            return problem(404, "device_disconnected")
        if request.query.get("generation") != board.generation:
            return problem(409, "device_session_changed")
        return web.json_response({"device": board.describe(), "external_control": bool(board.control),
                                  "journal": list(board.journal), "progress": board.progress,
                                  "operations": list(board.operations)}, headers={"Cache-Control": "no-store"})

    async def read_flash(request):
        try:
            params = await request.json()
        except (TypeError, ValueError):
            return problem(400, "invalid_json")
        required = {"generation", "address", "size"}
        if not isinstance(params, dict) or not required <= params.keys() <= required | {"campaign_id"}:
            return problem(400, "invalid_arguments")
        campaign_id = operation_campaign(params)
        key = request[BOARD_KEY]
        board = boards.get(key)
        if not board or board.socket.closed or params["generation"] != board.generation:
            return problem(409, "device_session_changed")
        control = board.control
        refusal = command_refusal(request, board)
        if refusal is not None:
            return refusal
        if "flash.read" not in board.identity["capabilities"]:
            return problem(409, "operation_unsupported")
        address, size = params["address"], params["size"]
        stream = board.port_key is not None
        capacity = board.identity["flash_size"] or MAX_FLASH
        if (type(address) is not int or type(size) is not int or address < 0
                or not 0 < size <= (MAX_FLASH if stream else MAX_READ) or address + size > capacity):
            return problem(400, "invalid_flash_range")
        if board.pending:
            return problem(409, "device_busy")

        name = request.match_info["name"]
        operation, record, started = start_operation(
            request, board, name, "flash.read", {"address": address, "size": size}, campaign_id,
        )
        if stream:
            operation.chunks = []
            operation.size = size
        complete = False
        result = None
        try:
            message = {"id": operation.id, "command": "flash.read", "address": address, "size": size}
            if stream:
                message["stream"] = True
            await board.socket.send_json(message)
            result = await asyncio.wait_for(operation.future, timeout=read_timeout if not stream else read_timeout * (1 + (size - 1) // MAX_READ))
            data = result if not stream else None
            capacity = board.identity["flash_size"]
            if stream and isinstance(result, dict) and not result.get("error") and operation.received == size:
                capacity = result.get("value")
                if type(capacity) is int and address + size <= capacity <= MAX_FLASH:
                    data = b"".join(operation.chunks)
            complete = isinstance(data, bytes) and len(data) == size
            if control and control.stopped:
                return problem(403, control.stopped)
            if operation.cancelled:
                complete = False
                record["detail"] = "Arrêt demandé par l’opérateur."
                return problem(409, "operation_cancelled")
            if complete:
                record.update(bytesRead=size, preview=data[:256].hex(" "), detail=f"{size} octets lus")
                return web.Response(body=data, content_type="application/octet-stream",
                                    headers={"X-IDLab-Flash-Size": str(capacity)})
        except (ConnectionError, TimeoutError):
            pass
        finally:
            try:
                recoverable = isinstance(result, dict) and (
                    result.get("error") == "invalid_flash_range" or
                    (operation.cancelled and result.get("error") == "operation_cancelled") or
                    (result.get("console_restored") is True and board.identity.get("mode") == "console")
                )
                if not complete and (not recoverable or control and control.stopped):
                    await board.socket.close(code=1011)
            finally:
                finish_operation(request, board, record, started, complete and not (control and control.stopped))
                if control and control.stopped and board.control is control:
                    board.control = None
                    await publish_control(board, key)
                elif operation.cancelled and not control:
                    await publish_control(board, key)
        if control and control.stopped in {"control_stopped", "control_revoked"}:
            return problem(403, control.stopped)
        if isinstance(result, dict) and result.get("error") and not board.socket.closed:
            if result["error"] == "invalid_flash_range":
                return problem(400, "invalid_flash_range")
            return problem(502, "device_command_failed")
        return problem(502, "read_incomplete_reconnect_required")

    async def identify(request):
        key = request[BOARD_KEY]
        board = boards.get(key)
        return web.json_response(board.describe()) if board and not board.socket.closed else problem(404, "device_disconnected")

    async def close_agents(app):
        await asyncio.gather(*(socket.close(code=1001) for socket in tuple(sockets)))

    async def revalidate_browser_files(request, response):
        if request.path in {"/", "/esptool.js"} or request.path.startswith("/web/"):
            response.headers["Cache-Control"] = "no-cache"
        elif request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"

    async def serial_module(request):
        return web.FileResponse(ROOT / request.path.rsplit("/", 1)[-1])

    activity = ApiActivity(lambda request: request.get(OWNER))
    app = web.Application(middlewares=[authenticate, activity.track], client_max_size=4096)
    app.cleanup_ctx.append(campaign_storage)
    app.on_shutdown.append(close_agents)
    app.on_shutdown.append(activity.close)
    app.on_response_prepare.append(revalidate_browser_files)
    app.add_routes([
        web.get("/", index),
        web.get("/health", health),
        web.get("/api/v1/web/session", web_session),
        web.post("/api/v1/web/session", web_session),
        web.get("/api/v1/activity", activity.observe),
        web.get("/api/v1/campaigns", list_campaigns),
        web.post("/api/v1/campaigns", start_campaign),
        web.get("/api/v1/campaigns/{id}", get_campaign),
        web.patch("/api/v1/campaigns/{id}", update_campaign),
        web.get("/api/v1/campaigns/{id}/operations", get_campaign_operations),
        web.post("/api/v1/campaigns/{id}/finish", finish_campaign),
        web.post("/api/v1/campaigns/{id}/abort", abort_campaign),
        web.get("/api/v1/devices", devices),
        web.get("/api/v1/devices/{name}", identify),
        web.post("/api/v1/devices/{name}/control/{action:token|stop|revoke}", manage_control),
        web.get("/api/v1/devices/{name}/control/connect", connect_control),
        web.post("/api/v1/devices/{name}/command", device_command),
        web.get("/api/v1/devices/{name}/uart", read_uart),
        web.get("/api/v1/devices/{name}/activity", read_activity),
        web.post("/api/v1/devices/{name}/flash/read", read_flash),
        web.get("/agent", agent),
        *(web.get(f"/web/{module}", serial_module) for module in SERIAL_MODULES),
        web.static("/web", WEB_ROOT),
    ])
    async def esptool(request):
        return web.FileResponse(BUNDLE)

    app.router.add_get("/esptool.js", esptool)
    return app


if __name__ == "__main__":
    port = int(os.environ.get("IDLAB_PORT", "8080"))
    public_port = int(os.environ.get("IDLAB_PUBLIC_PORT", str(port)))
    state_dir = Path(os.environ.get("IDLAB_STATE_DIR", Path.home() / ".local/state/idlab"))
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    app = create_app(port=public_port, token=os.environ.get("IDLAB_TOKEN"),
                     public_origin=os.environ.get("IDLAB_PUBLIC_ORIGIN"), campaign_db=state_dir / "campaigns.sqlite3")
    web.run_app(app, host="127.0.0.1", port=port, shutdown_timeout=3)
