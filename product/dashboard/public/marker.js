// Which marker the four floor sheets (ids 0-3) carry: 'april' (tag36h11) or 'rune' (RuneTag, runetag.js). One choice for the whole
// product: server.mjs serves this module with its saved setting (the switch on the connection screen), phones A / B get it over /ws.
// This file is what node (tests, env MARKER) and a plain static server see.
export const MARKER = (typeof process !== 'undefined' && process.env?.MARKER === 'rune') ? 'rune' : 'april';
