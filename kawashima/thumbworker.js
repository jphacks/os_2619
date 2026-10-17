// JPEG encoder for thumb.js: { bmp, id, channel, quality } in, { type: 'thumb', id, blob } out on the BroadcastChannel,
// then an empty reply so the page may send the next one.
let bc = null, cv = null, cx = null;
onmessage = async ({ data: { bmp, id, channel, quality } }) => {
  try {
    bc ??= new BroadcastChannel(channel);
    if (!cv || cv.width !== bmp.width || cv.height !== bmp.height) { cv = new OffscreenCanvas(bmp.width, bmp.height); cx = cv.getContext('2d'); }
    cx.drawImage(bmp, 0, 0); bmp.close();
    bc.postMessage({ type: 'thumb', id, blob: await cv.convertToBlob({ type: 'image/jpeg', quality }) });
  } finally { postMessage(0); }
};
