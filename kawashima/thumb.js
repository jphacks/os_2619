// Small picture of the display for admin.html, made off the main thread. drawImage of the WebGL canvas + toBlob on the page
// read the frame back synchronously: 5-15 ms every time, 100-280 ms when it waited on a busy GPU. Here the page only asks for
// a resized GPU copy (createImageBitmap), and thumbworker.js encodes the JPEG and posts it on the BroadcastChannel itself.

/**
 * createThumbSender(canvas, { id, channel, width, every, quality }) -> send(aspect). Call send right after a render, in the
 * same task (the WebGL drawing buffer is only there until the frame is shown). At most one picture in flight, `every` s apart.
 * Posts { type: 'thumb', id, blob } like before.
 */
export function createThumbSender(canvas, { id, channel = 'bou-battle', width = 480, every = .5, quality = .7 } = {}) {
  let worker = null, at = -1e9, busy = false, bc = null;
  let off = typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined' && typeof Worker !== 'undefined';
  let thumb = null, tctx = null; // main-thread fallback (old path)
  return function send(aspect = canvas.width / canvas.height) {
    const t = performance.now() / 1000;
    if (busy || t - at < every) return;
    at = t; busy = true;
    const w = width, h = Math.round(width / aspect);
    if (!off) return fallback(w, h);
    createImageBitmap(canvas, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' }).then(bmp => {
      if (!worker) {
        worker = new Worker(new URL('./thumbworker.js', import.meta.url), { type: 'module' });
        worker.onmessage = () => { busy = false; };
        worker.onerror = e => { e.preventDefault?.(); worker.terminate(); worker = null; off = false; busy = false; }; // main-thread path from now on
      }
      worker.postMessage({ bmp, id, channel, quality }, [bmp]);
    }, () => { off = false; busy = false; });
  };
  function fallback(w, h) {
    thumb ??= document.createElement('canvas'); tctx ??= thumb.getContext('2d'); bc ??= new BroadcastChannel(channel);
    thumb.width = w; thumb.height = h; tctx.drawImage(canvas, 0, 0, w, h);
    thumb.toBlob(b => { busy = false; if (b) bc.postMessage({ type: 'thumb', id, blob: b }); }, 'image/jpeg', quality);
  }
}
