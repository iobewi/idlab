"""Manage only the IDLab HTTP child process."""

import asyncio
import hmac
import os
import re
from pathlib import Path
import sys

from aiohttp import ClientError, ClientSession, ClientTimeout, DummyCookieJar, WSServerHandshakeError, WSMsgType, web

SERVER = Path(__file__).resolve().with_name("server.py")
WS_LIMIT = 4 * 1024 * 1024 + 1
HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection",
}


def proxy_headers(headers):
    nominated = {
        name.strip().lower()
        for value in headers.getall("Connection", [])
        for name in value.split(",")
    }
    return [
        (key, value) for key, value in headers.items()
        if key.lower() not in HOP_HEADERS | nominated and not key.lower().startswith("sec-websocket-")
    ]


async def relay_socket(source, target):
    while True:
        message = await source.receive()
        if message.type == WSMsgType.TEXT:
            await target.send_str(message.data)
        elif message.type == WSMsgType.BINARY:
            await target.send_bytes(message.data)
        else:
            return message


async def bridge_socket(browser, agent):
    downstream = asyncio.create_task(relay_socket(agent, browser))
    tasks = {asyncio.create_task(relay_socket(browser, agent)), downstream}
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        code = agent.close_code if agent.close_code in {1000, 1001, 1008, 1011} else 1001
        reason = b""
        if downstream.done() and not downstream.cancelled() and downstream.exception() is None:
            message = downstream.result()
            if message is not None and message.type == WSMsgType.CLOSE and message.data == 1008:
                code = 1008
                if message.extra in {"control_stopped", "control_revoked", "device_session_changed"}:
                    reason = message.extra.encode()
        await browser.close(code=code, message=reason)


class HTTPService:
    def __init__(self, port=8082, public_port=8080):
        self.port = port
        self.public_port = public_port
        self.process = None

    async def start(self):
        if self.process is not None and self.process.returncode is None:
            return
        env = os.environ.copy()
        env.pop("IDLAB_MANAGER_TOKEN", None)
        env["IDLAB_PORT"] = str(self.port)
        env["IDLAB_PUBLIC_PORT"] = str(self.public_port)
        # The public listener handles Docker networking. The backend stays private.
        env.pop("IDLAB_LOOPBACK_FORWARDED", None)
        self.process = await asyncio.create_subprocess_exec(sys.executable, str(SERVER), env=env)

    async def stop(self):
        process = self.process
        if process is None:
            return
        if process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), timeout=6)
            except TimeoutError:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                await process.wait()
        self.process = None

    async def status(self):
        process = self.process
        if process is None:
            return {"state": "stopped", "ready": False}
        ready = False
        if process.returncode is None:
            try:
                async with ClientSession(timeout=ClientTimeout(total=1)) as session:
                    async with session.get(
                        f"http://127.0.0.1:{self.port}/health",
                        headers={"Host": f"127.0.0.1:{self.public_port}"}, allow_redirects=False,
                    ) as response:
                        # Verify that the HTTP listener belongs to the process we started.
                        ready = response.status == 200 and response.headers.get("X-IDLab-Pid") == str(process.pid)
            except (ClientError, TimeoutError):
                pass
        if process.returncode is not None:
            return {"state": "exited", "ready": False, "exit_code": process.returncode}
        return {"state": "running", "ready": ready}


