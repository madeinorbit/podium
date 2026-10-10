#!/usr/bin/env python3
"""Recreate POD-1721's wave as small RGBA images, without an SVG mask.

Only benchmark/review assets are produced. No production asset is changed.
Python's standard library encodes PNG/APNG; optional ffmpeg encodes WebP.
The output HTML embeds the bytes so an issue artifact is independently usable.
"""
import argparse
import base64
import binascii
import json
from pathlib import Path
import shutil
import struct
import subprocess
import zlib


DOTS = [(17, 18, 0), (49, 18, 120), (17, 39, 210), (49, 39, 330),
        (17, 61, 420), (49, 61, 540), (17, 82, 630), (49, 82, 750)]
WIDTH, HEIGHT = 32, 48
FRAME_COUNT = 45
CYCLE_MS = 1500


def wave(elapsed_ms, delay):
    progress = ((elapsed_ms - delay) % CYCLE_MS) / CYCLE_MS
    if progress <= .16:
        amount = progress / .16
        return .2 + .8 * amount, .8 + .36 * amount
    if progress <= .44:
        amount = (progress - .16) / .28
        return 1 - .8 * amount, 1.16 - .36 * amount
    return .2, .8


def raster(frame=None, radius=11, tint=(111, 157, 255)):
    # 4x4 coverage sampling at 2x the largest display size. Each pixel's RGB
    # stays unassociated with its alpha, as required by PNG and lossless WebP.
    states = [(cx, cy, *(wave(frame * CYCLE_MS / FRAME_COUNT, delay)
                          if frame is not None else (1, 1))) for cx, cy, delay in DOTS]
    rows = []
    for y in range(HEIGHT):
        row = bytearray([0])  # PNG filter None
        for x in range(WIDTH):
            alpha = 0
            for sy in range(4):
                for sx in range(4):
                    px = (x + (sx + .5) / 4) * 66 / WIDTH
                    py = (y + (sy + .5) / 4) * 100 / HEIGHT
                    coverage = 0
                    for cx, cy, opacity, scale in states:
                        if (px - cx) ** 2 + (py - cy) ** 2 <= (radius * scale) ** 2:
                            coverage = opacity + coverage * (1 - opacity)
                    alpha += coverage
            row.extend((*tint, round(alpha * 255 / 16)))
        rows.append(row)
    return zlib.compress(b''.join(rows), 9)


def chunk(kind, payload):
    return struct.pack('!I', len(payload)) + kind + payload + struct.pack('!I', binascii.crc32(kind + payload) & 0xffffffff)


def png(pixels):
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', WIDTH, HEIGHT, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', pixels) + chunk(b'IEND', b''))


def apng(radius, tint):
    data = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', WIDTH, HEIGHT, 8, 6, 0, 0, 0))
            + chunk(b'acTL', struct.pack('!II', FRAME_COUNT, 0)))
    sequence = 0
    for frame in range(FRAME_COUNT):
        data += chunk(b'fcTL', struct.pack('!IIIIIHHBB', sequence, WIDTH, HEIGHT, 0, 0, 1, 30, 0, 0))
        sequence += 1
        pixels = raster(frame, radius, tint)
        if frame == 0:
            data += chunk(b'IDAT', pixels)
        else:
            data += chunk(b'fdAT', struct.pack('!I', sequence) + pixels)
            sequence += 1
    return data + chunk(b'IEND', b'')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--template', type=Path, default=Path(__file__).with_name('working-mark-options.html'))
    parser.add_argument('--webp', action='store_true', help='Encode lossless animated WebP using the existing ffmpeg')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    asset_dir = args.out / 'working-mark-assets'
    asset_dir.mkdir(exist_ok=True)
    assets, manifest = {}, {}
    for name, radius in [('small', 11), ('medium', 10.5), ('large', 9.5)]:
        for theme, tint in [('dark', (111, 157, 255)), ('light', (42, 98, 240))]:
            suffix = f'{name}-{theme}'
            for kind, pixels in [('still', png(raster(None, radius, tint))), ('apng', apng(radius, tint))]:
                path = asset_dir / f'{kind}-{suffix}.png'
                path.write_bytes(pixels)
                key = f'{kind}-{suffix}'
                assets[key] = 'data:image/png;base64,' + base64.b64encode(pixels).decode()
                manifest[key] = {'bytes': len(pixels), 'width': WIDTH, 'height': HEIGHT, 'frames': 45 if kind == 'apng' else 1}
            if args.webp:
                executable = shutil.which('ffmpeg')
                if not executable:
                    raise RuntimeError('--webp requires ffmpeg; do not install system tools on a shared runner')
                path = asset_dir / f'webp-{suffix}.webp'
                subprocess.run([executable, '-nostdin', '-v', 'error', '-y', '-i', str(asset_dir / f'apng-{suffix}.png'),
                                '-c:v', 'libwebp_anim', '-lossless', '1', '-compression_level', '6', '-loop', '0', str(path)], check=True)
                pixels = path.read_bytes()
                key = f'webp-{suffix}'
                assets[key] = 'data:image/webp;base64,' + base64.b64encode(pixels).decode()
                manifest[key] = {'bytes': len(pixels), 'width': WIDTH, 'height': HEIGHT, 'frames': 45}
    html = args.template.read_text().replace('/* WORKING_MARK_ASSETS */ {}', json.dumps(assets, separators=(',', ':')))
    (args.out / 'working-mark-options.html').write_text(html)
    (args.out / 'assets.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'html': str(args.out / 'working-mark-options.html'), 'assets': manifest}), flush=True)


if __name__ == '__main__':
    main()
