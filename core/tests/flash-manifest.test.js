import assert from 'node:assert/strict';
import test from 'node:test';
import {importManifest, importManifestForBoard} from '../../web/flash-manifest.js';

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

const s3 = {name: 's3.bin'};
const c6 = {name: 'c6.bin'};
const files = [s3, c6];
const manifest = {builds: [
  {chipFamily: 'ESP32-S3', parts: [{path: 's3.bin', offset: 4096}]},
  {chipFamily: 'ESP32-C6', parts: [{path: 'c6.bin', offset: 0}]},
]};

function boardFixture(chip = null) {
  let preparations = 0;
  const card = {
    identity: {generation: 'g1', chip},
    async prepareFlashSession() {
      preparations++;
      this.identity = {generation: 'g1', chip: 'esp32s3'};
      return this.identity;
    },
  };
  return {card, count: () => preparations};
}

test('known current chip selects manifest without preparing hardware', async () => {
  const {card, count} = boardFixture('esp32c6');
  assert.deepEqual(await importManifestForBoard(manifest, files, card, 'g1', () => true),
    [{file: c6, address: '0x0'}]);
  assert.equal(count(), 0);
});

test('unknown current chip prepares once and ignores historical identity', async () => {
  const {card, count} = boardFixture();
  card.lastIdentity = {generation: 'old', chip: 'esp32c6'};
  assert.deepEqual(await importManifestForBoard(manifest, files, card, 'g1', () => true),
    [{file: s3, address: '0x1000'}]);
  assert.equal(count(), 1);
  await importManifestForBoard(manifest, files, card, 'g1', () => true);
  assert.equal(count(), 1);
});

test('manifest refuses generation or selection changes during preparation', async () => {
  for (const changed of ['generation', 'selection', 'response']) {
    const {card} = boardFixture();
    let selected = true;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    card.prepareFlashSession = async () => pending;
    const importing = importManifestForBoard(manifest, files, card, 'g1', () => selected);
    if (changed === 'generation') card.identity = {generation: 'g2', chip: 'esp32s3'};
    if (changed === 'selection') selected = false;
    release({generation: changed === 'response' ? 'g2' : 'g1', chip: 'esp32s3'});
    await assert.rejects(importing, {message: changed === 'response'
      ? 'La session de la carte a changé.' : 'La carte ou sa session a changé.'});
  }
});

test('manifest refuses a stale generation before preparing hardware', async () => {
  const {card, count} = boardFixture();
  await assert.rejects(importManifestForBoard(manifest, files, card, 'old', () => true), /session a changé/);
  assert.equal(count(), 0);
});

test('parts-only manifest does not require hardware identification', async () => {
  const {card, count} = boardFixture();
  assert.deepEqual(await importManifestForBoard({parts: [{path: 's3.bin', offset: 4096}]},
    files, card, 'g1', () => true), [{file: s3, address: '0x1000'}]);
  assert.equal(count(), 0);
});

test('incompatible family is refused after preparation without another transition', async () => {
  const {card, count} = boardFixture();
  await assert.rejects(importManifestForBoard({builds: [manifest.builds[1]]}, files, card, 'g1',
    () => true), /Aucun build/);
  assert.equal(count(), 1);
  assert.equal(card.identity.chip, 'esp32s3');
});
