"""DIAG-1104 previews from the mascot sheets (webview-ui/src/agent-tycoon/characters/mascots/*.json, made by
gen-mascots.ts), default colour, smile: diag-sheet-6x.png / diag-sheet-1x.png (the twelve's
three-quarter rows: lower right on top, upper right below; walk1 stand walk3) and walk-8dir.gif
(a few species walking the 8 directions: down, down-right, right, up-right, up, up-left, left,
down-left; the left ones mirrored as the app does). Writes to agent-tycoon/artifacts/mascots-diag-1104/.

  ~/.local/bin/uv run -q --with pillow python -I agent-tycoon/scripts/preview-mascot-diag.py
"""
import json, os, sys
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), '..', '..')
SRC = os.path.join(ROOT, 'webview-ui/src/agent-tycoon/characters/mascots')
OUT = os.path.join(ROOT, 'agent-tycoon/artifacts/mascots-diag-1104')
ORDER = ['tori', 'coral', 'byte', 'puff', 'kwak', 'bugi', 'moka', 'mungge', 'boo', 'gasi', 'mora', 'shoo']
GIF = ['tori', 'kwak', 'moka', 'boo', 'mora', 'shoo']
BG = (30, 30, 46)


def hexrgb(h):
    return tuple(int(h[k:k + 2], 16) for k in (1, 3, 5)) + (255,)


def frame(d, rows, anchor, face, mirror=False):
    """One 16x32 RGBA frame: the rows in the palette, the face put at its anchor."""
    im = Image.new('RGBA', (16, 32), (0, 0, 0, 0))
    px = im.load()
    for y, row in enumerate(rows):
        for x, k in enumerate(row):
            if k != '.':
                px[x, y] = hexrgb(d['palette'][k])
    if anchor['face'] and face:
        for u, v, k in face:
            x, y = anchor['face'][0] + u, anchor['face'][1] + v
            if 0 <= x < 16 and 0 <= y < 32:
                px[x, y] = hexrgb(d['palette'][k])
    return im.transpose(Image.FLIP_LEFT_RIGHT) if mirror else im


def walk(d, way):
    """The walk frames (walk1 stand walk3) of one of the 8 directions."""
    diag = d['diag']
    smile = d['faces']['smile']
    src = {
        'down': (d['frames']['down'][:3], d['anchors']['down'][:3], smile.get('down'), False),
        'right': (d['frames']['right'][:3], d['anchors']['right'][:3], smile.get('right'), False),
        'up': (d['frames']['up'][:3], d['anchors']['up'][:3], None, False),
        'left': (d['frames']['right'][:3], d['anchors']['right'][:3], smile.get('right'), True),
    }
    for side, mirror in (('Right', False), ('Left', True)):
        src['down' + side] = (diag['frames']['downRight'], diag['anchors']['downRight'],
                              diag['faces']['smile']['downRight'], mirror)
        src['up' + side] = (diag['frames']['upRight'], diag['anchors']['upRight'], None, mirror)
    rows, anchors, face, mirror = src[way]
    return [frame(d, r, a, face, mirror) for r, a in zip(rows, anchors)]


def big(im, z):
    return im.resize((im.width * z, im.height * z), Image.NEAREST)


data = {s: json.load(open(os.path.join(SRC, s + '.json'))) for s in ORDER}
os.makedirs(OUT, exist_ok=True)

# the sheet: 4 species a row; a block = lower right (3 frames) over upper right (3 frames)
for z in (6, 1):
    gap = 2 * z
    bw, bh = 3 * 16 * z + 4 * gap, 2 * 32 * z + 3 * gap
    sheet = Image.new('RGBA', (4 * bw, 3 * bh), BG + (255,))
    for i, s in enumerate(ORDER):
        bx, by = (i % 4) * bw + gap, (i // 4) * bh + gap
        for r, way in enumerate(('downRight', 'upRight')):
            for k, f in enumerate(walk(data[s], way)):
                f = big(f, z)
                sheet.paste(f, (bx + k * (16 * z + gap), by + r * (32 * z + gap)), f)
    sheet.convert('RGB').save(os.path.join(OUT, f'diag-sheet-{z}x.png'))

# the GIF: a row per species, the 8 directions across, walk1 stand walk3 stand, 4x
WAYS = ['down', 'downRight', 'right', 'upRight', 'up', 'upLeft', 'left', 'downLeft']
Z, CW, CH = 4, 16 * 4 + 12, 32 * 4 + 8
frames = []
for step in (0, 1, 2, 1):
    im = Image.new('RGBA', (len(WAYS) * CW + 12, len(GIF) * CH + 12), BG + (255,))
    for r, s in enumerate(GIF):
        for c, way in enumerate(WAYS):
            f = big(walk(data[s], way)[step], Z)
            im.paste(f, (12 + c * CW, 8 + r * CH), f)
    frames.append(im.convert('RGB').convert('P', palette=Image.ADAPTIVE, colors=255))
frames[0].save(os.path.join(OUT, 'walk-8dir.gif'), save_all=True, append_images=frames[1:],
               duration=200, loop=0)
print('ok', OUT)
