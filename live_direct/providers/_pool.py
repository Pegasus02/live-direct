"""Bounded, order-preserving fan-out for discovery requests (standard library)."""
import time
from concurrent.futures import ThreadPoolExecutor, wait

# Small on purpose: enough to hide per-request latency without looking like a crawler.
WORKERS = 4


def fan_out(fn, items, deadline, workers=WORKERS):
    """Return [(item, result, error)] in input order.

    error is None on success, TimeoutError when the item did not finish before
    the shared deadline (or never started because the budget was spent), or the
    exception raised by fn. Every item is judged on its own completion state,
    so one slow request cannot discard results that already finished. Queued
    items re-check the deadline before touching the network, so an exhausted
    budget starts no new upstream requests. Each network call keeps its own
    timeout; abandoned in-flight workers finish without blocking the caller.
    """
    items = list(items)
    if not items or deadline - time.monotonic() <= 0:
        return [(item, None, TimeoutError()) for item in items]

    def guarded(item):
        if time.monotonic() >= deadline:
            raise TimeoutError()
        return fn(item)

    pool = ThreadPoolExecutor(max_workers=min(workers, len(items)))
    try:
        futures = [pool.submit(guarded, item) for item in items]
        wait(futures, timeout=max(0, deadline - time.monotonic()))
        results = []
        for item, future in zip(items, futures):
            if not future.done():
                future.cancel()
                results.append((item, None, TimeoutError()))
            elif future.cancelled():
                results.append((item, None, TimeoutError()))
            elif future.exception() is not None:
                results.append((item, None, future.exception()))
            else:
                results.append((item, future.result(), None))
        return results
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
