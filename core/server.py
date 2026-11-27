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
from flash_plan import MAX_FLASH, MAX_PROGRAM_BODY, SECTOR_SIZE, decode_images, validate_images

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT.parent / "web"
BUNDLE = ROOT / "node_modules/esptool-js/bundle.js"
SERIAL_MODULES = ("board-connector.js", "esp-driver.js", "serial-console.js", "serial-transport.js",
                  "flash-read.js", "md5.js")
MAX_READ = 4 * 1024 * 1024
UART_BUFFER = 1024 * 1024
UART_PAGE = 64 * 1024
BOARD_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}")
MAC = re.compile(r"(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", re.IGNORECASE)


@dataclass
class Operation:
    id: str
    future: asyncio.Future
    source: str
    session_id: str
    cancelled: bool = False
    chunks: list | None = None
    size: int = 0
    received: int = 0
    binaries: list[bytes] | None = None
    read_address: int | None = None
    read_progress: dict | None = None
    agent_disconnected: bool = False
    task: asyncio.Task | None = None
    cancel_requested_at: str | None = None


@dataclass
class Control:
    credential: str
    socket: web.WebSocketResponse
    stopped: str | None = None
    session_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])


@dataclass
class ProgramPlan:
    id: str
    images: list[dict]
    control: Control | None
    deadline: float


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
    program_plan: ProgramPlan | None = None
    recovery_required: bool = False
    recovery_exclusions: set = field(default_factory=set)
    recovery_mac: str | None = None

    def describe(self):
        stopping = (self.control and self.control.stopped) or (self.pending and self.pending.cancelled)
        state = ("recovery_required" if self.recovery_required else "stopping" if stopping else
                 "busy" if self.pending else "external" if self.control else "available")
        return {"generation": self.generation, **self.identity, "control": state}

    def log(self, message, source=None, session_id=None):
        entry = {"at": datetime.now(timezone.utc).isoformat(), "message": message}
        if source:
            entry["source"] = source
            entry["session_id"] = session_id
        self.journal.append(entry)


AGENT_ERROR_CODES = frozenset(["device_command_failed","operation_cancelled","device_session_changed","operation_unsupported","invalid_flash_range","incomplete_flash_read","flash_read_invalid_digest","flash_read_digest_mismatch","serial_buffer_overrun","serial_framing_error","serial_break_error","serial_parity_error","serial_closed","serial_timeout","serial_partial_packet","serial_invalid_escape","serial_frame_too_large","flash_program_failed"])


def agent_error_code(value):
    return value if isinstance(value, str) and value in AGENT_ERROR_CODES else None


def agent_error_status(code):
    return {"invalid_flash_range": 400, "device_session_changed": 409,
            "operation_unsupported": 409, "operation_cancelled": 409}.get(code, 502)


def error_code(value):
    return value if isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,79}", value) else None


