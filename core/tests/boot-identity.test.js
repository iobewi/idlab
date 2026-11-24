import assert from 'node:assert/strict';
import test from 'node:test';
import {BootIdentity} from '../../web/boot-identity.js';

test('extracts the S3 identity and configured flash from split boot logs', () => {
  const observed = new BootIdentity();
  assert.equal(observed.append('ESP-ROM:esp32s3-20210327\r\n'), true);
  assert.equal(observed.append('I (28) boot: chip revi'), false);
  assert.equal(observed.append('sion: v0.2\r\nI (39) boot.esp32s3: SPI Flash Size : 4'), true);
  assert.equal(observed.flashMiB, null);
  assert.equal(observed.append('MB\r'), true);
  assert.equal(observed.chip, 'esp32s3');
  assert.equal(observed.revision, 'v0.2');
  assert.equal(observed.flashMiB, 4);
});

test('uses an ESP-IDF boot tag when the ROM banner was missed', () => {
  const observed = new BootIdentity();
  assert.equal(observed.append('I (39) boot.esp32c6: SPI Flash Size : 8MB\n'), true);
  assert.equal(observed.chip, 'esp32c6');
  assert.equal(observed.flashMiB, 8);
  assert.equal(observed.revision, null);
  assert.equal(observed.append('I (39) boot.esp32c6: SPI Flash Size : 8MB\n'), false);
});

test('ignores unrelated firmware text and bounds unfinished lines', () => {
  const observed = new BootIdentity();
  assert.equal(observed.append('INFO app: SPI Flash Size : 4MB\n'), false);
  assert.equal(observed.append('x'.repeat(4096)), false);
  assert.equal(observed.tail.length, 512);
  assert.equal(observed.chip, null);
  assert.equal(observed.flashMiB, null);
});
