import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTags, formatTags } from '../static/tag-utils.js';

test('hashtags are separated and deduplicated', () => {
  assert.deepEqual(parseTags('#Keychain #fanart #keychain'), ['keychain', 'fanart']);
  assert.deepEqual(parseTags('#厨师 #挂件'), ['厨师', '挂件']);
});
test('legacy commas and saved tags remain supported', () => {
  assert.deepEqual(parseTags('keychain, line art, illustration'), ['keychain', 'line art', 'illustration']);
  assert.equal(formatTags(['keychain', 'line art', '#Fanart']), '#keychain #line-art #fanart');
});
test('empty separators and limits are handled', () => {
  assert.deepEqual(parseTags('### , #'), []);
  assert.equal(parseTags(Array.from({length: 12}, (_, i) => 'tag' + i)).length, 8);
});
