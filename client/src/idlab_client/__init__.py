"""Python connector for the IDLab HTTP API."""

from dataclasses import dataclass, field
from contextlib import contextmanager
import http.client
import json
import os
import re
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from websockets.exceptions import ConnectionClosed, InvalidStatus, WebSocketException
from websockets.sync.client import connect

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


@dataclass(frozen=True, slots=True)
class Board:
    """Snapshot of an identified board, bound to one server generation."""

    name: str
    generation: str
    chip: str
    mac: str
    flash_size: int | None
    transport: str
    loader: str
    capabilities: tuple[str, ...]
    _client: "IDLabClient" = field(repr=False, compare=False)

    def read_flash(self, address: int, size: int) -> bytes:
        """Read exactly size bytes using this board's current session."""
        if type(address) is not int or address < 0 or type(size) is not int or size <= 0:
            raise ValueError("Flash address and size must be integers within a valid range")
        maximum = 4 * 1024 * 1024
        if self.flash_size is not None and size > self.flash_size - address:
            raise ValueError("Flash range exceeds the detected capacity")
        return b"".join(
            self._client._request(
                _board_path(self.name) + "/flash/read",
                {"generation": self.generation, "address": address + offset, "size": min(maximum, size - offset)},
                expected_bytes=min(maximum, size - offset),
            )
            for offset in range(0, size, maximum)
        )


class IDLabClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8080", *, token: str | None = None,
                 timeout: float = 630):
        endpoint = urlsplit(base_url)
        if (endpoint.scheme != "http" or endpoint.hostname not in {"localhost", "127.0.0.1"}
                or endpoint.username is not None or endpoint.password is not None
                or endpoint.path not in {"", "/"} or endpoint.query or endpoint.fragment):
            raise ValueError("Expected the loopback HTTP address of the IDLab server")
        port = endpoint.port
        if port == 0:
            raise ValueError("Expected a nonzero server port")
        self._base = base_url.rstrip("/") + "/api/v1"
        self._token = os.environ.get("IDLAB_TOKEN") if token is None else token
        self._timeout = timeout
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

    @contextmanager
    def control(self, name: str, token: str):
        """Hold exclusive control of a board while this context is open."""
        path = _board_path(name)
        url = "ws" + self._base[4:] + path + "/control/connect"
        try:
            socket = connect(url, additional_headers={"Authorization": f"Bearer {token}"},
                             open_timeout=self._timeout, close_timeout=3, proxy=None)
        except InvalidStatus as error:
            raise IDLabHTTPError(error.response.status_code, "control_connection_refused") from None
        except (OSError, WebSocketException) as error:
            raise IDLabError("Unable to open an IDLab control session") from error
        with socket:
            try:
                session = json.loads(socket.recv(timeout=self._timeout))
                credential = session["session"]
                generation = session["generation"]
            except (KeyError, TypeError, ValueError, TimeoutError, ConnectionClosed) as error:
                raise IDLabError("Invalid IDLab control session") from error
            client = IDLabClient(self._base.removesuffix("/api/v1"), token=credential, timeout=self._timeout)
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

    def _request(self, path, arguments=None, *, expected_bytes=None):
        headers = {"Authorization": f"Bearer {self._token}"} if self._token else {}
        body = None
        if arguments is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(arguments).encode("utf-8")
        request = Request(self._base + path, data=body, headers=headers)
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
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
