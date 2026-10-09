"""Save the private Xvfb framebuffer as PNG, including the browser Find bar."""
import struct
import sys
import zlib
from pathlib import Path

raw = Path(sys.argv[1]).read_bytes()
header = struct.unpack('>25I', raw[:100])
size, _, fmt, _, width, height, _, order, _, _, _, bits, stride, _, red, green, blue, _, _, colors, *_ = header
if (fmt, order, bits, red, green, blue) != (2, 0, 32, 0xff0000, 0xff00, 0xff):
    raise ValueError('Expected the private Xvfb TrueColor BGRX framebuffer')
pixels = memoryview(raw)[size + colors * 12:]
rows = bytearray()
for y in range(height):
    source = pixels[y * stride:y * stride + width * 4].tobytes()
    row = bytearray(1 + width * 3)
    row[1::3], row[2::3], row[3::3] = source[2::4], source[1::4], source[0::4]
    rows.extend(row)

def chunk(kind, payload):
    return struct.pack('>I', len(payload)) + kind + payload + struct.pack('>I', zlib.crc32(kind + payload))

Path(sys.argv[2]).write_bytes(b'\x89PNG\r\n\x1a\n' +
    chunk(b'IHDR', struct.pack('>2I5B', width, height, 8, 2, 0, 0, 0)) +
    chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))