def problem(status, code):
    headers = {"X-IDLab-Error": code} if error_code(code) else {}
    return web.json_response({"error": code}, status=status, headers=headers)


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
    if loader == "stub" and size and value.get("programmable") is True:
        capabilities.append("flash.program")
    if loader == "stub" and size and value.get("erasable") is True:
        capabilities.append("flash.erase")
        if value.get("erasable_region") is True:
            capabilities.append("flash.erase.region")
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
    detached_reads = {}
    recovery_keys = set()
    finalizing = set()
    tokens = {}
    sockets = set()
    operation_tasks = set()
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
        recovery_keys.update(campaigns.recovery_keys())
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
            pending.cancel_requested_at = datetime.now(timezone.utc).isoformat()
            record = next((entry for entry in board.operations if entry['id'] == pending.id), None)
            if record is not None:
                record['cancelRequestedAt'] = pending.cancel_requested_at
            board.log('Annulation demandée', pending.source, pending.session_id)
        await publish_control(board, key)
        if cancelled and not board.socket.closed:
            try:
                await board.socket.send_json({"cancel": pending.id})
            except ConnectionError:
                pass

    def recovery_candidates(storage, key, board):
        mac = board.identity.get("mac") or board.recovery_mac
        matched = storage.matching_recovery(key, board.port_key, mac)
        uncertain = storage.uncertain_recovery(key, board.port_key, mac)
        # Distinct live ports are already registered; their in-flight intents
        # alone do not establish an identity ambiguity.
        uncertain -= {other for other, live in boards.items() if live.pending}
        return matched, uncertain - board.recovery_exclusions

    async def refresh_recovery(storage, *, exclude=None):
        changed = []
        active = {key for key, live in boards.items() if live.pending}
        for key, board in boards.items():
            if board is exclude:
                continue
            matched, uncertain = recovery_candidates(storage, key, board)
            # Live operation intents are not unresolved terminations. A detached
            # generation, in contrast, must remain fenced until finalized.
            required = bool((matched - active) or uncertain or key in finalizing)
            if board.pending and board.recovery_required:
                # Never release a recovery fence while hardware is still active.
                required = True
            if required != board.recovery_required:
                board.recovery_required = required
                changed.append((key, board))
        # Set all fences before the first await, then stop existing grants and
        # request cooperative cancellation without releasing active operations.
        for key, board in changed:
            if board.recovery_required and board.control:
                await stop_control(key, board, board.control, "device_recovery_required")
            elif board.recovery_required and board.pending:
                await request_operation_stop(key, board)
            else:
                await publish_control(board, key)

    async def manage_control(request):
        if not request[LOCAL_OPERATOR]:
            return problem(403, "local_operator_required")
        key = request[BOARD_KEY]
        action = request.match_info["action"]
        board = boards.get(key)
        if action == "recover":
            if not board or board.socket.closed:
                return problem(404, "device_disconnected")
            if board.pending or board.control or key in finalizing:
                return problem(409, "device_busy")
            try:
                payload = await request.json()
            except (ValueError, TypeError):
                return problem(400, "invalid_json")
            if (not isinstance(payload, dict) or
                    payload.keys() - {"generation", "confirmation", "distinct", "candidate"} or
                    payload.get("generation") != board.generation or payload.get("confirmation") != key[1] or
                    ("distinct" in payload and payload["distinct"] is not True) or
                    ("candidate" in payload and not isinstance(payload["candidate"], str)) or
                    ("distinct" in payload and "candidate" in payload)):
                return problem(400, "recovery_confirmation_required")
            if boards.get(key) is not board or board.pending or board.control or board.socket.closed or key in finalizing:
                return problem(409, "device_session_changed")
            if not board.recovery_required:
                return web.json_response({"control": board.describe()["control"]})
            storage = request.app[CAMPAIGNS]
            matched, uncertain = recovery_candidates(storage, key, board)
            candidates = matched | uncertain
            if candidates & finalizing or any(boards.get(k) and boards[k].pending for k in candidates):
                return problem(409, "device_busy")
            if payload.get("distinct"):
                if matched:
                    return problem(409, "recovery_identity_matched")
                board.recovery_exclusions.update(uncertain)
                board.log("Carte distincte confirmée par l’opérateur")
            else:
                candidate = (key[0], payload["candidate"]) if "candidate" in payload else None
                if candidate is not None and candidate not in uncertain:
                    return problem(400, "recovery_confirmation_required")
                if uncertain and candidate is None:
                    return web.json_response({"error": "recovery_identity_indeterminate",
                                              "candidates": sorted(k[1] for k in uncertain)}, status=409)
                for marker in matched | ({candidate} if candidate else set()):
                    storage.clear_recovery(marker)
                    recovery_keys.discard(marker)
                board.log("Récupération matérielle confirmée par l’opérateur")
            await refresh_recovery(storage)
            return web.json_response({"control": board.describe()["control"]})
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
        if board.recovery_required:
            return problem(409, "device_recovery_required")
        if board.control or board.pending:
            return problem(409, "device_busy")
        socket = web.WebSocketResponse(heartbeat=20)
        control = Control(secrets.token_urlsafe(32), socket)
        board.program_plan = None
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
            if port_key:
                board.operations.extend(detached_reads.pop((*key, port_key), ()))
            board.recovery_mac = identity.get("mac")
            matched, uncertain = recovery_candidates(request.app[CAMPAIGNS], key, board)
            board.recovery_required = bool(matched or uncertain or key in finalizing)
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
                        board.recovery_mac = board.identity.get("mac") or board.recovery_mac
                        request.app[CAMPAIGNS].require_recovery(key, board.port_key, board.recovery_mac)
                        board.program_plan = None
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
                        operation_id = event.get("operation")
                        if not isinstance(operation_id, str):
                            board.log(event["journal"][:500])
                        elif pending and operation_id == pending.id:
                            board.log(event["journal"][:500], pending.source, pending.session_id)
                        else:
                            record = next((entry for entry in board.operations if entry["id"] == operation_id), {})
                            board.log(event["journal"][:500], record.get("source"), record.get("session_id"))
                    elif "progress" in event and pending and event.get("id") == pending.id:
                        progress = event["progress"]
                        if (not isinstance(progress, dict) or
                                any(type(progress.get(key)) is not int for key in ("address", "received", "total")) or
                                not 0 <= progress["received"] <= progress["total"] <= MAX_FLASH):
                            break
                        board.progress = progress | {"source": pending.source, "session_id": pending.session_id}
                        previous = pending.read_progress
                        if (progress["address"] == pending.read_address and progress["total"] == pending.size and
                                (previous is None or progress["received"] >= previous["received"])):
                            baudrate = progress.get("baudrate")
                            pending.read_progress = {
                                "received": progress["received"],
                                "baudrate": baudrate if type(baudrate) is int and baudrate > 0
                                else previous["baudrate"] if previous else None,
                            }
                    elif pending and not pending.future.done() and event.get("result") == pending.id:
                        pending.future.set_result(event)
                    else:
                        break
                    continue
                if not pending or pending.future.done():
                    break
                if message.type == WSMsgType.BINARY:
                    if pending.chunks is None:
                        if pending.read_address is not None:
                            pending.received = len(message.data)
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
                if board.pending:
                    # Reserve the logical identity until the old supervisor has finalized.
                    finalizing.add(key)
                    recovery_keys.add(key)
                del boards[key]
                if board.port_key:
                    # Keep recent failed reads in the existing history when the same connector reconnects.
                    failures = [entry for entry in board.operations
                                if entry["command"] == "flash.read" and entry["state"] != "Terminée"]
                    if failures:
                        detached_reads[(*key, board.port_key)] = failures
                        if len(detached_reads) > 32:
                            detached_reads.pop(next(iter(detached_reads)))
                board.uart_changed.set()
                if board.pending and not board.pending.future.done():
                    board.pending.agent_disconnected = True
                    board.pending.future.set_result(None)
                if board.control:
                    await stop_control(key, board, board.control, "device_session_changed")
            await socket.close()
            sockets.discard(socket)
        return socket

    def command_refusal(request, board):
        if board.recovery_required:
            return problem(409, "device_recovery_required")
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
        if request[LOCAL_OPERATOR]:
            source = "web"
            session_id = hashlib.sha256(f"idlab-web-origin:{request[OWNER]}".encode()).hexdigest()[:12]
        else:
            source = "python" if request.headers.get("X-IDLab-Client") == "python" else "api"
            session_id = board.control.session_id
        operation = Operation(uuid.uuid4().hex, asyncio.get_running_loop().create_future(), source, session_id)
        record = {"id": operation.id, "device": name, "command": command, "state": "En cours",
                  "startedAt": datetime.now(timezone.utc).isoformat(), "source": source,
                  "session_id": session_id, **fields}
        if campaign_id:
            record.update(campaign_id=campaign_id, generation=board.generation)
            owners = [request[OWNER]]
            if matches_token(request.headers.get("X-IDLab-API-Authorization", ""), token):
                owners.append(None)
            request.app[CAMPAIGNS].require_owner(campaign_id, *owners)
            request.app[CAMPAIGNS].enter(campaign_id, record)
        # Persist the intent before dispatch, so a process crash fails closed.
        request.app[CAMPAIGNS].require_recovery(request[BOARD_KEY], board.port_key, board.recovery_mac)
        operation.task = asyncio.current_task()
        board.pending = operation
        board.operations.appendleft(record)
        board.log(f"Début · {command}", source, session_id)
        return operation, record, asyncio.get_running_loop().time()

    async def finish_operation(request, board, record, started, result):
        operation = board.pending
        if operation:
            if operation.cancel_requested_at:
                record["cancelRequestedAt"] = operation.cancel_requested_at
            if operation.agent_disconnected or not operation.future.done() or operation.future.cancelled():
                record["termination"] = "unknown"
                record["recoveryRequired"] = True
            else:
                response = operation.future.result()
                record["termination"] = ("cancelled" if isinstance(response, dict)
                                         and response.get("error") == "operation_cancelled"
                                         else "completed" if response is not None else "unknown")
                record["recoveryRequired"] = (record["termination"] == "unknown" or
                                              isinstance(response, dict) and response.get("recovery_required") is True)
        if record.get("recoveryRequired"):
            recovery_keys.add(request[BOARD_KEY])
            board.recovery_required = True
            replacement = boards.get(request[BOARD_KEY])
            if replacement is not None:
                replacement.recovery_required = True
        else:
            request.app[CAMPAIGNS].clear_recovery(request[BOARD_KEY])
            recovery_keys.discard(request[BOARD_KEY])

        finalizing.discard(request[BOARD_KEY])
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
        await refresh_recovery(request.app[CAMPAIGNS])

    async def device_command(request):
        try:
            payload = await request.json()
        except (TypeError, ValueError):
            return problem(400, "invalid_json")
        if not isinstance(payload, dict) or not isinstance(payload.get("command"), str):
            return problem(400, "invalid_arguments")
        command = payload["command"]
        region_erase = command == "flash.erase.region"
        erase = region_erase or command == "flash.erase"
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
        elif erase:
            fields.add("confirmation")
            if region_erase:
                fields.update(("address", "size"))
            if payload.get("confirmation") != request.match_info["name"]:
                return problem(400, "flash_erase_confirmation_required")
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
        record_fields = {}
        timeout = command_timeout
        capacity = board.identity["flash_size"]
        if erase:
            address, size = (payload["address"], payload["size"]) if region_erase else (0, capacity)
            if region_erase and (type(address) is not int or type(size) is not int or address < 0 or
                                 size < SECTOR_SIZE or address % SECTOR_SIZE or size % SECTOR_SIZE or
                                 address + size > capacity):
                return problem(400, "invalid_flash_range")
            record_fields.update(address=address, size=size)
            timeout += read_timeout * (1 + (size - 1) // MAX_READ)
        operation, record, started = start_operation(request, board, name, command, record_fields, campaign_id)
        if erase:
            board.program_plan = None
        complete = False
        try:
            message = {"id": operation.id, "command": command}
            if command == "uart.write":
                message["hex"] = payload["hex"]
            elif command == "mode.rom":
                message["reset"] = payload["reset"]
            elif region_erase:
                message.update(record_fields)
            await board.socket.send_json(message)
            result = await asyncio.wait_for(asyncio.shield(operation.future), timeout=timeout)
            if isinstance(result, dict) and result.get("recovery_required") is True:
                await board.socket.close(code=1011)
            if control and control.stopped:
                return problem(403, control.stopped)
            if operation.cancelled:
                record["detail"] = "Arrêt demandé par l’opérateur."
                return problem(409, "operation_cancelled")
            if not isinstance(result, dict):
                return problem(502, "device_session_changed")
            if result.get("error"):
                code = agent_error_code(result.get("error")) or "device_command_failed"
                detail = result.get("detail")
                if (erase or command in ("mode.loader", "identify")) and isinstance(detail, str) and detail:
                    record["detail"] = detail[:500]
                    return web.json_response({"error": code, "detail": record["detail"]}, status=agent_error_status(code))
                return problem(agent_error_status(code), code)
            value = result.get("value")
            if erase:
                if (not isinstance(value, dict) or value.keys() != {"address", "size", "first_non_ff"} or
                        value["address"] != address or value["size"] != size):
                    return problem(502, "flash_erase_verification_incomplete")
                first = value["first_non_ff"]
                if first is not None and (type(first) is not int or not address <= first < address + size):
                    return problem(502, "flash_erase_verification_incomplete")
                record["verification"] = value
                if first is not None:
                    record["detail"] = f"Premier octet différent de 0xFF à 0x{first:x}."
                    return web.json_response({"error": "flash_erase_verification_failed", "detail": record["detail"]}, status=502)
                record["detail"] = ("Effacement de la zone vérifié. Tous les octets valent 0xFF." if region_erase
                                    else "Effacement intégral vérifié. Tous les octets valent 0xFF.")
            if command == "rom.jedec":
                record["detail"] = value
                board.identity["jedec"] = value
            complete = True
            return web.json_response(board.describe() | {"result": value})
        except TimeoutError:
            record["detail"] = "Le connecteur n’a pas répondu à temps."
            await board.socket.close(code=1011)
            return problem(504, "device_command_timeout")
        except ConnectionError:
            await board.socket.close(code=1011)
            return problem(502, "device_session_changed")
        finally:
            await finish_operation(request, board, record, started, complete)
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
        operation.size = size
        operation.read_address = address
        if stream:
            operation.chunks = []
        complete = False
        result = None
        failure = "read_incomplete"
        outcome = None
        try:
            message = {"id": operation.id, "command": "flash.read", "address": address, "size": size}
            if stream:
                message["stream"] = True
            await board.socket.send_json(message)
            result = await asyncio.wait_for(asyncio.shield(operation.future), timeout=read_timeout if not stream else read_timeout * (1 + (size - 1) // MAX_READ))
            data = result if not stream else None
            capacity = board.identity["flash_size"]
            if stream and isinstance(result, dict) and not result.get("error") and operation.received == size:
                capacity = result.get("value")
                if type(capacity) is int and address + size <= capacity <= MAX_FLASH:
                    data = b"".join(operation.chunks)
            complete = isinstance(data, bytes) and len(data) == size
            if complete and not (control and control.stopped) and not operation.cancelled:
                record.update(bytesRead=size, preview=data[:256].hex(" "), detail=f"{size} octets lus")
                outcome = web.Response(body=data, content_type="application/octet-stream",
                                       headers={"X-IDLab-Flash-Size": str(capacity)})
            elif operation.cancelled and not (control and control.stopped):
                complete = False
        except TimeoutError:
            failure = "flash_read_server_timeout"
        except ConnectionError:
            operation.agent_disconnected = True
        finally:
            # Capture the failure before closing the socket: the recovery itself
            # may invalidate the control session and must not mask the read error.
            if control and control.stopped in {"control_stopped", "control_revoked"}:
                failure = control.stopped
            elif operation.agent_disconnected:
                failure = "agent_disconnected"
            elif control and control.stopped:
                failure = control.stopped
            elif operation.cancelled:
                failure = "operation_cancelled"
            succeeded = outcome is not None
            record_read_diagnostic(operation, record, result, failure, succeeded)
            try:
                recoverable = isinstance(result, dict) and (
                    (stream and result.get("error") == "invalid_flash_range") or
                    (operation.cancelled and result.get("error") == "operation_cancelled") or
                    (stream and result.get("console_restored") is True and board.identity.get("mode") == "console")
                )
                if (isinstance(result, dict) and result.get('recovery_required') is True or
                        not complete and (not recoverable or control and control.stopped)):
                    await board.socket.close(code=1011)
            finally:
                await finish_operation(request, board, record, started, succeeded)
                if not succeeded:
                    board.log(f"{record['detail']} · {record['duration']}", operation.source, operation.session_id)
                if control and control.stopped and board.control is control:
                    board.control = None
                    await publish_control(board, key)
                elif operation.cancelled and not control:
                    await publish_control(board, key)
        if outcome is not None:
            return outcome
        code = record["error"]
        status = {"control_stopped": 403, "control_revoked": 403,
                  "flash_read_server_timeout": 504}.get(code, agent_error_status(code))
        return problem(status, code)

    def record_read_diagnostic(operation, record, result, failure, succeeded):
        progress = operation.read_progress
        received = progress["received"] if progress is not None else None
        record.update(bytesReceived=received, bytesTransferred=operation.received,
                      lastOffset=record["address"] + received if received is not None else None,
                      baudrate=progress["baudrate"] if progress is not None else None)
        if succeeded:
            return
        response = result if isinstance(result, dict) else {}
        diagnostic = response.get("read_diagnostic")
        diagnostic = diagnostic if isinstance(diagnostic, dict) else {}

        restored = diagnostic.get("console_restored", response.get("console_restored") if not diagnostic else None)
        agent_error = agent_error_code(diagnostic.get("error")) or agent_error_code(response.get("error"))
        error = (agent_error or failure) if failure == "read_incomplete" else failure
        if error == "read_incomplete":
            error = "read_incomplete_reconnect_required"
        record.update(error=error, consoleRestored=restored if type(restored) is bool else None)
        if agent_error and agent_error != error:
            record["agentError"] = agent_error
        recovery_error = agent_error_code(diagnostic.get("console_error"))
        if recovery_error:
            record["consoleRecoveryError"] = recovery_error

        detail = [f"Lecture flash en échec · {error}"]
        if record["lastOffset"] is not None:
            detail.append(f"{received}/{record['size']} octets reçus par l’agent · offset 0x{record['lastOffset']:x}")
        else:
            detail.append("Progression agent inconnue")
        detail.append(f"{operation.received} octets transférés au serveur")
        if record["baudrate"] is not None:
            detail.append(f"{record['baudrate']} bauds")
        if restored is True:
            detail.append("Console rétablie")
        elif restored is False:
            detail.append("Console non rétablie" + (f" ({recovery_error})" if recovery_error else ""))
        else:
            detail.append("Récupération console non renseignée")
        record["detail"] = " · ".join(detail)

    def programming_board(request, generation):
        board = boards.get(request[BOARD_KEY])
        if not board or board.socket.closed or generation != board.generation:
            return None, problem(409, "device_session_changed")
        refusal = command_refusal(request, board)
        if refusal is not None:
            return None, refusal
        if board.pending:
            return None, problem(409, "device_busy")
        if "flash.program" not in board.identity["capabilities"]:
            return None, problem(409, "operation_unsupported")
        return board, None

    async def prepare_program(request):
        try:
            payload = await request.json()
        except (TypeError, ValueError):
            return problem(400, "invalid_json")
        if not isinstance(payload, dict) or payload.keys() != {"generation", "images"}:
            return problem(400, "invalid_arguments")
        board, refusal = programming_board(request, payload["generation"])
        if refusal is not None:
            return refusal
        images = payload["images"]
        try:
            validate_images(images, board.identity["flash_size"])
        except ValueError as error:
            return problem(400, str(error))
        plan = ProgramPlan(secrets.token_urlsafe(32), images, board.control, asyncio.get_running_loop().time() + 600)
        board.program_plan = plan
        return web.json_response({"plan_id": plan.id, "images": plan.images}, status=201)

    async def program_image(request):
        # Only the browser holding the serial connection downloads the payload.
        if request.headers.get("Authorization"):
            return problem(403, "browser_session_required")
        board = boards.get(request[BOARD_KEY])
        operation = board.pending if board else None
        if (not operation or operation.id != request.match_info["operation_id"] or
                operation.cancelled or operation.binaries is None):
            return problem(404, "flash_image_not_found")
        index = int(request.match_info["index"])
        if index >= len(operation.binaries):
            return problem(404, "flash_image_not_found")
        return web.Response(body=operation.binaries[index], content_type="application/octet-stream")

    async def program_flash(request):
        try:
            payload = await request.clone(client_max_size=MAX_PROGRAM_BODY).json()
        except (TypeError, ValueError):
            return problem(400, "invalid_json")
        required = {"generation", "plan_id", "binaries"}
        if not isinstance(payload, dict) or not required <= payload.keys() <= required | {"campaign_id"}:
            return problem(400, "invalid_arguments")
        board, refusal = programming_board(request, payload["generation"])
        if refusal is not None:
            return refusal
        plan = board.program_plan
        if (not plan or payload["plan_id"] != plan.id or plan.control is not board.control or
                asyncio.get_running_loop().time() >= plan.deadline):
            return problem(409, "flash_plan_confirmation_required")
        try:
            validate_images(plan.images, board.identity["flash_size"])
            binaries = decode_images(payload["binaries"], plan.images)
        except ValueError as error:
            return problem(400, str(error))

        key = request[BOARD_KEY]
        control = board.control
        total = sum(image["size"] for image in plan.images)
        operation, record, started = start_operation(
            request, board, key[1], "flash.program", {"images": plan.images}, operation_campaign(payload),
        )
        board.program_plan = None
        operation.binaries = binaries
        complete = False
        try:
            await board.socket.send_json({"id": operation.id, "command": "flash.program", "images": plan.images})
            result = await asyncio.wait_for(asyncio.shield(operation.future), timeout=read_timeout * 2 * (1 + (total - 1) // MAX_READ))
            if isinstance(result, dict) and result.get("recovery_required") is True:
                await board.socket.close(code=1011)
            if control and control.stopped:
                return problem(403, control.stopped)
            if operation.cancelled:
                return problem(409, "operation_cancelled")
            if not isinstance(result, dict) or result.get("error"):
                if isinstance(result, dict) and isinstance(result.get("detail"), str):
                    record["detail"] = result["detail"][:500]
                code = agent_error_code(result.get("error")) if isinstance(result, dict) else None
                return problem(agent_error_status(code), code or "flash_program_failed")
            digests = result.get("value")
            if not isinstance(digests, list) or len(digests) != len(plan.images) or any(
                    not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest) for digest in digests):
                return problem(502, "flash_program_failed")
            verification = [image | {"readback_sha256": digest, "matches": digest == image["sha256"]}
                            for image, digest in zip(plan.images, digests, strict=True)]
            if "previews" in result:
                previews = result["previews"]
                if not isinstance(previews, list) or len(previews) != len(verification):
                    return problem(502, "flash_program_failed")
                for image, preview, binary in zip(verification, previews, binaries, strict=True):
                    length = min(image["size"], 256) * 2
                    if not isinstance(preview, str) or len(preview) != length or not re.fullmatch(r"[0-9a-f]+", preview):
                        return problem(502, "flash_program_failed")
                    image["readback_preview"] = preview
                    image["matches"] = image["matches"] and preview == binary[:256].hex()
            record["verification"] = verification
            complete = all(image["matches"] for image in verification)
            record["detail"] = "Écriture vérifiée par relecture SHA-256." if complete else "La relecture diffère du binaire attendu."
        except TimeoutError:
            record["detail"] = "Le connecteur n’a pas répondu à temps."
            await board.socket.close(code=1011)
            return problem(504, "flash_program_timeout")
        except ConnectionError:
            operation.agent_disconnected = True
            await board.socket.close(code=1011)
            return problem(502, "flash_program_failed")
        finally:
            await finish_operation(request, board, record, started, complete)
            if control and control.stopped and board.control is control:
                board.control = None
                await publish_control(board, key)
            elif operation.cancelled and not control:
                await publish_control(board, key)
        if not complete:
            return web.json_response({"error": "flash_verification_failed", "operation": record}, status=502)
        return web.json_response(record)

    async def identify(request):
        key = request[BOARD_KEY]
        board = boards.get(key)
        return web.json_response(board.describe()) if board and not board.socket.closed else problem(404, "device_disconnected")

    def supervise_operation(handler):
        async def supervised(request):
            task = asyncio.create_task(handler(request))
            operation_tasks.add(task)

            def finished(done):
                operation_tasks.discard(done)
                if not done.cancelled():
                    done.exception()  # Retrieve errors even if the HTTP peer left.

            task.add_done_callback(finished)
            try:
                return await asyncio.shield(task)
            except asyncio.CancelledError:
                board = boards.get(request[BOARD_KEY])
                if board and board.pending and board.pending.task is task:
                    await request_operation_stop(request[BOARD_KEY], board)
                elif not task.done():
                    # No operation has been reserved yet; do not start one later.
                    task.cancel()
                raise
        return supervised

    async def close_agents(app):
        await asyncio.gather(*(socket.close(code=1001) for socket in tuple(sockets)))
        if operation_tasks:
            await asyncio.gather(*tuple(operation_tasks), return_exceptions=True)

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
        web.post("/api/v1/devices/{name}/control/{action:token|stop|revoke|recover}", manage_control),
        web.get("/api/v1/devices/{name}/control/connect", connect_control),
        web.post("/api/v1/devices/{name}/command", supervise_operation(device_command)),
        web.get("/api/v1/devices/{name}/uart", read_uart),
        web.get("/api/v1/devices/{name}/activity", read_activity),
        web.post("/api/v1/devices/{name}/flash/read", supervise_operation(read_flash)),
        web.post("/api/v1/devices/{name}/flash/plan", prepare_program),
        web.post("/api/v1/devices/{name}/flash/program", supervise_operation(program_flash)),
        web.get(r"/api/v1/devices/{name}/flash/program/{operation_id:[0-9a-f]{32}}/{index:[0-9]{1,2}}", program_image),
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
    web.run_app(app, host="127.0.0.1", port=port, shutdown_timeout=3, handler_cancellation=True)
