import assert from 'node:assert/strict';
import { fireTier, fireChargePower, firePreviewSample, FIRE_LIFETIME } from './public/fire-profile.js';

// The exact 2 s / 5 s boundaries select different visuals, not a continuously enlarged fireball.
for (const [seconds, tier] of [[0,'small'],[1.999,'small'],[2,'medium'],[4.999,'medium'],[5,'large'],[8,'large']]) {
  assert.equal(fireTier(fireChargePower(Math.min(1,seconds/5))),tier);
}
assert.equal(firePreviewSample('small',.2).flying,true);
assert.equal(firePreviewSample('medium',.46).flying,false);
assert.equal(firePreviewSample('medium',.46).impactAge,0);
assert.equal(firePreviewSample('large',0).flying,false); // explosion starts at the target, no giant fireball flight
for (const tier of ['small','medium','large']) {
  const age=.7, first=firePreviewSample(tier,age);
  firePreviewSample(tier,1.3); // seeking elsewhere must not affect the frozen frame
  assert.deepEqual(firePreviewSample(tier,age),first);
  assert.equal(firePreviewSample(tier,10+FIRE_LIFETIME[tier]).alive,false);
}
assert.throws(()=>firePreviewSample('unknown',0));
console.log('fire tiers / preview timeline ok');
