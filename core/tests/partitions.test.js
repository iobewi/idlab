import assert from 'node:assert/strict';
import test from 'node:test';
import {decodePartitions, PARTITION_TABLE_BYTES} from '../../web/partitions.js';

test('decodes a table with an ESP partition and a checksum marker', () => {
  const bytes = new Uint8Array(PARTITION_TABLE_BYTES).fill(255);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x50aa, true);
  bytes.set([0, 16], 2);
  view.setUint32(4, 0x20000, true);
  view.setUint32(8, 0x100000, true);
  bytes.set(new TextEncoder().encode('ota_0\0'), 12);
  view.setUint16(32, 0xebeb, true);
  const expected = [{label: 'ota_0', type: 0, subtype: 16, address: 0x20000, size: 0x100000}];
  assert.deepEqual(decodePartitions(bytes, 0x400000), expected);
  assert.throws(() => decodePartitions(bytes, 0x100000), /partition_table_invalid/);
});

test('rejects erased and non-partition data', () => {
  assert.throws(() => decodePartitions(new Uint8Array(64).fill(255), 0x400000), /partition_table_invalid/);
  assert.throws(() => decodePartitions(new Uint8Array(64), 0x400000), /partition_table_invalid/);
});
