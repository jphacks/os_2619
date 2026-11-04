// How dark the background is around a 大 shot (screen 3): dark when it leaves, lighter once it has flown far, darker still when it hits, then slowly back.
export const DIM = {
  cast: .6,     // darkness as the shot leaves
  hit: .9,      // darkness at the hit
  rise: .1,     // s, from nothing to cast
  fall: .2,     // s, from cast to nothing when the shot is gone
  back: 2,      // s, from hit back to nothing
  hold: 4,      // m flown with the cast unchanged. By distance, so the ball-speed slider does not stretch it
  perMeter: .1, // lighter by this much for each m flown past hold
};

export function createHitDim() {
  const flying = new Map(); // shot id -> { at: last position, flown: m along its path (a steered shot's path is longer than the straight line) }
  let cast = 0, hit = 0;
  return {
    shot(id, pos) { flying.set(id, { at: pos.clone(), flown: 0 }); },
    move(id, pos) { const s = flying.get(id); if (s) { s.flown += s.at.distanceTo(pos); s.at.copy(pos); } },
    end(id) { flying.delete(id); },
    hit() { hit = DIM.hit; },
    step(dt) {
      let aim = 0;
      for (const s of flying.values()) aim = Math.max(aim, DIM.cast - DIM.perMeter * Math.max(0, s.flown - DIM.hold));
      cast = cast < aim ? Math.min(aim, cast + DIM.cast / DIM.rise * dt) : Math.max(aim, cast - DIM.cast / DIM.fall * dt);
      hit = Math.max(0, hit - DIM.hit / DIM.back * dt);
    },
    get level() { return Math.max(cast, hit); }, // the darker one, never the sum: two 大 at once do not go darker than one
  };
}
