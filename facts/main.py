"""Facts microservice (service A).

Turns a topic into facts from the free Wikipedia REST API and forwards the
text to the counter service (B) for word counting. Part of a Docker
learning project; the external API is free and key-less.
"""

import hashlib
import logging
import os
import sys
from urllib.parse import quote

import requests
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

logging.basicConfig(
    level=logging.INFO,
    stream=sys.stdout,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("facts")

app = FastAPI()

SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/{}"
OPENSEARCH_URL = "https://en.wikipedia.org/w/api.php"
HEADERS = {"User-Agent": "docker-learning-project/1.0"}
TIMEOUT = 10
COUNTER_URL_DEFAULT = "http://counter:3000"
NO_FACTS_TEMPLATE = "No facts found for '{topic}'. Try another topic."
# CPU burn for ?spin=true (the autoscaling-lab signal path). Calibrated so one
# request burns roughly 30-80ms of CPU: ~2us per hash * 25000 hashes.
SPIN_HASHES = 25_000
SPIN_TEXT_TEMPLATE = "CPU spin mode: {n} hashes computed for topic '{topic}'"


def _fetch_summary(title):
    """Return (extract, source_url) for a title, or None if nothing usable."""
    response = requests.get(SUMMARY_URL.format(quote(title)), headers=HEADERS, timeout=TIMEOUT)
    logger.info("wikipedia summary %r -> %s", title, response.status_code)
    if response.status_code != 200:
        return None
    data = response.json()
    extract = data.get("extract")
    if not extract:  # e.g. disambiguation pages return an empty extract
        return None
    source_url = data.get("content_urls", {}).get("desktop", {}).get("page")
    return extract, source_url


def _fallback_title(topic):
    """Ask the MediaWiki opensearch API for the best-matching real title."""
    params = {"action": "opensearch", "search": topic, "limit": 1, "format": "json"}
    response = requests.get(OPENSEARCH_URL, params=params, headers=HEADERS, timeout=TIMEOUT)
    logger.info("wikipedia opensearch %r -> %s", topic, response.status_code)
    if response.status_code != 200:
        return None
    data = response.json()
    titles = data[1] if isinstance(data, list) and len(data) > 1 else []
    return titles[0] if titles else None


def _get_facts(topic):
    """Fetch the facts text and source URL, retrying once via opensearch."""
    result = _fetch_summary(topic)
    if result is None:
        title = _fallback_title(topic)
        if title:
            logger.info("wikipedia retrying summary with title %r", title)
            result = _fetch_summary(title)
    if result is None:
        logger.info("wikipedia miss for topic %r", topic)
        return NO_FACTS_TEMPLATE.format(topic=topic), None
    logger.info("wikipedia hit for topic %r", topic)
    return result


def _spin_facts(topic):
    """Burn CPU deterministically for the autoscaling lab; no network calls.

    Hashes an incrementing counter SPIN_HASHES times so every spin request
    costs the same CPU, then returns (facts_text, None) in the same shape
    _get_facts would return.
    """
    n = 0
    while n < SPIN_HASHES:
        hashlib.sha256(n.to_bytes(4, "big")).digest()
        n += 1
    return SPIN_TEXT_TEMPLATE.format(n=n, topic=topic), None


def _get_counts(facts_text):
    """POST the facts text to the counter service; None on any failure."""
    counter_url = os.environ.get("COUNTER_URL", COUNTER_URL_DEFAULT).rstrip("/")
    try:
        response = requests.post(
            counter_url + "/count", json={"text": facts_text}, timeout=TIMEOUT
        )
        response.raise_for_status()
        counts = response.json()
        logger.info("counter ok -> %s", counts)
        return counts
    except Exception as exc:  # any failure must not fail the /facts response
        logger.warning("counter failed (%s) -> counts=null", exc)
        return None


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/facts")
def facts(topic: str = Query(default=None), spin: bool = Query(default=False)):
    topic = (topic or "").strip()
    if not topic:
        logger.info("rejected request: empty topic")
        return JSONResponse(status_code=400, content={"error": "topic is required"})

    if spin:  # autoscaling-lab path: CPU burn, zero external HTTP
        logger.info("spin request for topic %r", topic)
        facts_text, source_url = _spin_facts(topic)
    else:
        logger.info("facts request for topic %r", topic)
        facts_text, source_url = _get_facts(topic)
    counts = _get_counts(facts_text)
    return {
        "topic": topic,
        "facts": facts_text,
        "sourceUrl": source_url,
        "counts": counts,
    }
