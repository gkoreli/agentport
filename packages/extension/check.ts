import assert from 'node:assert/strict';

import { mintId, readPageOutbound } from './src/bridge.js';

const promptId = mintId('p_');
assert.match(promptId, /^p_[0-9a-f]{24}$/);
assert.deepEqual(
  readPageOutbound({ t: 'prompt', rid: 'r_test', ref: 's_test', promptId, text: 'hello' }),
  { t: 'prompt', rid: 'r_test', ref: 's_test', promptId, text: 'hello' },
);
assert.equal(
  readPageOutbound({ t: 'prompt', rid: 'r_test', ref: 's_test', promptId: 'predictable', text: 'hello' }),
  undefined,
);
assert.equal(readPageOutbound({ t: 'prompt.cancel', ref: 's_test', promptId: 'predictable' }), undefined);

console.log('extension boundary check passed');
