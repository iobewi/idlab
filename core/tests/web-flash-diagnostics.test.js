import assert from 'node:assert/strict';
import test from 'node:test';
import { destructiveFlashMessage, operationDiagnosticDetail, campaignOperationLabel } from '../../web/flash-diagnostics.js';

test('uncertain destructive outcomes recommend authorized readback, not rewriting', () => {
  for (const flashState of ['indeterminate', 'unverified']) {
    const text = destructiveFlashMessage({code: 'serial_timeout', message: 'timeout', operation: {flashState}}, {});
    assert.match(text, /relecture autorisée/);
    assert.doesNotMatch(text, /réessayer|reprogrammer/);
  }
});

test('verification mismatch and legacy errors retain usable messages', () => {
  const messages = {flash_verification_failed: 'La relecture ne correspond pas au plan.'};
  assert.equal(destructiveFlashMessage({code: 'flash_verification_failed', operation: {flashState: 'mismatch'}}, messages),
    messages.flash_verification_failed);
  assert.equal(destructiveFlashMessage(new Error('serial_timeout'), messages), 'serial_timeout');
});

test('operation history exposes destructive error details and legacy entries remain usable', () => {
  for (const command of ['flash.read', 'flash.program', 'flash.erase', 'flash.erase.region']) {
    assert.equal(operationDiagnosticDetail({command, error: 'serial_timeout', detail: 'Diagnostic'}), 'Diagnostic');
    assert.equal(operationDiagnosticDetail({command}), null);
  }
});

test('campaign labels include diagnostic state and error without requiring new fields', () => {
  const entry = {device: 'board', command: 'flash.program', state: 'Échec', duration: '12 ms'};
  assert.equal(campaignOperationLabel(entry), 'board · flash.program · Échec · 12 ms');
  assert.equal(campaignOperationLabel({...entry, error: 'serial_timeout', flashState: 'indeterminate'}),
    'board · flash.program · Échec · 12 ms · serial_timeout · indeterminate');
});
