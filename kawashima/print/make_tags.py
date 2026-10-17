# Printable AprilTag (tag36h11, the dictionary the phones detect) sheets, sizes matching world.js TAGS.
# Run: python3 kawashima/print/make_tags.py   -> kawashima/print/corner_tags_A3.pdf, chest_tags_A4.pdf
# Print at 100% ("actual size", no fit-to-page), then measure the black square and fix TAGS sizes if it differs.
from pathlib import Path
import cv2
from PIL import Image, ImageDraw, ImageFont

DPI = 300
MM = DPI / 25.4
OUT = Path(__file__).parent
FONT = '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc'
DICT = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11)

def sheet(tag_id, black_mm, page_mm, title, note):
    w, h = (round(v * MM) for v in page_mm)
    page = Image.new('L', (w, h), 255)
    side = round(black_mm * MM)
    tag = cv2.aruco.generateImageMarker(DICT, tag_id, side, borderBits=1)  # outer edge = black square edge
    x, y = (w - side) // 2, round(30 * MM)
    page.paste(Image.fromarray(tag), (x, y))
    d = ImageDraw.Draw(page)
    big, small = ImageFont.truetype(FONT, round(9 * MM)), ImageFont.truetype(FONT, round(4 * MM))
    d.text((x, round(8 * MM)), title, font=big, fill=0)
    ty = y + side + round(8 * MM)
    d.text((x, ty), f'黒い正方形の一辺 = {black_mm:g} mm（印刷後に測って確認）', font=small, fill=0)
    d.text((x, ty + round(7 * MM)), note, font=small, fill=0)
    # 100 mm scale bar to catch printer scaling
    by = ty + round(18 * MM)
    d.rectangle([x, by, x + round(100 * MM), by + round(2 * MM)], fill=0)
    d.text((x, by + round(4 * MM)), '← この線が 100 mm でなければ拡大縮小されている', font=small, fill=0)
    return page

def save(pages, name):
    pages[0].save(OUT / name, save_all=True, append_images=pages[1:], resolution=DPI)
    print('wrote', OUT / name)

A3, A4 = (297, 420), (210, 297)
corners = {0: '左奥の角 (-2, -2)', 1: '右奥の角 (+2, -2)', 2: '右手前の角 (+2, +2)', 3: '左手前の角 (-2, +2)', 4: 'B の真後ろの辺の中央 (+2, 0)', 5: 'A の真後ろの辺の中央 (-2, 0)'}
if __name__ == '__main__':
    save([sheet(i, 250, A3, f'固定タグ ID {i}', f'{pos}　高さ 1.3 m（中心）でフィールド中央に向ける') for i, pos in corners.items()], 'corner_tags_A3.pdf')
    save([sheet(i, 180, A4, f'胸タグ ID {i}（プレイヤー{p}）', '胸の中央に、正面を向けて貼る') for i, p in [(10, 'A'), (11, 'B')]], 'chest_tags_A4.pdf')
