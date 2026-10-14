# Subset the two Grenze families for the "grim" theme (research/gf-three/kit/ui/theme.js): Latin and Latin-1, the weight
# range the theme uses, lining figures made the default (tabular in the text face: a HUD's numbers must not jump, and
# CSS's `font` shorthand resets font-variant-numeric, so the default is what shows), the source's hinting tables kept
# (without them FreeType spaces small text unevenly), their own family
# names (a modified version under the SIL OFL 1.1; neither upstream declares a Reserved Font Name).
# Needs fonttools and brotli.
#   python subset.py <dir with GrenzeGotisch.ttf and Grenze.ttf> <out dir>
# The sources are pinned in ATTRIBUTION.md beside this file; the same sources give the same bytes.
import sys, os, hashlib
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
LATIN = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100)) + [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x2022, 0x2212, 0x221E, 0x152, 0x153, 0x131]
FEATS = ['kern', 'liga', 'lnum', 'tnum', 'pnum', 'onum', 'calt', 'ccmp', 'locl', 'mark', 'mkmk']
JOBS = [
    # source, file, weight range, family, the figure feature made the default
    ('GrenzeGotisch.ttf', 'grim-display.woff2', (500, 800), 'GF Grim Display', 'lnum'),
    ('Grenze.ttf', 'grim-text.woff2', (400, 800), 'GF Grim Text', 'tnum'),
]


def single_subst(font, tag):
    """glyph -> glyph for every single substitution of a GSUB feature."""
    gsub, m = font['GSUB'].table, {}
    for fr in gsub.FeatureList.FeatureRecord:
        if fr.FeatureTag != tag:
            continue
        for i in fr.Feature.LookupListIndex:
            for st in gsub.LookupList.Lookup[i].SubTable:
                if st.LookupType == 7:
                    st = st.ExtSubTable
                if st.LookupType == 1:
                    m.update(st.mapping)
    return m


for name, to, (lo, hi), family, figures in JOBS:
    f = TTFont(os.path.join(src, name), recalcTimestamp=False)
    f = instancer.instantiateVariableFont(f, {'wght': (lo, hi)})
    # the default figures: what the feature would give, written into the character map
    m = single_subst(f, figures)
    for t in f['cmap'].tables:
        for cp, g in list(t.cmap.items()):
            if g in m:
                t.cmap[cp] = m[g]
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = FEATS
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    opts.notdef_outline = True
    opts.hinting = True
    opts.desubroutinize = True
    s = subset.Subsetter(opts)
    s.populate(unicodes=LATIN)
    s.subset(f)
    for rec in f['name'].names:
        if rec.nameID in (1, 4, 16):
            rec.string = family
        elif rec.nameID == 6:
            rec.string = family.replace(' ', '')
        elif rec.nameID == 3:
            rec.string = family + ' (a subset of ' + name.replace('.ttf', '') + ')'
    p = os.path.join(out, to)
    f.flavor = 'woff2'
    f.save(p)
    b = open(p, 'rb').read()
    cmap = TTFont(p).getBestCmap()
    print(to, len(b), 'bytes', hashlib.sha256(b).hexdigest(), 'glyphs', len(TTFont(p).getGlyphOrder()), 'chars', len(cmap), 'digits', [cmap[c] for c in (0x30, 0x31, 0x34)], 'missing', [hex(c) for c in LATIN if c not in cmap])
