// stickscan.js buildStick off the page's thread (stickui.js): about a second of carving that would otherwise stop every animation
// on the dashboard (the 新しい枝 show's motes froze). In: { views: [{ img: ImageData, cam }], design }. Out: { model } or { error }.
import { buildStick } from './stickscan.js';

onmessage = e => {
  try { postMessage({ model: buildStick(e.data.views, e.data.design) }); } catch (err) { postMessage({ error: err.message }); }
};
