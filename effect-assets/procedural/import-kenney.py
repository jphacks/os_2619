"""Copies the CC0 Kenney Particle Pack sprites that the water / wind effects use, as 256 px grey + alpha PNGs.
  python3 effect-assets/procedural/import-kenney.py <kenney_particle_pack folder>
The pack: https://kenney.nl/assets/particle-pack (CC0), also https://github.com/Calinou/kenney-particle-pack
Writes effect-assets/textures/<name>.png and copies them to product/dashboard/public/assets/{water,wind}/.
"""
import sys, shutil
from pathlib import Path
from PIL import Image

here = Path(__file__).resolve().parent
tex = here.parent / 'textures'
pub = here.parent.parent / 'product' / 'dashboard' / 'public' / 'assets'
PICK = {  # kenney file -> (our name, folders)
    'smoke_07.png': ('mist-puff.png', ['water', 'wind']),
    'smoke_10.png': ('foam-ring.png', ['water']),
    'dirt_01.png': ('spray-cluster.png', ['water']),
    'twirl_02.png': ('wind-twirl.png', ['wind']),
    'slash_03.png': ('wind-slash.png', ['wind']),
    'trace_05.png': ('wind-trace.png', ['wind']),
    'star_06.png': ('glint.png', ['water', 'wind']),
    'dirt_03.png': ('dust-debris.png', ['wind']),
}
src = Path(sys.argv[1])
for f, (name, folders) in PICK.items():
    im = Image.open(src / f).convert('RGBA').resize((256, 256), Image.LANCZOS)
    r, g, b, a = im.split()
    hi = max(1, r.getextrema()[1])
    r = r.point(lambda v: min(255, round(v * 255 / hi)))
    out = Image.merge('RGBA', (r, r, r, a))
    out.save(tex / name, optimize=True)
    for d in folders:
        (pub / d).mkdir(parents=True, exist_ok=True)
        shutil.copy(tex / name, pub / d / name)
    print(name)
