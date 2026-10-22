#!/usr/bin/env python3
"""Remove userRegistryAdditions for named products from a Plugr cache.

A user-added source OVERRIDES the bundled registry, so a bad one can only be
fixed in the app or here — a registry fix can never reach it. Removing the
addition makes the item fall through to the bundled registry.

Plugr must be CLOSED: it rewrites the whole cache on quit and would clobber
this. Dry run by default; --apply writes, after a timestamped backup.

  python3 tools/clear-user-sources.py \
      --target 'Native Instruments|Reaktor 6' \
      --target 'Anthropic PBC|Claude'
  python3 tools/clear-user-sources.py --target ... --apply

--cache points at another machine's copy (see CLAUDE.md on the two Macs).
Developer and name must match the scanned values EXACTLY; each target must
match at least one item, so a typo fails loudly instead of silently doing
nothing. All formats of a product are removed together.
"""
import argparse, datetime, json, os, shutil, sys

DEFAULT_CACHE = '~/Library/Application Support/plugr/library-cache.json'

p = argparse.ArgumentParser()
p.add_argument('--target', action='append', default=[], metavar='DEVELOPER|NAME',
               help="repeatable; exact scanned developer and name, pipe-separated")
p.add_argument('--cache', default=DEFAULT_CACHE)
p.add_argument('--apply', action='store_true')
a = p.parse_args()
if not a.target:
    p.error('at least one --target is required')

targets = set()
for t in a.target:
    if '|' not in t:
        p.error(f'--target needs DEVELOPER|NAME, got {t!r}')
    dev, name = t.split('|', 1)
    targets.add((dev.strip(), name.strip()))

cache = os.path.expanduser(a.cache)
d = json.load(open(cache, encoding='utf-8'))
items = d['library']['items']
ura = d.get('userRegistryAdditions') or {}

matched = {t: 0 for t in targets}
keys = {}
for it in items:
    t = (it.get('developer'), it.get('name'))
    if t not in targets:
        continue
    matched[t] += 1
    # A user addition is keyed by `item.identifier || item.id`.
    for k in (it.get('identifier'), it.get('id')):
        if k and k in ura:
            keys.setdefault(k, []).append((t[0], t[1], it.get('format')))

missing = [t for t, n in matched.items() if n == 0]
if missing:
    sys.exit('no item matches: ' + ', '.join(f'{d}|{n}' for d, n in missing))

print(f'cache {cache}')
print(f'userRegistryAdditions before: {len(ura)}  |  keys to remove: {len(keys)}')
for k, who in sorted(keys.items()):
    e = ura[k]
    fmts = ','.join(sorted({w[2] or '?' for w in who}))
    print(f'  - {k}\n      {who[0][0]} / {who[0][1]}  [{fmts}]'
          f'\n      url   {e.get("updateUrl")}\n      regex {e.get("versionRegex")}')
if not keys:
    sys.exit('\nnothing to remove — those products have no user source.')
if not a.apply:
    sys.exit('\nDRY RUN — rerun with --apply to write.')

stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
backup = f'{cache}.bak-{stamp}'
shutil.copy2(cache, backup)
for k in keys:
    del ura[k]
d['userRegistryAdditions'] = ura
tmp = cache + '.new'
with open(tmp, 'w', encoding='utf-8') as f:
    json.dump(d, f, ensure_ascii=False)
os.replace(tmp, cache)
print(f'\nbackup   {backup}\nafter    {len(ura)} userRegistryAdditions')
