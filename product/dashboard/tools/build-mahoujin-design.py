# Builds public/mahoujin-design.bin.gz, the mahoujin's printed artwork for the stick scan (stickscan.js: what the floor should look like
# where there is no stick), from the A3 kit ../../mahoujin/magic-circle-576808920-A3.pdf.
#   python tools/build-mahoujin-design.py [kit.pdf] [out]        (needs pypdfium2, numpy, Pillow)
# The kit: pages 3-26 are the poster sheets A1..D6 (6 columns x 4 rows, row-major); each shows 265 x 382 mm of the artwork at
# x 10..275, y 16..398 mm of the page (the rest: cut marks, rulers, the blue glue strips the next sheet covers). Pasted edge to edge
# they give the whole circle. The tag patches (pages 27-33) are clean copies of the dots already printed there, so they are not needed.
# Out: gzip of a 8-byte header (uint16 LE: width, height, centre x, centre y in pixels) and width x height bytes, 1 mm per pixel,
# row 0 at the poster's top (T0's side), 0 = paper .. 255 = full ink (any colour: the darkest channel, so the red and gold print count).
import gzip, os, struct, sys
import numpy as np
import pypdfium2 as pdfium

here = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '..', '..', '..', 'mahoujin', 'magic-circle-576808920-A3.pdf')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, '..', 'public', 'mahoujin-design.bin.gz')
COLS, ROWS, VW, VH, X0, Y0, FIRST = 6, 4, 265, 382, 10, 16, 2  # FIRST: page index of A1
PX = 4  # render at 4 px / mm, then average down to 1 mm

pdf = pdfium.PdfDocument(SRC)
art = np.zeros((ROWS * VH, COLS * VW), np.float32)
for r in range(ROWS):
    for c in range(COLS):
        img = np.asarray(pdf[FIRST + r * COLS + c].render(scale=PX * 25.4 / 72).to_pil().convert('RGB'), np.float32)
        ink = 1 - img.min(axis=2) / 255  # the darkest channel
        tile = ink[Y0 * PX:(Y0 + VH) * PX, X0 * PX:(X0 + VW) * PX]
        art[r * VH:(r + 1) * VH, c * VW:(c + 1) * VW] = tile.reshape(VH, PX, VW, PX).mean(axis=(1, 3))
# the circle's centre: the middle of the printed extent (the artwork outside the outer ring is blank paper)
ys, xs = np.nonzero(art > .5)
cx, cy = round((xs.min() + xs.max()) / 2), round((ys.min() + ys.max()) / 2)
print(f'{art.shape[1]} x {art.shape[0]} mm, ink from x {xs.min()}..{xs.max()}, y {ys.min()}..{ys.max()}: centre ({cx}, {cy}), '
      f'outer radius ~{(xs.max() - xs.min()) / 2:.0f} x {(ys.max() - ys.min()) / 2:.0f} mm')
h, w = art.shape
with gzip.open(OUT, 'wb', 9) as f:
    f.write(struct.pack('<4H', w, h, cx, cy))
    f.write((np.clip(art, 0, 1) * 255).round().astype(np.uint8).tobytes())
print('wrote', OUT, os.path.getsize(OUT), 'bytes')