def create_app(*, token, port=8080, service=None):
    if not token:
        raise ValueError("Set IDLAB_MANAGER_TOKEN before starting the management API")

    service = HTTPService(public_port=port) if service is None else service
    authorization = f"Bearer {token}".encode()
    lock = asyncio.Lock()
    stopping = False

    def problem(status, code):
        return web.json_response({"error": code}, status=status)

    @web.middleware
    async def authenticate(request, handler):
        if not request.path.startswith("/api/v1/httpd/"):
            return await handler(request)
        if "Origin" in request.headers:
            return problem(403, "local_script_required")
        supplied = request.headers.get("Authorization", "").encode()
        if not hmac.compare_digest(supplied, authorization):
            return problem(401, "authentication_required")
        return await handler(request)

    async def dispatch(request):
        action = request.match_info["action"]
        allowed = ["GET", "HEAD"] if action == "status" else ["POST"]
        if request.method not in allowed:
            raise web.HTTPMethodNotAllowed(request.method, allowed)
        if request.can_read_body or request.query:
            return problem(400, "unexpected_arguments")
        if stopping:
            return problem(503, "manager_stopping")
        if lock.locked():
            return problem(409, "manager_busy")

        async with lock:
            if action == "status":
                return web.json_response(await service.status(), headers={"Cache-Control": "no-store"})
            if action in {"stop", "restart"}:
                await service.stop()
            if action in {"start", "restart"}:
                try:
                    await service.start()
                except OSError:
                    return problem(502, "http_start_failed")
        return web.json_response({"action": action})

    async def relay(request):
        if request.path.startswith("/api/v1/httpd/"):
            raise web.HTTPNotFound()
        if stopping or service.process is None or service.process.returncode is not None:
            return problem(503, "idlab_http_unavailable")

        upstream = f"http://127.0.0.1:{service.port}{request.raw_path}"
        headers = proxy_headers(request.headers)
        if request.headers.get("Upgrade", "").lower() == "websocket" and (
                request.path in {"/agent", "/api/v1/activity"} or request.path.endswith("/control/connect")):
            try:
                async with request.app[UPSTREAM].ws_connect(
                    upstream, headers=headers, max_msg_size=WS_LIMIT, heartbeat=20,
                ) as agent:
                    browser = web.WebSocketResponse(max_msg_size=WS_LIMIT, heartbeat=20)
                    await browser.prepare(request)
                    await bridge_socket(browser, agent)
                    return browser
            except WSServerHandshakeError as error:
                # aiohttp discards the rejected handshake body; the backend supplies
                # the machine-readable error in a response header instead.
                code = error.headers.get("X-IDLab-Error", "") if error.headers else ""
                if not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", code):
                    code = "agent_connection_refused"
                return problem(error.status if 400 <= error.status <= 599 else 502, code)
            except TimeoutError:
                return problem(504, "idlab_http_timeout")
            except ClientError:
                return problem(503, "idlab_http_unavailable")

        try:
            program = (request.method == "POST" and request.path.startswith("/api/v1/devices/")
                       and request.path.endswith("/flash/program"))
            if program:
                # The authenticated handler bounds the upload. Avoid buffering it twice.
                body = request.content.iter_chunked(64 * 1024)
            else:
                body = await request.read() if request.can_read_body else None
            timeout = ({"timeout": ClientTimeout(total=None, connect=2)}
                       if request.path.endswith(("/flash/read", "/flash/program", "/command")) else {})
            async with request.app[UPSTREAM].request(
                request.method, upstream, headers=headers, data=body, allow_redirects=False, **timeout,
            ) as response:
                return web.Response(
                    status=response.status, headers=proxy_headers(response.headers),
                    body=await response.read(),
                )
        except TimeoutError:
            return problem(504, "idlab_http_timeout")
        except ClientError:
            return problem(503, "idlab_http_unavailable")

    async def upstream_session(app):
        async with ClientSession(
            auto_decompress=False, cookie_jar=DummyCookieJar(),
            timeout=ClientTimeout(total=630, connect=2),
        ) as session:
            app[UPSTREAM] = session
            yield

    async def stop_service(app):
        nonlocal stopping
        stopping = True
        async with lock:
            await service.stop()

    UPSTREAM = web.AppKey("upstream", ClientSession)
    app = web.Application(middlewares=[authenticate], client_max_size=4096)
    # Reserve the management namespace. Ordinary IDLab HTTP and WebSocket stay on this port.
    app.router.add_route("*", "/api/v1/httpd/{action:status|start|stop|restart}", dispatch)
    app.router.add_route("*", "/{path:.*}", relay)
    app.on_shutdown.append(stop_service)
    app.cleanup_ctx.append(upstream_session)
    return app


if __name__ == "__main__":
    manager_token = os.environ.get("IDLAB_MANAGER_TOKEN")
    if not manager_token:
        raise SystemExit("Set IDLAB_MANAGER_TOKEN before starting the management API")
    if manager_token == os.environ.get("IDLAB_TOKEN"):
        raise SystemExit("IDLAB_MANAGER_TOKEN must differ from IDLAB_TOKEN")
    forwarded = os.environ.get("IDLAB_LOOPBACK_FORWARDED") == "1"
    web.run_app(create_app(token=manager_token), host="0.0.0.0" if forwarded else "127.0.0.1", port=8080)
