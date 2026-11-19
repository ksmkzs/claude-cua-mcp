import test from 'node:test';
import assert from 'node:assert/strict';
import {judge} from '../scripts/check_app.mjs';

const tools = ['js', 'js_reset', 'turn_ended'];
const good = {tools, text: 'CHECK {"apps":14,"errors":[]}', error: null, stderr: ''};
const doc = (text, stderr = '') => ({tools, text, error: null, stderr});

test('a working app passes every check, with and without the profile', () => {
  const plain = judge({inventory: good, profileInstalled: false});
  assert.deepEqual(plain.map(c => c.ok), [true, true, true]);
  const profiled = judge({inventory: good, profileInstalled: true,
    profiled: doc('Use cua_repl. getState getAXState > Context profile: short'), stock: doc('x'.repeat(500))});
  assert.equal(profiled.length, 6);
  assert.ok(profiled.every(c => c.ok));
});

test('each thing an app update can break is named', () => {
  const failed = judge({inventory: {...good, text: 'CHECK {"apps":0,"errors":["Native apps: Error: Sky Computer Use native pipe startup failed"]}'}, profileInstalled: false});
  assert.deepEqual(failed.map(c => c.ok), [true, true, false]);
  assert.match(failed[2].detail, /native pipe startup failed/);
  const moreTools = judge({inventory: {...good, tools: ['js', 'js_new', 'js_reset', 'turn_ended']}, profileInstalled: false});
  assert.equal(moreTools[1].ok, false);
  const layoutChanged = judge({inventory: good, profileInstalled: true,                    // the filter no longer recognises the text
    profiled: doc('y'.repeat(500) + ' getState getAXState cua_repl'), stock: doc('y'.repeat(500) + ' getState getAXState cua_repl')});
  assert.deepEqual(layoutChanged.map(c => c.ok), [true, true, true, true, false, true]);
  const notLoaded = judge({inventory: good, profileInstalled: true,
    profiled: doc('short Context profile getState getAXState cua_repl', '[cua-proxy] filter docs.mjs was not loaded: boom'), stock: doc('x'.repeat(500))});
  assert.equal(notLoaded[3].ok, false);
});
