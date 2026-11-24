"""Report API actions in progress to the workbench."""

import asyncio

from aiohttp import web


class ApiActivity:
    def __init__(self):
        self.pending = 0
        self.observers = {}

    def notify(self):
        for queue in self.observers.values():
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(bool(self.pending))

    @web.middleware
    async def track(self, request, handler):
        explicit_read = request.method == "GET" and request.headers.get("X-IDLab-Action") == "1"
        action = request.method in {"POST", "PATCH", "PUT", "DELETE"} or explicit_read
        if (not action or not request.path.startswith("/api/v1/")
                or request.path == "/api/v1/activity" or request.headers.get("Upgrade")):
            return await handler(request)
        self.pending += 1
        if self.pending == 1:
            self.notify()
        try:
            return await handler(request)
        finally:
            self.pending -= 1
            if not self.pending:
                self.notify()

    async def observe(self, request):
        if request.headers.get("Origin") != f"http://{request.host}":
            raise web.HTTPForbidden()
        socket = web.WebSocketResponse(heartbeat=20)
        await socket.prepare(request)
        queue = asyncio.Queue(maxsize=2)
        self.observers[socket] = queue
        queue.put_nowait(bool(self.pending))

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
