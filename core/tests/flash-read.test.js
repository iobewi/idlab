import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFlashVerified} from '../flash-read.js';
import {serialTransport} from '../serial-transport.js';

const digest = data => new Uint8Array(createHash('md5').update(data).digest());
function fixture(data, mutate = frames => frames) {
  let frames = [], acks = [], commands = [];
  const loader = {ESP_READ_FLASH: 0xd2, FLASH_READ_TIMEOUT: 100000,
    async checkCommand(_, opcode, payload) {
      assert.equal(frames.length, 0, 'previous digest must be consumed');
      const view = new DataView(payload.buffer);
      commands.push([opcode, ...[0,4,8,12].map(offset => view.getUint32(offset, true))]);
      frames = mutate([...Array.from({length: Math.ceil(data.length/4096)}, (_, i) =>
        data.slice(i*4096, (i+1)*4096)), digest(data)]);
      return 0;
    },
    transport: {
      async read(timeout) { assert.equal(timeout, 100000); if (!frames.length) throw Error('serial_timeout'); return frames.shift(); },
      async write(ack) { acks.push(new DataView(ack.buffer).getUint32(0, true)); },
    }};
  return {loader, acks, commands, read: (address=0, check=()=>{}) => readFlashVerified(loader,address,data.length,check,()=>{})};
}
test('four consecutive verified 1 MiB reads consume the digest without ACKing it', async () => {
  const data = Uint8Array.from({length: 1024*1024}, (_, i) => i%251);
  const f = fixture(data);
  for(let i=0;i<4;i++) assert.deepEqual(await f.read(i*data.length),data);
  assert.equal(f.acks.length,1024);
  assert.equal(f.acks.at(-1),data.length);
  assert.deepEqual(f.commands[3],[0xd2,3*data.length,data.length,4096,1024]);
});
test('short and oversized frames fail before acknowledging invalid bytes', async () => {
  for(const length of [4095,4097]) {
    const f=fixture(new Uint8Array(8192), frames => [new Uint8Array(length), ...frames.slice(1)]);
    await assert.rejects(f.read(),/incomplete_flash_read/);
    assert.deepEqual(f.acks,[]);
  }
});
test('short tail, lost data, wrong digest, missing digest and corrupt payload are rejected', async () => {
  const data=new Uint8Array(4099);
  for(const [mutate, error] of [
    [f=>[f[0],f[1].slice(0,2),f[2]], /incomplete_flash_read/],
    [f=>[f[0]], /serial_timeout/],
    [f=>f.slice(0,-1), /serial_timeout/],
    [f=>[...f.slice(0,-1),new Uint8Array(15)], /flash_read_invalid_digest/],
    [f=>[...f.slice(0,-1),new Uint8Array(16)], /flash_read_digest_mismatch/],
    [f=>{f[0][0]=1;return f;}, /flash_read_digest_mismatch/],
  ]) await assert.rejects(fixture(data,mutate).read(),error);
});
test('valid partial tail and cancellation before final digest completion', async () => {
  const data=new Uint8Array(4099);
  assert.deepEqual(await fixture(data).read(),data);
  const f=fixture(data);
  let checks=0;
  await assert.rejects(f.read(0,()=>{if(++checks===7)throw Error('operation_cancelled');}),/operation_cancelled/);
});
test('Web Serial recoverable receive errors become terminal and retain exact code', async () => {
  for(const [name,code] of [['BufferOverrunError','serial_buffer_overrun'],['FramingError','serial_framing_error'],
      ['BreakError','serial_break_error'],['ParityError','serial_parity_error']]) {
    let released=0;
    class Transport { constructor(device){this.device=device;} async connect(){} }
    const T=serialTransport(Transport,Error);
    const t=new T({readable:{getReader:()=>({async read(){throw Object.assign(Error(name),{name});},
      releaseLock(){released++;}})}});
    await t.connect(); await t.readLoop();
    await assert.rejects(t.read(100000),new RegExp(code));
    assert.equal(released,1);
  }
});

test('receive error wakes pending read, releases lock and permits clean reconnect', async () => {
  for (const [name, code] of [['BufferOverrunError','serial_buffer_overrun'],
      ['FramingError','serial_framing_error'], ['BreakError','serial_break_error'],
      ['ParityError','serial_parity_error']]) {
    let opens = 0, closes = 0, stream;
    class Transport {
      SLIP_END = 0xc0;
      SLIP_ESC = 0xdb;
      constructor(device) { this.device = device; }
      async connect() { opens++; this.device.readable = stream; }
      async disconnect() {
        if (this.device.readable.locked) await this.reader.cancel();
        assert.equal(this.device.readable.locked, false);
        this.device.readable = null;
        closes++;
      }
      appendArray(a,b) { return Uint8Array.of(...a,...b); }
    }
    let controller;
    const makeStream = () => new ReadableStream({start(c) { controller = c; }});
    const T = serialTransport(Transport, Error);
    const t = new T({});
    stream = makeStream();
    await t.connect();
    const first = t.readLoop();
    const pending = assert.rejects(t.read(100000), new RegExp(code));
    controller.error(Object.assign(Error(name), {name}));
    await pending;
    await first;
    assert.equal(stream.locked, false);
    await assert.rejects(t.write(Uint8Array.of(1)), new RegExp(code));
    await t.disconnect();
    stream = makeStream();
    await t.connect();
    assert.equal(t.readFailure, null);
    assert.equal(t.closed, false);
    assert.equal(t.buffer.length, 0);
    const second = t.readLoop();
    const read = t.read(100000);
    controller.enqueue(Uint8Array.of(0xc0,42,0xc0));
    assert.deepEqual(await read, Uint8Array.of(42));
    await t.disconnect();
    await second;
    assert.equal(stream.locked, false);
    assert.equal(opens, 2);
    assert.equal(closes, 2);
  }
});
