import assert from 'node:assert/strict';
import { thunderTier, thunderChargePower, thunderPreviewSample } from './public/thunder-profile.js';

assert.equal(thunderTier(.2), 'small');
assert.equal(thunderTier(.399), 'small');
assert.equal(thunderTier(.4), 'medium');
assert.equal(thunderTier(.999), 'medium');
assert.equal(thunderTier(1), 'large');
assert.equal(thunderChargePower(0), .2);
assert.equal(thunderChargePower(.399), .2);
assert.equal(thunderChargePower(.4), .65);
assert.equal(thunderChargePower(.999), .65);
assert.equal(thunderChargePower(1), 1);
assert.equal(thunderPreviewSample('small', .2).flying, true);
assert.equal(thunderPreviewSample('medium', .46).flying, false);
assert.ok(thunderPreviewSample('large', 0).impactAge < 0);
assert.equal(thunderPreviewSample('large', .12).impactAge, 0);
assert.throws(() => thunderPreviewSample('arc', 0), RangeError);

console.log('thunder tiers / preview timeline ok');
