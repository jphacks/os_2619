// Visual tiers are discrete. Damage / collision belong to game.js.
export const FIRE_TIERS = ['small', 'medium', 'large'];
export const fireTier = power => power >= 1 ? 'large' : power >= .4 ? 'medium' : 'small';
export const fireChargePower = level => level >= 1 ? 1 : level >= .4 ? .65 : .2;
export const FIRE_PREVIEW_TRAVEL = .46;
export const FIRE_LIFETIME = { small: 1.65, medium: .85, large: 1.85 };
// Stateless evaluation also lets preview stepping reproduce exactly the same point in time.
export function firePreviewSample(tier, age) {
  if (!FIRE_TIERS.includes(tier)) throw new Error('Unknown fire tier: ' + tier);
  const flight = tier === 'large' ? 0 : FIRE_PREVIEW_TRAVEL;
  return { flying: age >= 0 && age < flight, progress: Math.max(0, Math.min(1, age / (flight || 1))),
    impactAge: age - flight, alive: age >= 0 && age < flight + FIRE_LIFETIME[tier] };
}
