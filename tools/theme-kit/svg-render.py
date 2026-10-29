# SPDX-License-Identifier: BSD-3-Clause
# Copyright (c) 2026, pasketti and the Phoenix project.
"""Bounded author-side SVG subset. stdin only; stdout is a 256x256 RGBA PNG."""
import io
import math
import re
import sys
from typing import NoReturn


class Refusal(Exception):
    pass


def refuse(code) -> NoReturn:
    raise Refusal(code)


def limits():
    # Fail closed on hosts without Unix resource limits. -I also excludes the
    # current directory, user site-packages and PYTHON* import overrides.
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (268435456, 268435456))
        resource.setrlimit(resource.RLIMIT_CPU, (2, 3))
        resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
        # Cairo's dependency loader may need a temporary file during import.
        # File-size zero is applied after trusted imports, before rendering.
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except (ImportError, OSError, ValueError):
        refuse('svg_decoder_unavailable')


NUMBER = r'[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?'
ID = r'[a-zA-Z][a-zA-Z0-9_-]{0,39}'
SVG_NS = 'http://www.w3.org/2000/svg'
COMMON = {'id', 'fill', 'stroke', 'color', 'fill-opacity', 'stroke-opacity',
          'opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
          'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
          'fill-rule', 'clip-rule', 'clip-path', 'transform'}
ELEMENTS = {
    'svg': {'width', 'height', 'viewBox', 'preserveAspectRatio'},
    'g': set(), 'defs': set(),
    'path': {'d'}, 'rect': {'x', 'y', 'width', 'height', 'rx', 'ry'},
    'circle': {'cx', 'cy', 'r'}, 'ellipse': {'cx', 'cy', 'rx', 'ry'},
    'line': {'x1', 'y1', 'x2', 'y2'}, 'polyline': {'points'}, 'polygon': {'points'},
    'linearGradient': {'x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod'},
    'radialGradient': {'cx', 'cy', 'r', 'fx', 'fy', 'gradientUnits', 'gradientTransform', 'spreadMethod'},
    'stop': {'offset', 'stop-color', 'stop-opacity'}, 'clipPath': {'clipPathUnits'},
}
ENUMS = {
    'stroke-linecap': {'butt', 'round', 'square'},
    'stroke-linejoin': {'miter', 'round', 'bevel'},
    'fill-rule': {'nonzero', 'evenodd'}, 'clip-rule': {'nonzero', 'evenodd'},
    'gradientUnits': {'objectBoundingBox', 'userSpaceOnUse'},
    'clipPathUnits': {'objectBoundingBox', 'userSpaceOnUse'},
    'spreadMethod': {'pad', 'reflect', 'repeat'},
    'preserveAspectRatio': {'xMidYMid', 'xMidYMid meet'},
}


def numbers(value, code='svg_invalid', pattern=None):
    if pattern is None:
        pattern = rf'(?:{NUMBER}|[\s,])+'
    if not re.fullmatch(pattern, value, re.ASCII):
        refuse(code)
    tokens = re.findall(NUMBER, value, re.ASCII)
    if len(tokens) > 8192:
        refuse('svg_too_complex')
    result = [float(n) for n in tokens]
    if any(not math.isfinite(n) or abs(n) > 16384 for n in result):
        refuse(code)
    return result


def dimension(value):
    if not re.fullmatch(rf'{NUMBER}(?:px)?', value, re.ASCII):
        refuse('svg_dimensions_invalid')
    n = float(value.removesuffix('px'))
    if not math.isfinite(n) or not 1 <= n <= 4096:
        refuse('svg_dimensions_invalid')
    return n


