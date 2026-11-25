"""Report API actions in progress to the workbench."""

import asyncio

from aiohttp import web


class ApiActivity:
    def __init__(self, scope):
        self.scope = scope
        self.pending = {}
        self.observers = {}

    def notify(self, scope, active):
        for owner, queue in self.observers.values():
            if owner != scope:
                continue
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(active)

    @web.middleware
    async def track(self, request, handler):
        explicit_read = request.method == "GET" and request.headers.get("X-IDLab-Action") == "1"
        action = request.method in {"POST", "PATCH", "PUT", "DELETE"} or explicit_read
        if (not action or not request.path.startswith("/api/v1/")
                or request.path == "/api/v1/activity" or request.headers.get("Upgrade")):
            return await handler(request)
        scope = self.scope(request)
        self.pending[scope] = self.pending.get(scope, 0) + 1
        if self.pending[scope] == 1:
            self.notify(scope, True)
        try:
            return await handler(request)
        finally:
            self.pending[scope] -= 1
            if not self.pending[scope]:
                del self.pending[scope]
                self.notify(scope, False)

    async def observe(self, request):
        scope = self.scope(request)
        socket = web.WebSocketResponse(heartbeat=20)
        await socket.prepare(request)
        queue = asyncio.Queue(maxsize=2)
        self.observers[socket] = (scope, queue)
        queue.put_nowait(bool(self.pending.get(scope)))

        async def send():
            while not socket.closed:
                await socket.send_json({"active": await queue.get()})

        sender = asyncio.create_task(send())
        try:
            async for _ in socket:
                pass
        finally:
            self.observers.pop(socket)
            sender.cancel()
            await asyncio.gather(sender, return_exceptions=True)
        return socket

    async def close(self, app):
        await asyncio.gather(*(socket.close(code=1001) for socket in tuple(self.observers)))
