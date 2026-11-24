import assert from 'node:assert/strict';
import test from 'node:test';
import { openSerialConsole } from '../web/serial-console.js';

test('console reads split UTF-8, writes commands and releases the port', async () => {
  let input;
  const writes = [];
  let closed = 0;
  const port = {
    readable: new ReadableStream({start(controller) { input = controller; }}),
    writable: new WritableStream({write(chunk) { writes.push(chunk); }}),
    async open(options) { assert.deepEqual(options, {baudRate: 115200}); },
    async close() {
      assert.equal(this.readable.locked, false);
      assert.equal(this.writable.locked, false);
      closed++;
    },
  };
  let text = '';
  const session = await openSerialConsole(port, 115200, chunk => { text += chunk; });
  const bytes = new TextEncoder().encode('Prêt');
  input.enqueue(bytes.slice(0, 3));
  input.enqueue(bytes.slice(3));
  await session.write('help\r\n');
  input.close();
  await session.done;
  assert.equal(text, 'Prêt');
  assert.equal(new TextDecoder().decode(writes[0]), 'help\r\n');
  await Promise.all([session.close(), session.close()]);
  assert.equal(closed, 1);
  await assert.rejects(session.write('help'), /déconnectée/);
});

test('disconnect cancels the pending serial read', async () => {
  let cancelled = false;
  const port = {
    readable: new ReadableStream({cancel() { cancelled = true; }}),
    async open() {},
    async close() { assert.ok(!this.readable.locked); },
  };
  const session = await openSerialConsole(port, 115200, () => {});
  await session.close();
  assert.equal(cancelled, true);
});

test('historical console receives raw UART data and sends literal hex bytes', async () => {
  const input = Uint8Array.of(0, 255, 13);
  const captured = [];
  const writes = [];
  let inputStream;
  const port = {
    readable: new ReadableStream({start(controller) { inputStream = controller; }}),
    writable: new WritableStream({write(chunk) { writes.push(chunk); }}),
    async open() {},
    async close() {},
  };
  const session = await openSerialConsole(port, 115200, null, bytes => captured.push(bytes));
  inputStream.enqueue(input);
  await session.write(input);
  inputStream.close();
  await session.done;
  assert.deepEqual(captured, [input]);
  assert.deepEqual(writes, [input]);
  await session.close();
});
