"""Discovery shared by Douyu and Huya: manual rooms first, then a balanced
popularity round-robin across chosen categories, fetched concurrently under
one time budget.

Rows are plain dicts {id, key, name, title, logo, viewers}; `key` deduplicates
the same live room reached through a manual entry and a category listing.
"""
import html
import json
import re
import time

from ..models import Channel, ProviderError, RoomOfflineError
from ._pool import fan_out

BUDGET = 45


def parse_heat(raw):
    """Popularity counters arrive as ints or display text such as '12.3万'."""
    if isinstance(raw, bool):
        return 0
    if isinstance(raw, (int, float)):
        return max(0, int(raw))
    match = re.search(r'([0-9]+(?:\.[0-9]+)?)\s*(亿|万)?', str(raw or '').replace(',', ''))
    if not match:
        return 0
    return int(float(match.group(1)) * {'亿': 100_000_000, '万': 10_000}.get(match.group(2), 1))


def clean(value):
    return html.unescape(str(value or '')).strip()


def category_ids(values, table, label):
    """Accept category IDs or their Chinese names; unknown values reject the config."""
    result = []
    for value in values[:8]:
        value = str(value)
        cid = value if value in table else next((k for k, v in table.items() if v == value), None)
        if cid is None:
            raise ProviderError('Invalid ' + label + ' category')
        if cid not in result:
            result.append(cid)
    return result


def assigned_json(source, start, limit=2_000_000):
    """Return the JSON object/array literal beginning at `start` without evaluating
    any script: a quote-aware bracket scan finds its end, then json.loads parses it."""
    if start >= len(source) or source[start] not in '[{':
        raise ProviderError('Page data unavailable')
    depth, quote, escaped = 0, '', False
    for i in range(start, min(len(source), start + limit)):
        ch = source[i]
        if quote:
            if escaped:
                escaped = False
            elif ch == '\\':
                escaped = True
            elif ch == quote:
                quote = ''
            continue
        if ch in '"\'':
            quote = ch
        elif ch in '[{':
            depth += 1
        elif ch in ']}':
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(source[start:i + 1])
                except (ValueError, RecursionError):
                    raise ProviderError('Page data unavailable') from None
    raise ProviderError('Page data unavailable')


def discover(platform, label, warnings, manual, room, categories, category, count, min_viewers, accept=None):
    """Manual rooms always come first; offline rooms are skipped silently, fetch
    failures become one warning each. Rooms and categories are fetched through
    the bounded fan_out pool under one shared deadline (as Douyin and Bilibili
    do). Category rows fill up to `count` channels, taking turns between
    categories so one busy category cannot crowd out the others."""
    deadline = time.monotonic() + BUDGET
    errors = 0

    def failed(error, message):
        nonlocal errors
        if isinstance(error, RoomOfflineError):
            return
        if isinstance(error, TimeoutError):
            message = 'Discovery time budget reached; remaining requests deferred'
        elif not isinstance(error, ProviderError):
            raise error
        errors += 1
        if message not in warnings:
            warnings.append(message)
    rows = []
    for _, row, error in fan_out(room, manual, deadline):
        if error is None:
            rows.append(row)
        else:
            failed(error, 'A manual ' + label + ' room could not be fetched')
    buckets = []
    for _, batch, error in fan_out(category, categories if count else [], deadline):
        if error is None:
            buckets.append(sorted((r for r in batch if r['viewers'] >= min_viewers),
                                  key=lambda r: r['viewers'], reverse=True))
        else:
            failed(error, 'A ' + label + ' category could not be fetched')
    channels, seen = [], set()

    def add(row):
        if row['key'] in seen or (accept and not accept(row)):
            return False
        channels.append(Channel(platform, row['id'], row['name'], row['title'], row['logo']))
        seen.add(row['key'])
        return True
    for row in rows:
        add(row)
    added = 0
    # Balanced round-robin among chosen categories, highest-popularity head first.
    while any(buckets) and added < count:
        for bucket in sorted((b for b in buckets if b), key=lambda b: b[0]['viewers'], reverse=True):
            if added >= count:
                break
            added += int(add(bucket.pop(0)))
    if not channels and errors:
        raise ProviderError(label + ' discovery failed')
    return channels
