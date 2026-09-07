#!/usr/bin/env python3
"""Generate the small source-decision table used by the Bing adapter.

The source does not expose the transliterated text.  It only tests
``unidecode(spoken_text).strip('.')`` for emptiness and for a fixed set of
ASCII boilerplate prefixes.  This generator retains exactly the code-point
outputs needed for those two predicates and marks all other mapped output as
non-empty/non-prefix at runtime.  It is deliberately not a replacement
general-purpose Unidecode implementation.
"""

import argparse
import json
import sys
import warnings
from pathlib import Path


PREFIXES = [
    'I found this',
    'Here is what I found',
    "Here's what I found",
    'Take a look at this',
    'Here are some new articles, hot off the presses',
    "Here's some information that might help",
    'I pulled up some results',
    'This is what I found',
    'Moist sang ? (Heart) Is',
    "I've got this for you on",
    'Here is a peek around',
    "Here's a peek around",
    "Here's a look around",
    'Here is a look around',
    "I've got games around",
    "Here's a list",
    "Here's your answer",
]


def ranges(values):
    result = []
    for codepoint in values:
        if not result or codepoint != result[-1][1] + 1:
            result.append([codepoint, codepoint])
        else:
            result[-1][1] = codepoint
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--wheel', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    sys.path.insert(0, args.wheel)
    import unidecode  # pylint: disable=import-error,import-outside-toplevel
    warnings.filterwarnings('ignore', category=RuntimeWarning)

    empty = []
    prefix = []
    # A non-ASCII code point can contribute after an earlier transliterated
    # fragment (for example a Greek ``Ι`` followed by Cyrillic/ASCII text).
    # Retain outputs that are prefixes of any suffix, not just prefixes from
    # position zero.  Other mapped output is represented by a non-prefix
    # marker at runtime.
    suffixes = [item[offset:] for item in PREFIXES for offset in range(len(item))]
    for codepoint in range(0x80, 0x110000):
        output = unidecode.unidecode(chr(codepoint))
        trimmed = output.strip('.')
        # Only an actually empty per-codepoint output is safe to omit.
        # Dot-only output is nonempty until the complete string is assembled:
        # e.g. Unidecode('I\u2024 found this') == 'I. found this'.
        if output == '':
            empty.append(codepoint)
        elif trimmed == '' or any(trimmed.startswith(item) or item.startswith(trimmed) for item in suffixes):
            prefix.append((codepoint, output))

    lines = [
        '/**',
        ' * Source-decision data generated from Unidecode==1.0.22.',
        ' *',
        ' * This table only models the Bing empty/unhelpful predicate; it is',
        ' * not a general transliteration table and must not be used for output.',
        ' * Dot-only source mappings are retained because they can be internal before',
        " * the source applies its final strip('.').",
        ' */',
        'export const SOURCE_UNIDECODE_EMPTY_RANGES = Object.freeze([',
    ]
    for start, end in ranges(empty):
        lines.append('  [0x{:x}, 0x{:x}],'.format(start, end))
    lines.extend([
        ']);',
        '',
        'export const SOURCE_UNIDECODE_PREFIX_REPLACEMENTS = new Map([',
    ])
    for codepoint, output in prefix:
        lines.append('  [0x{:x}, {}],'.format(codepoint, json.dumps(output)))
    lines.extend([
        ']);',
        '',
        'export const SOURCE_UNIDECODE_DATA = Object.freeze({',
        "  version: '1.0.22',",
        "  sourceWheelSha256: '72f49d3729f3d8f5799f710b97c1451c5163102e76d64d20e170aedbbd923582',",
        "  sourceLicense: 'GPLv2+ (source data provenance; lead review required)',",
        '  emptyRangeCount: {},'.format(len(ranges(empty))),
        '  prefixReplacementCount: {},'.format(len(prefix)),
        '});',
        '',
    ])
    Path(args.output).write_text('\n'.join(lines))
    print(json.dumps({
        'output': args.output,
        'empty_codepoints': len(empty),
        'empty_ranges': len(ranges(empty)),
        'prefix_replacements': len(prefix),
    }, sort_keys=True))


if __name__ == '__main__':
    main()
