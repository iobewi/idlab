import assert from 'node:assert/strict';
import test from 'node:test';
import {usbReconnect} from '../../web/usb-reconnect.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  let connects = 0;
  let registered = true;
  const card = {mode: 'console', busy: false, requesting: false,
    async disconnect() { this.mode = 'disconnected'; }};
  const recovery = usbReconnect(card, {
    connect: async () => { connects++; card.mode = 'console'; },
    report: error => { throw error; },
    isRegistered: () => registered,
  });
  recovery.enable();
  return {card, recovery, count: () => connects, remove: () => { registered = false; }};
}

test('physical return reconnects once, only after disconnect', async () => {
  const {recovery, count} = fixture();
  recovery.added();
  await tick();
  assert.equal(count(), 0);
  await recovery.removed();
  recovery.added();
  recovery.added();
  await tick();
  assert.equal(count(), 1);
});

test('manual disconnect disables automatic reconnect', async () => {
  const {recovery, count} = fixture();
  recovery.disable();
  await recovery.removed();
  recovery.added();
  await tick();
  assert.equal(count(), 0);
});

test('physical return waits for old operation cleanup', async () => {
  const {card, recovery, count} = fixture();
  card.busy = true;
  await recovery.removed();
  recovery.added();
  await tick();
  assert.equal(count(), 0);
  card.busy = false;
  recovery.changed();
  await tick();
  assert.equal(count(), 1);
});

test('removed card cannot be reconnected by a queued event', async () => {
  const {recovery, count, remove} = fixture();
  await recovery.removed();
  recovery.added();
  remove();
  await tick();
  assert.equal(count(), 0);
});
