import assert from 'node:assert/strict';
import test from 'node:test';
import {importManifest} from '../../web/flash-manifest.js';

test('imports the selected chip build and resolves files by relative path', () => {
  const other = {name: 'image.bin', webkitRelativePath: 'firmware/other/image.bin'};
  const expected = {name: 'image.bin', webkitRelativePath: 'firmware/s3/image.bin'};
  const document = {builds: [
    {chipFamily: 'ESP32-C6', parts: [{path: 'other/image.bin', offset: 0}]},
    {chipFamily: 'ESP32-S3', parts: [{path: 's3/image.bin', offset: 4096}]},
  ]};
  assert.deepEqual(importManifest(document, [other, expected], 'esp32s3'), [{file: expected, address: '0x1000'}]);
  assert.throws(() => importManifest(document, [other, expected], 'esp32p4'), /Aucun build/);
  assert.throws(() => importManifest({parts: [{path: '../image.bin', offset: 4096}]}, [other], null), /invalide/);
});
