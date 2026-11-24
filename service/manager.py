"""Manage only the IDLab HTTP child process."""

import asyncio
import hmac
import os
from pathlib import Path
import sys

from aiohttp import ClientError, ClientSession, ClientTimeout, web

SERVER = Path(__file__).resolve().parents[1] / "core" / "server.py"


class HTTPService:
    def __init__(self, port=8080):
        self.port = port
        self.process = None

    async def start(self):
        if self.process is not None and self.process.returncode is None:
            return
        env = os.environ.copy()
        env.pop("IDLAB_MANAGER_TOKEN", None)
        env["IDLAB_PORT"] = str(self.port)
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
                    async with session.get(f"http://127.0.0.1:{self.port}/health", allow_redirects=False) as response:
                        # Verify that the HTTP listener belongs to the process we started.
                        ready = response.status == 200 and response.headers.get("X-IDLab-Pid") == str(process.pid)
            except (ClientError, TimeoutError):
                pass
        if process.returncode is not None:
            return {"state": "exited", "ready": False, "exit_code": process.returncode}
        return {"state": "running", "ready": ready}


def create_app(*, token, port=8081, service=None):
    if not token:
        raise ValueError("Set IDLAB_MANAGER_TOKEN before starting the management API")

    service = HTTPService() if service is None else service
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    authorization = f"Bearer {token}".encode()
    lock = asyncio.Lock()

    def problem(status, code):
        return web.json_response({"error": code}, status=status)

    @web.middleware
    async def authenticate(request, handler):
        if request.host not in hosts or "Origin" in request.headers:
            return problem(403, "local_script_required")
        supplied = request.headers.get("Authorization", "").encode()
        if not hmac.compare_digest(supplied, authorization):
            return problem(401, "authentication_required")
        return await handler(request)

    async def dispatch(request):
        action = request.match_info["action"]
        if request.can_read_body or request.query:
            return problem(400, "unexpected_arguments")
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

    async def stop_service(app):
        async with lock:
            await service.stop()

    app = web.Application(middlewares=[authenticate])
    app.router.add_get("/v1/{action:status}", dispatch)
    app.router.add_post("/v1/{action:start|stop|restart}", dispatch)
    app.on_cleanup.append(stop_service)
    return app


if __name__ == "__main__":
    manager_token = os.environ.get("IDLAB_MANAGER_TOKEN")
    if not manager_token:
        raise SystemExit("Set IDLAB_MANAGER_TOKEN before starting the management API")
    if manager_token == os.environ.get("IDLAB_TOKEN"):
        raise SystemExit("IDLAB_MANAGER_TOKEN must differ from IDLAB_TOKEN")
    forwarded = os.environ.get("IDLAB_LOOPBACK_FORWARDED") == "1"
    web.run_app(create_app(token=manager_token), host="0.0.0.0" if forwarded else "127.0.0.1", port=8081)