def validate(data):
    if not data or len(data) > 262144 or data.startswith(b'\x1f\x8b'):
        refuse('svg_invalid')
    try:
        text = data.decode('utf-8-sig', errors='strict')
    except UnicodeError:
        refuse('svg_invalid')
    # No entity references (even numeric/predefined), DTDs, CDATA or processing
    # instructions. Comments and a leading UTF-8 XML declaration are harmless.
    if '&' in text or re.search(r'<!\s*(?!--)', text):
        refuse('svg_unsafe')
    text = re.sub(r'^<\?xml\s+version=["\']1\.0["\'](?:\s+encoding=["\']UTF-8["\'])?\s*\?>', '', text, flags=re.I)
    if '<?' in text:
        refuse('svg_unsafe')
    try:
        from defusedxml import ElementTree as ET
    except ImportError:
        refuse('svg_decoder_unavailable')
    try:
        root = ET.fromstring(text, forbid_dtd=True, forbid_entities=True, forbid_external=True)
    except Exception:
        refuse('svg_invalid')
    count = 0
    ids, references, names = {}, {}, {}

    def visit(node, depth):
        nonlocal count
        count += 1
        if count > 2048 or depth > 32 or len(node.attrib) > 32:
            refuse('svg_too_complex')
        name = node.tag
        if name.startswith('{' + SVG_NS + '}'):
            name = name[len(SVG_NS) + 2:]
        if name not in ELEMENTS or (name == 'svg' and node is not root):
            refuse('svg_unsafe')
        names[node] = name
        if (node.text or '').strip() or (node.tail or '').strip():
            refuse('svg_unsafe')
        references[node] = []
        for key, value in node.attrib.items():
            # Unknown namespaces, href/xlink:href, events, xml:base, CSS and all
            # unsupported attributes are rejected, not silently stripped.
            if key not in COMMON | ELEMENTS[name]:
                refuse('svg_unsafe')
            if len(value) > 65536:
                refuse('svg_too_complex')
            value = value.strip()
            if key == 'id':
                if not re.fullmatch(ID, value, re.ASCII) or value in ids:
                    refuse('svg_invalid')
                ids[value] = node
            elif key in {'viewBox', 'width', 'height'} and node is root:
                continue  # Validated separately, including dimension products.
            elif key in ENUMS:
                if value not in ENUMS[key]:
                    refuse('svg_invalid')
            elif key in {'fill', 'stroke', 'color', 'stop-color', 'clip-path'}:
                reference = re.fullmatch(rf'url\(\s*(["\']?)#({ID})\1\s*\)', value, re.ASCII)
                if reference:
                    if key not in {'fill', 'stroke', 'clip-path'}:
                        refuse('svg_unsafe')
                    references[node].append((key, reference[2]))
                elif key == 'clip-path' and value == 'none':
                    pass
                elif key != 'clip-path' and re.fullmatch(r'(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|[a-zA-Z]{1,24})', value, re.ASCII):
                    pass
                elif key != 'clip-path' and re.fullmatch(r'(?:rgb|rgba)\([0-9.,%\s+-]+\)', value, re.ASCII):
                    numbers(value[value.index('(') + 1:-1].replace('%', ''))
                else:
                    refuse('svg_unsafe')
            elif key == 'd':
                numbers(value, pattern=rf'(?:{NUMBER}|[MmLlHhVvCcSsQqTtAaZz\s,])+')
            elif key in {'transform', 'gradientTransform'}:
                transform = r'(?:matrix|translate|scale|rotate|skewX|skewY)\s*\(([^()]*)\)'
                for match in re.finditer(transform, value):
                    numbers(match[1])
                if re.sub(transform, '', value).strip():
                    refuse('svg_invalid')
            elif key == 'stroke-dasharray' and value == 'none':
                pass
            else:
                # Percentages are bounded scalar lengths, never viewport sizes.
                numbers(value.removesuffix('%'))
        for child in node:
            visit(child, depth + 1)

    visit(root, 1)
    if names[root] != 'svg':
        refuse('svg_invalid')
    viewbox = root.get('viewBox')
    if viewbox is not None:
        box = numbers(viewbox, 'svg_dimensions_invalid')
        if len(box) != 4:
            refuse('svg_dimensions_invalid')
        w, h = dimension(str(box[2])), dimension(str(box[3]))
        if w * h > 4194304:
            refuse('svg_dimensions_invalid')
    else:
        if 'width' not in root.attrib or 'height' not in root.attrib:
            refuse('svg_dimensions_invalid')
        w, h = dimension(root.get('width')), dimension(root.get('height'))
        root.set('viewBox', f'0 0 {w} {h}')
    width, height = dimension(root.get('width', str(w))), dimension(root.get('height', str(h)))
    if width * height > 4194304:
        refuse('svg_dimensions_invalid')
    # All source dimensions are checked before replacing the viewport. Fixed PNG
    # size is part of the author contract; nothing SVG enters the runtime pack.
    root.set('width', '256'); root.set('height', '256')
    root.set('preserveAspectRatio', 'xMidYMid meet')

    visiting, finished = set(), set()

    def check_refs(node, depth=1):
        if node in visiting or depth > 32:
            refuse('svg_too_complex')
        if node in finished:
            return
        visiting.add(node)
        targets = list(node)
        for key, target in references[node]:
            other = ids.get(target)
            allowed = {'clipPath'} if key == 'clip-path' else {'linearGradient', 'radialGradient'}
            if other is None or names[other] not in allowed:
                refuse('svg_unsafe')
            targets.append(other)
        for other in targets:
            check_refs(other, depth + 1)
        visiting.remove(node)
        finished.add(node)

    check_refs(root)
    return ET.tostring(root, encoding='utf-8')


def render(data):
    clean = validate(data)
    try:
        from cairosvg.surface import PNGSurface
        from PIL import Image
        Image.preinit()  # Load image plugins before closing the Python I/O boundary.
    except (ImportError, OSError):
        refuse('svg_decoder_unavailable')

    def no_fetch(*args, **kwargs):
        refuse('svg_unsafe')

    def no_io(event, args):
        if event == 'open' or event in {'os.listdir', 'os.scandir'} or event.startswith(('socket.', 'subprocess.', 'ctypes.dlopen')):
            refuse('svg_unsafe')

    # Defense in depth in addition to the static subset: no renderer URL fetches,
    # Python file opens, network, dynamic libraries or child processes after imports.
    # No text/fonts, image decoders, CSS, filters, patterns or <use> from the source.
    import resource
    resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
    sys.addaudithook(no_io)
    png = PNGSurface.convert(bytestring=clean, unsafe=False, url_fetcher=no_fetch,
                             output_width=256, output_height=256)
    # Cairo may include bKGD; emit a plain RGBA PNG for the existing strict PNG
    # normalizer (which still checks dimensions, CRCs, pixels and compressed size).
    with Image.open(io.BytesIO(png)) as image:
        if image.size != (256, 256):
            refuse('svg_dimensions_invalid')
        output = io.BytesIO()
        image.convert('RGBA').save(output, format='PNG', compress_level=9)
    return output.getvalue()


def main():
    try:
        limits()
        data = sys.stdin.buffer.read(262145)
        if len(data) > 262144:
            refuse('svg_invalid')
        result = render(data)
        sys.stdout.buffer.write(result)
    except Refusal as exc:
        sys.stderr.write(str(exc))
        return 2
    except Exception:
        # No source content, paths or dependency tracebacks in author diagnostics.
        sys.stderr.write('svg_invalid')
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
