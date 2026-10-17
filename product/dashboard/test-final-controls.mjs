import assert from 'node:assert/strict';
import { finalChargeTier } from './public/final-controls.js';

assert.equal(finalChargeTier(0), 'small');
assert.equal(finalChargeTier(1.999), 'small');
assert.equal(finalChargeTier(2), 'medium');
assert.equal(finalChargeTier(4.999), 'medium');
assert.equal(finalChargeTier(5), 'large');
assert.equal(finalChargeTier(99), 'large');
console.log('final charge tiers ok: 0..<2 small / 2..<5 medium / 5+ large');
