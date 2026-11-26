"""Python connector for the IDLab HTTP API."""

from collections.abc import Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from websockets.exceptions import ConnectionClosed, InvalidStatus, WebSocketException
from websockets.sync.client import connect

from .flash_manifest import read_flash_manifest

__all__ = ["Board", "IDLabClient", "IDLabError", "IDLabHTTPError"]


class IDLabError(RuntimeError):
    """The server could not be reached or returned an invalid response."""


class IDLabHTTPError(IDLabError):
    """The server refused an operation."""

    def __init__(self, status: int, code: str):
        super().__init__(f"HTTP {status}: {code}")
        self.status = status
        self.code = code


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _board_path(name: str) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}", name):
        raise ValueError("Invalid IDLab device name")
    return f"/devices/{name}"


def _campaign_path(campaign_id: str) -> str:
    if not isinstance(campaign_id, str) or not re.fullmatch(r"[0-9a-f]{32}", campaign_id):
        raise ValueError("Invalid IDLab campaign ID")
    return f"/campaigns/{campaign_id}"


@dataclass(frozen=True, slots=True)
class Board:
    """Snapshot of an identified board, bound to one server generation."""

    name: str
    generation: str
    chip: str | None
    mac: str | None
    flash_size: int | None
    transport: str
    loader: str | None
    capabilities: tuple[str, ...]
    _client: "IDLabClient" = field(repr=False, compare=False)
    campaign_id: str | None = None

    @property
    def mode(self) -> str:
        return "console" if self.loader is None else "loader"

    def _command(self, command: str, **params) -> "Board":
        board = self._client._board(self.name, self._operate(command, **params))
        return replace(board, campaign_id=self.campaign_id)

    def _operate(self, command: str, **params) -> dict:
        payload = {"generation": self.generation, "command": command, **params}
        if self.campaign_id is not None:
            payload["campaign_id"] = self.campaign_id
        return self._client._request(_board_path(self.name) + "/command", payload)

    def for_campaign(self, campaign_id: str | None) -> "Board":
        """Return a view that tags hardware operations with this campaign."""
        if campaign_id is not None:
            _campaign_path(campaign_id)
        return replace(self, campaign_id=campaign_id)

    def enter_loader(self) -> "Board":
        """Switch from console to the flash loader on a supported transport."""
        return self._command("mode.loader")

    def return_console(self) -> "Board":
        """Return to console if this connection entered the loader from console."""
        return self._command("mode.console")

    def enter_rom(self, *, reset: bool = False) -> "Board":
        """Open ROM mode. If required, place the device in download mode first."""
        return self._command("mode.rom", reset=reset)

    def read_jedec(self) -> dict:
        """Read the flash identifier in ROM mode."""
        return self._operate("rom.jedec")["result"]

    def identify_live(self) -> "Board":
        """Measure hardware identity, temporarily entering the loader if needed."""
        board = self._client._board(self.name, self._operate("identify")["result"])
        return replace(board, campaign_id=self.campaign_id)

    def activity(self) -> dict:
        """Read the server journal, progress, and recent operations."""
        path = _board_path(self.name) + "/activity?" + urlencode({"generation": self.generation})
        return self._client._request(path)

    def reset(self) -> None:
        """Restart the firmware from console mode."""
        self._command("console.reset")

    def write_uart(self, data: str | bytes) -> None:
        """Send bytes or UTF-8 text verbatim to the running console."""
        if isinstance(data, str):
            data = data.encode("utf-8")
        if not isinstance(data, bytes) or not 1 <= len(data) <= 1900:
            raise ValueError("Expected 1 to 1900 UART bytes")
        self._command("uart.write", hex=data.hex())

    def read_uart(self, cursor: int | None = None) -> tuple[bytes, int, int]:
        """Return captured RX bytes, the next cursor, and the number of lost bytes."""
        query = {"generation": self.generation}
        if cursor is not None:
            if type(cursor) is not int or cursor < 0:
                raise ValueError("Expected a nonnegative UART cursor")
            query["cursor"] = str(cursor)
        page = self._client._request(_board_path(self.name) + "/uart?" + urlencode(query))
        try:
            return bytes.fromhex(page["hex"]), page["cursor"], page["dropped"]
        except (KeyError, TypeError, ValueError) as error:
            raise IDLabError("Invalid UART capture response") from error

    def read_flash(self, address: int, size: int) -> bytes:
        """Read exactly size bytes using this board's current session."""
        if type(address) is not int or address < 0 or type(size) is not int or size <= 0:
            raise ValueError("Flash address and size must be integers within a valid range")
        maximum = 4 * 1024 * 1024
        if self.flash_size is not None and size > self.flash_size - address:
            raise ValueError("Flash range exceeds the detected capacity")
        payload = {"generation": self.generation, "address": address, "size": size}
        if self.campaign_id is not None:
            payload["campaign_id"] = self.campaign_id
        return self._client._request(
            _board_path(self.name) + "/flash/read",
            payload,
            expected_bytes=size, timeout=self._client._timeout * (1 + (size - 1) // maximum),
        )

    def prepare_flash(self, images: Sequence[tuple[int, bytes]]) -> dict:
        """Validate a plan, entering the loader from a supported console if needed."""
        if not 1 <= len(images) <= 16 or any(not isinstance(data, bytes) or not data for _, data in images):
            raise ValueError("Expected 1 to 16 nonempty flash images as bytes")
        descriptors = [{"address": address, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                       for address, data in images]
        board = self._flash_loader()
        return self._client._request(_board_path(self.name) + "/flash/plan",
                                     {"generation": board.generation, "images": descriptors})

    def prepare_flash_manifest(self, path: str | Path) -> tuple[dict, list[bytes]]:
        """Load a local manifest, validate its plan, and return the corresponding binaries."""
        board = self._flash_loader()
        images = read_flash_manifest(path, board.chip)
        return board.prepare_flash(images), [data for _, data in images]

    def _flash_loader(self) -> "Board":
        board = self._client.identify(self.name)
        if board.generation != self.generation:
            raise IDLabHTTPError(409, "device_session_changed")
        if board.mode == "console" and "mode.loader" in board.capabilities:
            board = board.for_campaign(self.campaign_id).enter_loader()
            if board.generation != self.generation:
                raise IDLabHTTPError(409, "device_session_changed")
        return board

    def program_flash(self, plan_id: str, binaries: Sequence[bytes]) -> dict:
        """Confirm a validated plan and return its flash write and readback result."""
        if not 1 <= len(binaries) <= 16 or any(not isinstance(data, bytes) or not data for data in binaries):
            raise ValueError("Expected 1 to 16 nonempty flash images as bytes")
        total = sum(map(len, binaries))
        if total > 64 * 1024 * 1024:
            raise ValueError("Expected 1 to 16 nonempty flash images totaling up to 64 MiB")
        payload = {"generation": self.generation, "plan_id": plan_id,
                   "binaries": [base64.b64encode(data).decode("ascii") for data in binaries]}
        if self.campaign_id is not None:
            payload["campaign_id"] = self.campaign_id
        return self._client._request(_board_path(self.name) + "/flash/program", payload,
                                     timeout=self._client._timeout * 2 * (1 + (total - 1) // (4 * 1024 * 1024)))

    def erase_flash(self, *, confirmation: str) -> dict:
        """Erase the entire flash and verify 0xFF readback. Confirm with the board name."""
        return self._erase_flash("flash.erase", confirmation)

    def erase_flash_region(self, address: int, size: int, *, confirmation: str) -> dict:
        """Erase only the selected 4 KiB sectors and verify their 0xFF readback."""
        sector = 4096
        if (type(address) is not int or type(size) is not int or address < 0 or size < sector
                or address % sector or size % sector or self.flash_size and address + size > self.flash_size):
            raise ValueError("Expected a sector-aligned range within the detected flash capacity")
        return self._erase_flash("flash.erase.region", confirmation, size, address=address)

    def _erase_flash(self, command: str, confirmation: str, size: int | None = None, **region) -> dict:
        if confirmation != self.name:
            raise ValueError("Confirm the flash erase with the board name")
        board = self._flash_loader()
        if command not in board.capabilities or not board.flash_size:
            raise ValueError("Flash erase is unavailable in this board session")
        size = board.flash_size if size is None else size
        payload = {"generation": board.generation, "command": command, "confirmation": confirmation}
        if region:
            payload.update(region, size=size)
        if self.campaign_id is not None:
            payload["campaign_id"] = self.campaign_id
        blocks = 1 + (size - 1) // (4 * 1024 * 1024)
        return self._client._request(_board_path(self.name) + "/command", payload,
                                     timeout=self._client._timeout * (1 + blocks))["result"]


class IDLabClient:
    def __init__(self, base_url: str | None = None, *, token: str | None = None,
                 timeout: float = 630, allow_insecure_http: bool | None = None):
        """Configure the client from explicit arguments or the IDLAB environment."""
        if base_url is None:
            base_url = os.environ.get("IDLAB_URL")
            if not base_url:
                raise ValueError("Set IDLAB_URL or pass base_url to IDLabClient")
        if allow_insecure_http is None:
            setting = os.environ.get("IDLAB_ALLOW_INSECURE_HTTP", "false").strip().lower()
            if setting not in {"true", "false"}:
                raise ValueError("IDLAB_ALLOW_INSECURE_HTTP must be true or false")
            allow_insecure_http = setting == "true"
        endpoint = urlsplit(base_url)
        loopback = endpoint.hostname in {"localhost", "127.0.0.1", "::1"}
        if (endpoint.scheme not in {"http", "https"} or not endpoint.hostname
                or endpoint.username is not None or endpoint.password is not None
                or endpoint.path not in {"", "/"} or endpoint.query or endpoint.fragment):
            raise ValueError("Expected an HTTP or HTTPS origin for the IDLab server")
        if endpoint.scheme == "http" and not (loopback or allow_insecure_http):
            raise ValueError("Use HTTPS or explicitly enable allow_insecure_http for a trusted network")
        port = endpoint.port
        if port == 0:
            raise ValueError("Expected a nonzero server port")
        self._base = base_url.rstrip("/") + "/api/v1"
        self._token = os.environ.get("IDLAB_TOKEN") if token is None else token
        self._campaign_token = None
        self._timeout = timeout
        self._allow_insecure_http = allow_insecure_http
        self._opener = build_opener(ProxyHandler({}), _NoRedirect())

    def devices(self) -> dict[str, Board]:
        """Return the connected boards indexed by their logical name."""
        payload = self._request("/devices")
        if not isinstance(payload, dict):
            raise IDLabError("Invalid device list")
        return {name: self._board(name, description) for name, description in payload.items()}

    def identify(self, name: str) -> Board:
        """Retrieve the agent's registered identity for a named board."""
        return self._board(name, self._request(_board_path(name)))

    def list_campaigns(self, **filters) -> dict:
        """Search campaigns using the API filter names."""
        return self._request("/campaigns?" + urlencode(filters, doseq=True))

    def create_campaign(self, name: str, *, metadata: dict | None = None) -> dict:
        payload = {"name": name}
        if metadata is not None:
            payload["metadata"] = metadata
        return self._request("/campaigns", payload)

    def get_campaign(self, campaign_id: str) -> dict:
        return self._request(_campaign_path(campaign_id))

    def update_campaign(self, campaign_id: str, *, name: str | None = None, metadata: dict | None = None) -> dict:
        payload = {}
        if name is not None:
            payload["name"] = name
        if metadata is not None:
            payload["metadata"] = metadata
        return self._request(_campaign_path(campaign_id), payload, method="PATCH")

    def finish_campaign(self, campaign_id: str, verdict: str) -> dict:
        return self._request(_campaign_path(campaign_id) + "/finish", {"verdict": verdict})

    def abort_campaign(self, campaign_id: str, reason: str) -> dict:
        return self._request(_campaign_path(campaign_id) + "/abort", {"reason": reason})

    def campaign_operations(self, campaign_id: str, *, limit: int = 25, offset: int = 0) -> dict:
        return self._request(_campaign_path(campaign_id) + "/operations?" + urlencode({"limit": limit, "offset": offset}))

    @contextmanager
    def control(self, name: str, token: str):
        """Hold exclusive control of a board while this context is open."""
        path = _board_path(name)
        url = "ws" + self._base[4:] + path + "/control/connect"
        try:
            socket = connect(url, additional_headers={"Authorization": f"Bearer {token}"},
                             open_timeout=self._timeout, close_timeout=3, proxy=None)
        except InvalidStatus as error:
            try:
                payload = json.loads(bytes(error.response.body or b"")[:4096])
                code = payload.get("error") if isinstance(payload, dict) else None
            except (ValueError, TypeError):
                code = None
            if not isinstance(code, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", code):
                code = "control_connection_refused"
            raise IDLabHTTPError(error.response.status_code, code) from None
        except (OSError, WebSocketException) as error:
            raise IDLabError("Unable to open an IDLab control session") from error
        with socket:
            try:
                session = json.loads(socket.recv(timeout=self._timeout))
                credential = session["session"]
                generation = session["generation"]
            except ConnectionClosed as error:
                if error.rcvd and error.rcvd.code == 1008 and error.rcvd.reason in {
                    "control_stopped", "control_revoked", "device_session_changed",
                }:
                    raise IDLabHTTPError(403 if error.rcvd.reason != "device_session_changed" else 409,
                                         error.rcvd.reason) from None
                raise IDLabError("Invalid IDLab control session") from error
            except (KeyError, TypeError, ValueError, TimeoutError) as error:
                raise IDLabError("Invalid IDLab control session") from error
            client = IDLabClient(self._base.removesuffix("/api/v1"), token=credential, timeout=self._timeout,
                                 allow_insecure_http=self._allow_insecure_http)
            client._campaign_token = self._token
            board = client.identify(name)
            if board.generation != generation:
                raise IDLabHTTPError(409, "device_session_changed")
            yield board

    def _board(self, name, payload):
        try:
            generation = payload["generation"]
            capabilities = payload["capabilities"]
            if not isinstance(generation, str) or not generation or not isinstance(capabilities, list):
                raise ValueError
            return Board(name, generation, payload["chip"], payload["mac"], payload["flash_size"],
                         payload["transport"], payload["loader"], tuple(capabilities), self)
        except (KeyError, TypeError, ValueError) as error:
            raise IDLabError("Invalid board identity") from error

    def _request(self, path, arguments=None, *, expected_bytes=None, timeout=None, method=None):
        headers = {"X-IDLab-Client": "python"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        body = None
        if arguments is not None:
            headers["Content-Type"] = "application/json"
            if self._campaign_token and "campaign_id" in arguments:
                headers["X-IDLab-API-Authorization"] = f"Bearer {self._campaign_token}"
            body = json.dumps(arguments).encode("utf-8")
        request = Request(self._base + path, data=body, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=self._timeout if timeout is None else timeout) as response:
                if expected_bytes is None:
                    return json.load(response)
                if response.headers.get_content_type() != "application/octet-stream":
                    raise IDLabError("Expected binary flash data")
                data = response.read(expected_bytes + 1)
                if len(data) != expected_bytes:
                    raise IDLabError("Flash read size differs from the requested size")
                return data
        except HTTPError as error:
            with error:
                try:
                    payload = json.loads(error.read(4096))
                    code = payload.get("error") if isinstance(payload, dict) else None
                except (ValueError, OSError, http.client.HTTPException):
                    code = None
            raise IDLabHTTPError(error.code, code if isinstance(code, str) else "http_error") from None
        except (OSError, ValueError, http.client.HTTPException) as error:
            raise IDLabError("IDLab request failed or returned an invalid response") from error
