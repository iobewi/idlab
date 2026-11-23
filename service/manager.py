"""Loopback management API for the dedicated IDLab Compose service."""

import asyncio
import hmac
import json
import os
from pathlib import Path

from aiohttp import web

ROOT = Path(__file__).resolve().parents[1]
COMMANDS = {
    "status": ("ps", "--all", "--format", "json", "core"),
    "start": ("up", "--detach", "--no-build", "--no-recreate", "core"),
    "stop": ("stop", "core"),
    "restart": ("restart", "core"),
}


class ComposeError(Exception):
    pass


async def run_compose(args):
    try:
        process = await asyncio.create_subprocess_exec(
            "docker", "compose", "--project-name", "idlab",
            "--file", str(ROOT / "compose.yaml"), *args,
            cwd=ROOT, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError as error:
        raise ComposeError from error
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=45)
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await process.wait()
        raise
    if process.returncode:
        raise ComposeError
    return stdout


def service_status(output):
    try:
        raw = output.strip()
        if raw.startswith(b"["):
            rows = json.loads(raw)
        else:
            rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
        if not rows:
            return {"state": "absent", "health": None, "ready": False}
        if len(rows) != 1 or not isinstance(rows[0], dict):
            raise ValueError
        state = rows[0]["State"]
        health = rows[0].get("Health") or None
        if not isinstance(state, str) or (health is not None and not isinstance(health, str)):
            raise ValueError
    except (KeyError, TypeError, ValueError) as error:
        raise ComposeError from error
    return {"state": state, "health": health, "ready": state == "running" and health == "healthy"}


def create_app(*, token, port=8081, compose=run_compose):
    if not token:
        raise ValueError("Set IDLAB_MANAGER_TOKEN before starting the management API")

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
        if action == "status" and request.method != "GET":
            raise web.HTTPMethodNotAllowed(request.method, ["GET"])
        if action != "status" and request.method != "POST":
            raise web.HTTPMethodNotAllowed(request.method, ["POST"])
        if request.can_read_body or request.query:
            return problem(400, "unexpected_arguments")
        if lock.locked():
            return problem(409, "manager_busy")

        async with lock:
            try:
                output = await compose(COMMANDS[action])
                if action == "status":
                    return web.json_response(service_status(output), headers={"Cache-Control": "no-store"})
            except ComposeError:
                return problem(502, "compose_failed")
            except TimeoutError:
                return problem(504, "compose_timeout")
        return web.json_response({"action": action})

    app = web.Application(middlewares=[authenticate])
    app.router.add_route("*", "/v1/{action:status|start|stop|restart}", dispatch)
    return app


if __name__ == "__main__":
    manager_token = os.environ.get("IDLAB_MANAGER_TOKEN")
    if not manager_token:
        raise SystemExit("Set IDLAB_MANAGER_TOKEN before starting the management API")
    if manager_token == os.environ.get("IDLAB_TOKEN"):
        raise SystemExit("IDLAB_MANAGER_TOKEN must differ from IDLAB_TOKEN")
    web.run_app(create_app(token=manager_token), host="127.0.0.1", port=8081)
