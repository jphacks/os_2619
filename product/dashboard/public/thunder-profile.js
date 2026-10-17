export const THUNDER_TIERS = ['small', 'medium', 'large'];

export function thunderTier(power) {
  return power >= 1 ? 'large' : power >= .4 ? 'medium' : 'small';
}

export function thunderChargePower(level) {
  return level >= 1 ? 1 : level >= .4 ? .65 : .2;
}

export const THUNDER_PREVIEW_TRAVEL = .46;
export const THUNDER_STRIKE_DELAY = .12;
export const THUNDER_LIFETIME = { small: .48, medium: .68, large: 1.25 };

export function thunderPreviewSample(tier, age) {
  if (!THUNDER_TIERS.includes(tier)) throw new RangeError('Unknown thunder tier: ' + tier);
  const at = Math.max(0, Number.isFinite(age) ? age : 0);
  const delay = tier === 'large' ? THUNDER_STRIKE_DELAY : THUNDER_PREVIEW_TRAVEL;
  return {
    flying: tier !== 'large' && at < THUNDER_PREVIEW_TRAVEL,
    progress: tier === 'large' ? 1 : Math.min(1, at / THUNDER_PREVIEW_TRAVEL),
    impactAge: at - delay,
    alive: at <= delay + THUNDER_LIFETIME[tier],
  };
}
