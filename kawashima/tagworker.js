// Tag detection off the main thread (module worker, started by extrinsics.js). In: { n, bmp: ImageBitmap, ids, passes },
// out: { n, out, width, height } or { n, err }. One frame at a time; the page queues the rest.
import { grab, detectInImage } from './tagdetect.js';

onmessage = async ({ data: { n, bmp, ids, passes } }) => {
  try {
    const img = grab(bmp); bmp.close();
    const out = img ? await detectInImage(img, ids, passes) : [];
    postMessage({ n, out, width: img?.width ?? 0, height: img?.height ?? 0 });
  } catch (e) { postMessage({ n, err: String(e?.message ?? e) }); }
};
