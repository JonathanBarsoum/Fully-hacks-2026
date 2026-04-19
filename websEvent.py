"""
Prototype data collection + filtering pipeline for publicly available posts about
environmental pollution at beaches in California.

Sources are intentionally limited to public, non-authenticated endpoints.
Some optional API integrations (e.g. X) require credentials.
"""

from __future__ import annotations

import argparse
import html as html_lib
import json
import os
import re
import random
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


DEFAULT_BEACH_TERMS: Tuple[str, ...] = (
    "beach",
    "shore",
    "coast",
    "coastal",
    "pier",
    "cove",
    "harbor",
    "marina",
)

DEFAULT_CALIFORNIA_TERMS: Tuple[str, ...] = (
    "california",
    r"\bca\b",
    "san diego",
    "los angeles",
    "orange county",
    "santa monica",
    "malibu",
    "huntington beach",
    "venice beach",
    "long beach",
    "laguna beach",
    "newport beach",
    "santa cruz",
    "monterey",
    "santa barbara",
    "ventura",
    "pismo",
    "pacifica",
    # common hashtag/subreddit variants
    "sandiego",
    "losangeles",
    "orangecounty",
    "santamonica",
    "huntingtonbeach",
    "venicebeach",
    "longbeach",
    "lagunabeach",
    "newportbeach",
    "santacruz",
    "santabarbara",
    "bayarea",
    "sanfrancisco",
    "sanjose",
    "oakland",
)

DEFAULT_POLLUTION_TERMS: Tuple[str, ...] = (
    "pollution",
    "polluted",
    "dirty",
    "gross",
    "trash",
    "oil",
    "sewage",
    "contamination",
    "contaminated",
)

DEFAULT_REDDIT_SUBREDDITS = (
    "California,OC,orangecounty,sandiego,LosAngeles,bayarea,sanfrancisco,sf,oakland,sanjose,"
    "santacruz,montereybay,santabarbara,ventura,longbeach,inlandempire,sacramento,stockton,"
    "fresno,Surfing,environment,oceans"
)

DEFAULT_ASSUME_CA_SUBREDDITS = (
    "California,OC,orangecounty,sandiego,LosAngeles,bayarea,sanfrancisco,sf,oakland,sanjose,"
    "santacruz,montereybay,santabarbara,ventura,longbeach,inlandempire,sacramento,stockton,fresno"
)

DEFAULT_RANDOM_MODE_REQUESTS = 120
DEFAULT_RATE_LIMIT_S = 1.0

DEFAULT_QUERY_CONTEXT_TERMS: Tuple[str, ...] = (
    "spill",
    "closure",
    "closed",
    "health advisory",
    "warning",
    "water quality",
    "bacteria",
    "e coli",
    "algae",
    "red tide",
    "brown water",
    "smell",
    "odor",
)

DEFAULT_MASTODON_INSTANCES = "mastodon.social,sfba.social"
DEFAULT_MASTODON_HASHTAGS = (
    "beach,pollution,sewage,trash,oilspill,waterquality,california,orangecounty,sandiego,losangeles"
)

def _compile_keyword_regex(terms: Sequence[str]) -> re.Pattern[str]:
    parts: List[str] = []
    for raw in terms:
        term = (raw or "").strip()
        if not term:
            continue
        if term.startswith(("(?", r"\b")) or any(ch in term for ch in ("|", "[", "]", "(", ")", "^", "$")):
            parts.append(term)
            continue

        escaped = re.escape(term).replace(r"\ ", r"\s+")
        parts.append(rf"\b{escaped}\b")

    if not parts:
        return re.compile(r"a^", flags=re.IGNORECASE)
    return re.compile("(" + "|".join(parts) + ")", flags=re.IGNORECASE)


@dataclass(frozen=True)
class CollectedItem:
    text: str
    source: str  # URL or platform identifier
    metadata: Dict[str, Any]

    def to_json(self) -> Dict[str, Any]:
        return {"text": self.text, "source": self.source, "metadata": self.metadata}


class PollutionBeachFilter:
    def __init__(
        self,
        *,
        beach_terms: Sequence[str] = DEFAULT_BEACH_TERMS,
        california_terms: Sequence[str] = DEFAULT_CALIFORNIA_TERMS,
        pollution_terms: Sequence[str] = DEFAULT_POLLUTION_TERMS,
        assume_california_subreddits: Optional[Sequence[str]] = None,
        strict_california: bool = False,
    ) -> None:
        self._beach_re = _compile_keyword_regex(beach_terms)
        self._california_re = _compile_keyword_regex(california_terms)
        self._pollution_re = _compile_keyword_regex(pollution_terms)
        self._strict_california = strict_california
        self._assume_ca_subreddits = {
            (s.strip().lower()[2:] if s.strip().lower().startswith("r/") else s.strip().lower())
            for s in (assume_california_subreddits or [])
            if s and s.strip()
        }

    def matches(self, item: CollectedItem) -> bool:
        text = item.text or ""
        if not (self._beach_re.search(text) and self._pollution_re.search(text)):
            return False

        if self._california_re.search(text):
            return True

        if self._strict_california:
            return False

        platform = str(item.metadata.get("platform") or "").lower()
        if platform == "mastodon":
            hashtag = str(item.metadata.get("hashtag") or "").strip()
            tags = item.metadata.get("tags")
            tag_list = [hashtag] if hashtag else []
            if isinstance(tags, list):
                tag_list.extend([str(t).strip() for t in tags if t and str(t).strip()])
            if tag_list and self._california_re.search(" ".join(tag_list)):
                return True

        subreddit = str(item.metadata.get("subreddit") or "").lower()
        if subreddit and subreddit in self._assume_ca_subreddits:
            return True

        return False


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: List[str] = []

    def handle_data(self, data: str) -> None:
        if data:
            self._parts.append(data)

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        if tag in {"br", "p", "div", "li"}:
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"p", "div", "li"}:
            self._parts.append("\n")

    def text(self) -> str:
        text = "".join(self._parts)
        text = html_lib.unescape(text)
        text = re.sub(r"[ \t]+\n", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def _html_to_text(html: str) -> str:
    if not html:
        return ""
    parser = _HTMLTextExtractor()
    parser.feed(html)
    parser.close()
    return parser.text()


def _http_get_json(url: str, *, params: Optional[Dict[str, Any]] = None, headers: Optional[Dict[str, str]] = None,
                   timeout_s: float = 15.0) -> Any:
    headers = dict(headers or {})
    headers.setdefault("Accept", "application/json")

    try:
        import requests  # type: ignore

        resp = requests.get(url, params=params, headers=headers, timeout=timeout_s)
        if resp.status_code == 429:
            raise RuntimeError(f"Rate limited (HTTP 429) from {url}")
        resp.raise_for_status()
        return resp.json()
    except ModuleNotFoundError:
        pass

    import gzip
    import urllib.error
    import urllib.parse
    import urllib.request

    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params, doseq=True)

    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            status = getattr(resp, "status", None) or resp.getcode()
            if status == 429:
                raise RuntimeError(f"Rate limited (HTTP 429) from {url}")
            body = resp.read()
            encoding = (resp.headers.get("Content-Encoding") or "").lower()
            if encoding == "gzip":
                body = gzip.decompress(body)
            text = body.decode("utf-8", errors="replace")
            return json.loads(text)
    except urllib.error.HTTPError as exc:
        if getattr(exc, "code", None) == 429:
            raise RuntimeError(f"Rate limited (HTTP 429) from {url}") from exc
        raise


class RedditPublicJSONSource:
    def __init__(
        self,
        *,
        subreddits: Sequence[str],
        search_query: Optional[str] = None,
        limit_per_request: int = 50,
        max_pages: int = 1,
        time_filter: str = "month",
        user_agent: str = "BeachPollutionCollector/0.1",
        timeout_s: float = 15.0,
        sleep_s: float = 1.0,
    ) -> None:
        self._subreddits = _normalize_subreddits(subreddits)
        self._search_query = (search_query or "").strip() or None
        self._limit = max(1, min(int(limit_per_request), 100))
        self._max_pages = max(1, int(max_pages))
        self._time_filter = time_filter
        self._timeout_s = float(timeout_s)
        self._sleep_s = max(0.0, float(sleep_s))
        self._headers = {"User-Agent": user_agent}

    def fetch(self) -> List[CollectedItem]:
        items: List[CollectedItem] = []
        for subreddit in self._subreddits:
            after: Optional[str] = None
            for _ in range(self._max_pages):
                endpoint, params = self._build_request(subreddit=subreddit, after=after)
                url = f"https://www.reddit.com/r/{subreddit}/{endpoint}"
                payload = _http_get_json(url, params=params, headers=self._headers, timeout_s=self._timeout_s)
                chunk, after = self._parse_listing(payload, subreddit=subreddit)
                items.extend(chunk)
                if not after:
                    break
                if self._sleep_s:
                    time.sleep(self._sleep_s)
        return items

    def _build_request(self, *, subreddit: str, after: Optional[str]) -> Tuple[str, Dict[str, Any]]:
        if self._search_query:
            params: Dict[str, Any] = {
                "q": self._search_query,
                "restrict_sr": 1,
                "sort": "new",
                "t": self._time_filter,
                "limit": self._limit,
            }
            if after:
                params["after"] = after
            return "search.json", params

        params = {"limit": self._limit}
        if after:
            params["after"] = after
        return "new.json", params

    def _parse_listing(
        self, payload: Dict[str, Any], *, subreddit: str
    ) -> Tuple[List[CollectedItem], Optional[str]]:
        data = payload.get("data") or {}
        after = data.get("after")
        children = data.get("children") or []

        items: List[CollectedItem] = []
        for child in children:
            post = (child or {}).get("data") or {}
            permalink = post.get("permalink")
            post_url = f"https://www.reddit.com{permalink}" if permalink else f"reddit:r/{subreddit}"
            title = (post.get("title") or "").strip()
            body = (post.get("selftext") or "").strip()
            text = title if not body else f"{title}\n\n{body}"
            created_utc = post.get("created_utc")
            created_iso = None
            if isinstance(created_utc, (int, float)):
                created_iso = datetime.fromtimestamp(created_utc, tz=timezone.utc).isoformat()

            items.append(
                CollectedItem(
                    text=text,
                    source=post_url,
                    metadata={
                        "platform": "reddit",
                        "subreddit": subreddit,
                        "title": title,
                        "author": post.get("author"),
                        "created_utc": created_utc,
                        "created_iso": created_iso,
                        "score": post.get("score"),
                        "num_comments": post.get("num_comments"),
                        "outbound_url": post.get("url"),
                        "id": post.get("id"),
                    },
                )
            )

        return items, after


class RedditRandomSearchSource:
    def __init__(
        self,
        *,
        subreddits: Sequence[str],
        beach_terms: Sequence[str],
        pollution_terms: Sequence[str],
        california_terms: Sequence[str],
        request_count: int = DEFAULT_RANDOM_MODE_REQUESTS,
        limit_per_request: int = 100,
        time_filter: str = "month",
        user_agent: str = "BeachPollutionCollector/0.1",
        timeout_s: float = 15.0,
        sleep_s: float = DEFAULT_RATE_LIMIT_S,
        seed: Optional[int] = None,
    ) -> None:
        self._subreddits = _normalize_subreddits(subreddits)
        self._beach_terms = [t for t in beach_terms if t and str(t).strip()]
        self._pollution_terms = [t for t in pollution_terms if t and str(t).strip()]
        self._california_terms = [t for t in california_terms if t and str(t).strip()]
        self._request_count = max(1, int(request_count))
        self._limit = max(1, min(int(limit_per_request), 100))
        self._time_filter = time_filter
        self._timeout_s = float(timeout_s)
        self._sleep_s = max(0.0, float(sleep_s))
        self._headers = {"User-Agent": user_agent}
        self._rng = random.Random(seed)

    def fetch(self) -> List[CollectedItem]:
        if not self._subreddits:
            return []

        location_terms = _candidate_location_terms(self._california_terms or DEFAULT_CALIFORNIA_TERMS)
        used: set[Tuple[str, str]] = set()

        items: List[CollectedItem] = []
        for request_index in range(1, self._request_count + 1):
            subreddit = self._rng.choice(self._subreddits)

            query = ""
            for _ in range(10):
                candidate = _generate_random_reddit_query(
                    self._rng,
                    beach_terms=self._beach_terms or DEFAULT_BEACH_TERMS,
                    pollution_terms=self._pollution_terms or DEFAULT_POLLUTION_TERMS,
                    location_terms=location_terms,
                    context_terms=DEFAULT_QUERY_CONTEXT_TERMS,
                )
                key = (subreddit.lower(), candidate.lower())
                if key not in used:
                    query = candidate
                    used.add(key)
                    break
            if not query:
                query = _generate_random_reddit_query(
                    self._rng,
                    beach_terms=self._beach_terms or DEFAULT_BEACH_TERMS,
                    pollution_terms=self._pollution_terms or DEFAULT_POLLUTION_TERMS,
                    location_terms=location_terms,
                    context_terms=DEFAULT_QUERY_CONTEXT_TERMS,
                )

            params: Dict[str, Any] = {
                "q": query,
                "restrict_sr": 1,
                "sort": "new",
                "t": self._time_filter,
                "limit": self._limit,
            }
            url = f"https://www.reddit.com/r/{subreddit}/search.json"

            try:
                payload = _http_get_json(url, params=params, headers=self._headers, timeout_s=self._timeout_s)
            except Exception as exc:
                print(
                    f"[warn] reddit request {request_index}/{self._request_count} failed (r/{subreddit}): {exc}",
                    file=sys.stderr,
                )
                if self._sleep_s:
                    time.sleep(self._sleep_s)
                continue

            chunk, _after = self._parse_listing(payload, subreddit=subreddit, query=query, request_index=request_index)
            items.extend(chunk)

            if self._sleep_s:
                time.sleep(self._sleep_s)

        return items

    def _parse_listing(
        self, payload: Dict[str, Any], *, subreddit: str, query: str, request_index: int
    ) -> Tuple[List[CollectedItem], Optional[str]]:
        data = payload.get("data") or {}
        after = data.get("after")
        children = data.get("children") or []

        items: List[CollectedItem] = []
        for child in children:
            post = (child or {}).get("data") or {}
            permalink = post.get("permalink")
            post_url = f"https://www.reddit.com{permalink}" if permalink else f"reddit:r/{subreddit}"
            title = (post.get("title") or "").strip()
            body = (post.get("selftext") or "").strip()
            text = title if not body else f"{title}\n\n{body}"
            created_utc = post.get("created_utc")
            created_iso = None
            if isinstance(created_utc, (int, float)):
                created_iso = datetime.fromtimestamp(created_utc, tz=timezone.utc).isoformat()

            items.append(
                CollectedItem(
                    text=text,
                    source=post_url,
                    metadata={
                        "platform": "reddit",
                        "mode": "random_search",
                        "request_index": request_index,
                        "query": query,
                        "subreddit": subreddit,
                        "title": title,
                        "author": post.get("author"),
                        "created_utc": created_utc,
                        "created_iso": created_iso,
                        "score": post.get("score"),
                        "num_comments": post.get("num_comments"),
                        "outbound_url": post.get("url"),
                        "id": post.get("id"),
                    },
                )
            )

        return items, after


def _normalize_instance_urls(instances: Sequence[str]) -> List[str]:
    out: List[str] = []
    seen: set[str] = set()
    for raw in instances:
        s = (raw or "").strip()
        if not s:
            continue
        if not re.match(r"^https?://", s, flags=re.IGNORECASE):
            s = "https://" + s
        s = s.rstrip("/")
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


class MastodonPublicTagSource:
    def __init__(
        self,
        *,
        instances: Sequence[str],
        hashtags: Sequence[str],
        request_count: int = 50,
        limit_per_request: int = 40,
        local_only: bool = False,
        user_agent: str = "BeachPollutionCollector/0.1",
        timeout_s: float = 20.0,
        sleep_s: float = DEFAULT_RATE_LIMIT_S,
        seed: Optional[int] = None,
    ) -> None:
        self._instances = _normalize_instance_urls(instances)
        self._hashtags = [h.lstrip("#") for h in (hashtags or []) if h and str(h).strip()]
        self._request_count = max(1, int(request_count))
        self._limit = max(1, min(int(limit_per_request), 40))
        self._local_only = bool(local_only)
        self._timeout_s = float(timeout_s)
        self._sleep_s = max(0.0, float(sleep_s))
        self._headers = {"User-Agent": user_agent}
        self._rng = random.Random(seed)

    def fetch(self) -> List[CollectedItem]:
        if not self._instances or not self._hashtags:
            return []

        items: List[CollectedItem] = []
        used: set[Tuple[str, str]] = set()

        import urllib.parse

        for request_index in range(1, self._request_count + 1):
            instance = self._rng.choice(self._instances)
            hashtag = self._rng.choice(self._hashtags)

            key = (instance.lower(), hashtag.lower())
            if key in used and len(used) < (len(self._instances) * len(self._hashtags)):
                for _ in range(10):
                    instance = self._rng.choice(self._instances)
                    hashtag = self._rng.choice(self._hashtags)
                    key = (instance.lower(), hashtag.lower())
                    if key not in used:
                        break
            used.add(key)

            tag_path = urllib.parse.quote(hashtag, safe="")
            url = f"{instance}/api/v1/timelines/tag/{tag_path}"
            params: Dict[str, Any] = {"limit": self._limit}
            if self._local_only:
                params["local"] = "true"

            try:
                payload = _http_get_json(url, params=params, headers=self._headers, timeout_s=self._timeout_s)
            except Exception as exc:
                print(
                    f"[warn] mastodon request {request_index}/{self._request_count} failed ({instance} #{hashtag}): {exc}",
                    file=sys.stderr,
                )
                if self._sleep_s:
                    time.sleep(self._sleep_s)
                continue

            if isinstance(payload, list):
                for status in payload:
                    item = self._status_to_item(
                        status or {},
                        instance=instance,
                        hashtag=hashtag,
                        request_index=request_index,
                    )
                    if item is not None:
                        items.append(item)

            if self._sleep_s:
                time.sleep(self._sleep_s)

        return items

    def _status_to_item(
        self, status: Dict[str, Any], *, instance: str, hashtag: str, request_index: int
    ) -> Optional[CollectedItem]:
        if isinstance(status.get("reblog"), dict):
            status = status.get("reblog") or status

        status_id = status.get("id")
        url = (status.get("url") or status.get("uri") or "").strip()
        if not url:
            acct = ((status.get("account") or {}).get("acct") or "").strip()
            url = f"{instance}/@{acct}/{status_id}" if acct and status_id else instance

        spoiler = (status.get("spoiler_text") or "").strip()
        content_html = (status.get("content") or "").strip()
        content_text = _html_to_text(content_html)
        text = spoiler if not content_text else (f"{spoiler}\n\n{content_text}" if spoiler else content_text)
        if not text:
            return None

        account = status.get("account") or {}
        tags = status.get("tags") or []
        tag_names = [t.get("name") for t in tags if isinstance(t, dict) and t.get("name")]

        return CollectedItem(
            text=text,
            source=url,
            metadata={
                "platform": "mastodon",
                "instance": instance,
                "mode": "tag_timeline",
                "request_index": request_index,
                "hashtag": hashtag,
                "id": status_id,
                "created_at": status.get("created_at"),
                "language": status.get("language"),
                "acct": account.get("acct"),
                "username": account.get("username"),
                "display_name": account.get("display_name"),
                "replies_count": status.get("replies_count"),
                "reblogs_count": status.get("reblogs_count"),
                "favourites_count": status.get("favourites_count"),
                "tags": tag_names,
            },
        )


def _x_quote(term: str) -> str:
    term = (term or "").strip()
    if not term:
        return ""
    if " " in term:
        return f"\"{term}\""
    return term


def _generate_random_x_query(
    rng: random.Random,
    *,
    beach_terms: Sequence[str],
    pollution_terms: Sequence[str],
    location_terms: Sequence[str],
    context_terms: Sequence[str],
    language: str = "en",
) -> str:
    beach = rng.choice([t for t in beach_terms if t and str(t).strip()] or ["beach"])
    location = rng.choice([t for t in location_terms if t and str(t).strip()] or ["California"])

    pollution = [t for t in pollution_terms if t and str(t).strip()] or ["pollution"]
    pollution_weights = list(pollution)
    for key, weight in (("sewage", 5), ("trash", 4), ("oil", 3), ("contamination", 3), ("pollution", 2), ("polluted", 2)):
        if any(str(t).strip().lower() == key for t in pollution):
            pollution_weights.extend([key] * weight)
    poll = rng.choice(pollution_weights) if pollution_weights else "pollution"

    parts = [_x_quote(str(beach)), _x_quote(str(poll)), _x_quote(str(location))]
    context = [t for t in context_terms if t and str(t).strip()]
    if context and rng.random() < 0.35:
        parts.append(_x_quote(str(rng.choice(context))))
    rng.shuffle(parts)

    lang = (language or "").strip()
    suffix = " -is:retweet"
    if lang:
        suffix += f" lang:{lang}"
    return " ".join([p for p in parts if p]) + suffix


class XRecentSearchSource:
    def __init__(
        self,
        *,
        bearer_token: str,
        request_count: int = 50,
        max_results_per_request: int = 100,
        query: Optional[str] = None,
        language: str = "en",
        beach_terms: Sequence[str] = DEFAULT_BEACH_TERMS,
        pollution_terms: Sequence[str] = DEFAULT_POLLUTION_TERMS,
        california_terms: Sequence[str] = DEFAULT_CALIFORNIA_TERMS,
        user_agent: str = "BeachPollutionCollector/0.1",
        timeout_s: float = 20.0,
        sleep_s: float = DEFAULT_RATE_LIMIT_S,
        seed: Optional[int] = None,
    ) -> None:
        self._bearer = bearer_token.strip()
        self._request_count = max(1, int(request_count))
        self._max_results = max(10, min(int(max_results_per_request), 100))
        self._query = (query or "").strip() or None
        self._language = (language or "").strip()
        self._beach_terms = list(beach_terms)
        self._pollution_terms = list(pollution_terms)
        self._california_terms = list(california_terms)
        self._timeout_s = float(timeout_s)
        self._sleep_s = max(0.0, float(sleep_s))
        self._headers = {
            "User-Agent": user_agent,
            "Authorization": f"Bearer {self._bearer}",
        }
        self._rng = random.Random(seed)

    def fetch(self) -> List[CollectedItem]:
        if not self._bearer:
            return []

        endpoint = "https://api.twitter.com/2/tweets/search/recent"
        location_terms = _candidate_location_terms(self._california_terms or DEFAULT_CALIFORNIA_TERMS)

        items: List[CollectedItem] = []
        used_queries: set[str] = set()
        for request_index in range(1, self._request_count + 1):
            if self._query:
                query = self._query
            else:
                query = ""
                for _ in range(10):
                    candidate = _generate_random_x_query(
                        self._rng,
                        beach_terms=self._beach_terms or DEFAULT_BEACH_TERMS,
                        pollution_terms=self._pollution_terms or DEFAULT_POLLUTION_TERMS,
                        location_terms=location_terms,
                        context_terms=DEFAULT_QUERY_CONTEXT_TERMS,
                        language=self._language,
                    )
                    key = candidate.lower()
                    if key not in used_queries:
                        used_queries.add(key)
                        query = candidate
                        break
                if not query:
                    query = _generate_random_x_query(
                        self._rng,
                        beach_terms=self._beach_terms or DEFAULT_BEACH_TERMS,
                        pollution_terms=self._pollution_terms or DEFAULT_POLLUTION_TERMS,
                        location_terms=location_terms,
                        context_terms=DEFAULT_QUERY_CONTEXT_TERMS,
                        language=self._language,
                    )

            params: Dict[str, Any] = {
                "query": query,
                "max_results": self._max_results,
                "tweet.fields": "created_at,lang,author_id,public_metrics",
                "expansions": "author_id",
                "user.fields": "username,name,location",
            }
            try:
                payload = _http_get_json(endpoint, params=params, headers=self._headers, timeout_s=self._timeout_s)
            except Exception as exc:
                print(
                    f"[warn] x request {request_index}/{self._request_count} failed: {exc}",
                    file=sys.stderr,
                )
                if self._sleep_s:
                    time.sleep(self._sleep_s)
                continue

            users: Dict[str, Dict[str, Any]] = {}
            includes = payload.get("includes") or {}
            for u in includes.get("users") or []:
                if isinstance(u, dict) and u.get("id"):
                    users[str(u["id"])] = u

            for tw in payload.get("data") or []:
                if not isinstance(tw, dict):
                    continue
                tweet_id = tw.get("id")
                text = (tw.get("text") or "").strip()
                if not text or not tweet_id:
                    continue
                author = users.get(str(tw.get("author_id") or ""), {})
                username = (author.get("username") or "").strip()
                url = f"https://x.com/{username}/status/{tweet_id}" if username else f"x:{tweet_id}"
                metrics = tw.get("public_metrics") or {}

                items.append(
                    CollectedItem(
                        text=text,
                        source=url,
                        metadata={
                            "platform": "x",
                            "mode": "recent_search",
                            "request_index": request_index,
                            "query": query,
                            "id": tweet_id,
                            "created_at": tw.get("created_at"),
                            "lang": tw.get("lang"),
                            "author_id": tw.get("author_id"),
                            "author_username": username or None,
                            "author_name": author.get("name"),
                            "author_location": author.get("location"),
                            "like_count": metrics.get("like_count"),
                            "reply_count": metrics.get("reply_count"),
                            "retweet_count": metrics.get("retweet_count"),
                            "quote_count": metrics.get("quote_count"),
                        },
                    )
                )

            if self._sleep_s:
                time.sleep(self._sleep_s)

        return items


class GDELTDocSource:
    def __init__(
        self,
        *,
        query: str,
        max_records: int = 50,
        timeout_s: float = 20.0,
        user_agent: str = "BeachPollutionCollector/0.1",
    ) -> None:
        self._query = query.strip()
        self._max_records = max(1, min(int(max_records), 250))
        self._timeout_s = float(timeout_s)
        self._headers = {"User-Agent": user_agent}

    def fetch(self) -> List[CollectedItem]:
        url = "https://api.gdeltproject.org/api/v2/doc/doc"
        params = {
            "query": self._query,
            "mode": "ArtList",
            "format": "json",
            "maxrecords": self._max_records,
            "sort": "HybridRel",
        }
        payload = _http_get_json(url, params=params, headers=self._headers, timeout_s=self._timeout_s)
        articles = payload.get("articles") or []

        items: List[CollectedItem] = []
        for art in articles:
            art = art or {}
            title = (art.get("title") or "").strip()
            article_url = (art.get("url") or "").strip() or "gdelt"
            seendate = art.get("seendate")
            text = title
            if seendate:
                text = f"{title} ({seendate})"

            items.append(
                CollectedItem(
                    text=text,
                    source=article_url,
                    metadata={
                        "platform": "gdelt",
                        "title": title,
                        "seendate": seendate,
                        "domain": art.get("domain"),
                        "language": art.get("language"),
                        "source_country": art.get("sourceCountry"),
                    },
                )
            )
        return items


def _dedupe(items: Iterable[CollectedItem]) -> List[CollectedItem]:
    seen: set[Tuple[str, str]] = set()
    out: List[CollectedItem] = []
    for item in items:
        key = (item.source, (item.text or "")[:200])
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def run_pipeline(
    *,
    sources: Sequence[object],
    filterer: PollutionBeachFilter,
    max_results: Optional[int] = None,
) -> List[CollectedItem]:
    collected: List[CollectedItem] = []
    for src in sources:
        fetch = getattr(src, "fetch", None)
        if not callable(fetch):
            continue
        try:
            collected.extend(fetch())
        except Exception as exc:
            src_name = getattr(src, "__class__", type(src)).__name__
            print(f"[warn] source {src_name} failed: {exc}", file=sys.stderr)

    filtered = [it for it in collected if filterer.matches(it)]
    filtered = _dedupe(filtered)
    if max_results is not None:
        filtered = filtered[: max(0, int(max_results))]
    return filtered


def _parse_csv_arg(value: str) -> List[str]:
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part and part.strip()]

def _normalize_subreddits(subreddits: Sequence[str]) -> List[str]:
    normalized: List[str] = []
    seen: set[str] = set()
    aliases = {
        "oc": "orangecounty",
        "sf": "sanfrancisco",
        "calforna": "california",
    }
    for raw in subreddits:
        s = (raw or "").strip()
        if not s:
            continue
        s = s[2:] if s.lower().startswith("r/") else s
        s = s.lower()
        s = aliases.get(s, s)
        if s in seen:
            continue
        seen.add(s)
        normalized.append(s)
    return normalized


def _is_regex_like_term(term: str) -> bool:
    term = (term or "").strip()
    if not term:
        return False
    if term.startswith(("(?", r"\b")):
        return True
    return any(ch in term for ch in ("|", "[", "]", "(", ")", "^", "$", "\\"))


def _candidate_location_terms(california_terms: Sequence[str]) -> List[str]:
    out: List[str] = []
    for raw in california_terms:
        term = (raw or "").strip()
        if not term or _is_regex_like_term(term):
            continue
        out.append(term)
    if "california" not in {t.lower() for t in out}:
        out.insert(0, "California")
    return out


def _generate_random_reddit_query(
    rng: random.Random,
    *,
    beach_terms: Sequence[str],
    pollution_terms: Sequence[str],
    location_terms: Sequence[str],
    context_terms: Sequence[str],
) -> str:
    beaches = [t for t in beach_terms if t and str(t).strip()]
    pollution = [t for t in pollution_terms if t and str(t).strip()]
    locations = [t for t in location_terms if t and str(t).strip()]
    context = [t for t in context_terms if t and str(t).strip()]

    beach_weights = [t for t in beaches]
    if any(str(t).strip().lower() == "beach" for t in beaches):
        beach_weights.extend(["beach"] * 6)

    pollution_weights = [t for t in pollution]
    for key, weight in (("sewage", 5), ("trash", 4), ("oil", 3), ("contamination", 3), ("pollution", 2), ("polluted", 2)):
        if any(str(t).strip().lower() == key for t in pollution):
            pollution_weights.extend([key] * weight)

    beach = rng.choice(beach_weights) if beach_weights else "beach"
    poll = rng.choice(pollution_weights) if pollution_weights else "pollution"

    parts = [beach, poll]
    if locations and rng.random() < 0.80:
        parts.append(rng.choice(locations))
    if context and rng.random() < 0.45:
        parts.append(rng.choice(context))

    rng.shuffle(parts)
    return " ".join(parts).strip()


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Collect and filter public posts about polluted CA beaches.")
    parser.add_argument("--output", default="-", help="Output JSON path, or '-' for stdout.")
    parser.add_argument("--sources", default="reddit", help="Comma-separated sources: reddit,mastodon,x,gdelt")
    parser.add_argument("--max-results", type=int, default=200, help="Max filtered results to output.")
    parser.add_argument("--pages", type=int, default=None, help="Convenience: set request/page count for enabled sources.")
    parser.add_argument(
        "--per-request",
        type=int,
        default=None,
        help="Convenience: set per-request limit for enabled sources (clamped per source).",
    )

    parser.add_argument("--beach-terms", default=",".join(DEFAULT_BEACH_TERMS))
    parser.add_argument("--california-terms", default=",".join(DEFAULT_CALIFORNIA_TERMS))
    parser.add_argument("--pollution-terms", default=",".join(DEFAULT_POLLUTION_TERMS))
    parser.add_argument(
        "--strict-california",
        action="store_true",
        help="Require California terms in text (ignore subreddit-based CA inference).",
    )

    parser.add_argument(
        "--reddit-subreddits",
        default=DEFAULT_REDDIT_SUBREDDITS,
        help="Comma-separated list of subreddits to scan.",
    )
    parser.add_argument(
        "--assume-ca-subreddits",
        default=DEFAULT_ASSUME_CA_SUBREDDITS,
        help="Comma-separated list of subreddits treated as California-relevant for filtering.",
    )
    parser.add_argument(
        "--reddit-query",
        default="",
        help="Optional query. If omitted, uses randomized queries across CA-related subreddits.",
    )
    parser.add_argument(
        "--reddit-mode",
        default="auto",
        choices=("auto", "random", "search", "new"),
        help="Reddit collection mode (default: auto = random when no query, else search).",
    )
    parser.add_argument(
        "--reddit-pages",
        type=int,
        default=DEFAULT_RANDOM_MODE_REQUESTS,
        help="Random mode: number of randomized requests. Search/new: pages per subreddit.",
    )
    parser.add_argument("--reddit-limit", type=int, default=100, help="Results per request (max 100).")
    parser.add_argument("--reddit-time-filter", default="month", choices=("day", "week", "month", "year", "all"))
    parser.add_argument(
        "--rate-limit-s",
        type=float,
        default=DEFAULT_RATE_LIMIT_S,
        help="Seconds to sleep between requests (rate limiting).",
    )
    parser.add_argument("--seed", type=int, default=None, help="Optional random seed for reproducible sampling.")
    parser.add_argument("--user-agent", default="BeachPollutionCollector/0.1")

    parser.add_argument("--mastodon-instances", default=DEFAULT_MASTODON_INSTANCES, help="Comma-separated Mastodon instances.")
    parser.add_argument(
        "--mastodon-hashtags",
        default=DEFAULT_MASTODON_HASHTAGS,
        help="Comma-separated hashtags to sample (without '#').",
    )
    parser.add_argument(
        "--mastodon-requests",
        type=int,
        default=DEFAULT_RANDOM_MODE_REQUESTS,
        help="Number of Mastodon requests (tag timeline sampling).",
    )
    parser.add_argument("--mastodon-limit", type=int, default=40, help="Statuses per Mastodon request (max 40).")
    parser.add_argument("--mastodon-local-only", action="store_true", help="Restrict Mastodon sampling to local posts.")

    parser.add_argument("--x-bearer-token", default="", help="X API bearer token (or set X_BEARER_TOKEN env var).")
    parser.add_argument("--x-query", default="", help="Optional X recent-search query. If omitted, random queries are used.")
    parser.add_argument(
        "--x-requests",
        type=int,
        default=DEFAULT_RANDOM_MODE_REQUESTS,
        help="Number of X API requests (recent search).",
    )
    parser.add_argument("--x-max-results", type=int, default=100, help="Tweets per X request (max 100).")
    parser.add_argument("--x-language", default="en", help="Language used in random X query generation (default: en).")

    parser.add_argument(
        "--gdelt-query",
        default='(beach OR coast OR "ocean") (pollution OR polluted OR sewage OR trash OR oil OR contamination) (California OR CA)',
        help="GDELT Doc API query string (used when gdelt is enabled).",
    )
    parser.add_argument("--gdelt-max", type=int, default=50)

    args = parser.parse_args(list(argv) if argv is not None else None)

    raw_source_names = {s.strip().lower() for s in _parse_csv_arg(args.sources)}
    source_aliases = {
        "twitter": "x",
        "x.com": "x",
    }
    source_names = {source_aliases.get(s, s) for s in raw_source_names}
    if not source_names:
        source_names = {"reddit"}

    if args.pages is not None:
        args.reddit_pages = args.pages
        args.mastodon_requests = args.pages
        args.x_requests = args.pages
    if args.per_request is not None:
        args.reddit_limit = args.per_request
        args.mastodon_limit = args.per_request
        args.x_max_results = args.per_request

    supported_sources = {"reddit", "mastodon", "x", "gdelt"}
    unknown_sources = sorted(source_names - supported_sources)
    if unknown_sources:
        print(f"[warn] unknown sources ignored: {', '.join(unknown_sources)}", file=sys.stderr)

    beach_terms = _parse_csv_arg(args.beach_terms)
    california_terms = _parse_csv_arg(args.california_terms)
    pollution_terms = _parse_csv_arg(args.pollution_terms)
    reddit_subs = _parse_csv_arg(args.reddit_subreddits)
    assume_ca_subs = _parse_csv_arg(args.assume_ca_subreddits)
    mastodon_instances = _parse_csv_arg(args.mastodon_instances)
    mastodon_hashtags = _parse_csv_arg(args.mastodon_hashtags)

    filterer = PollutionBeachFilter(
        beach_terms=beach_terms,
        california_terms=california_terms,
        pollution_terms=pollution_terms,
        assume_california_subreddits=assume_ca_subs,
        strict_california=bool(args.strict_california),
    )

    sources: List[object] = []
    if "reddit" in source_names:
        mode = str(args.reddit_mode or "auto").lower()
        query = str(args.reddit_query or "").strip()
        if mode == "auto":
            mode = "search" if query else "random"

        if mode == "random":
            sources.append(
                RedditRandomSearchSource(
                    subreddits=reddit_subs,
                    beach_terms=beach_terms,
                    pollution_terms=pollution_terms,
                    california_terms=california_terms,
                    request_count=args.reddit_pages,
                    limit_per_request=args.reddit_limit,
                    time_filter=args.reddit_time_filter,
                    user_agent=args.user_agent,
                    sleep_s=args.rate_limit_s,
                    seed=args.seed,
                )
            )
        elif mode == "search":
            if not query:
                parser.error("--reddit-query is required when --reddit-mode=search")
            sources.append(
                RedditPublicJSONSource(
                    subreddits=reddit_subs,
                    search_query=query,
                    limit_per_request=args.reddit_limit,
                    max_pages=args.reddit_pages,
                    time_filter=args.reddit_time_filter,
                    user_agent=args.user_agent,
                    sleep_s=args.rate_limit_s,
                )
            )
        elif mode == "new":
            sources.append(
                RedditPublicJSONSource(
                    subreddits=reddit_subs,
                    search_query=None,
                    limit_per_request=args.reddit_limit,
                    max_pages=args.reddit_pages,
                    time_filter=args.reddit_time_filter,
                    user_agent=args.user_agent,
                    sleep_s=args.rate_limit_s,
                )
            )
        else:
            parser.error(f"Unsupported --reddit-mode: {mode}")
    if "mastodon" in source_names:
        sources.append(
            MastodonPublicTagSource(
                instances=mastodon_instances,
                hashtags=mastodon_hashtags,
                request_count=args.mastodon_requests,
                limit_per_request=args.mastodon_limit,
                local_only=bool(args.mastodon_local_only),
                user_agent=args.user_agent,
                sleep_s=args.rate_limit_s,
                seed=args.seed,
            )
        )
    if "x" in source_names:
        bearer = (str(args.x_bearer_token or "").strip() or os.environ.get("X_BEARER_TOKEN") or "").strip()
        if not bearer:
            print("[warn] source x enabled but no X_BEARER_TOKEN provided; skipping.", file=sys.stderr)
        else:
            sources.append(
                XRecentSearchSource(
                    bearer_token=bearer,
                    request_count=args.x_requests,
                    max_results_per_request=args.x_max_results,
                    query=str(args.x_query or "").strip() or None,
                    language=str(args.x_language or "").strip() or "en",
                    beach_terms=beach_terms,
                    pollution_terms=pollution_terms,
                    california_terms=california_terms,
                    user_agent=args.user_agent,
                    sleep_s=args.rate_limit_s,
                    seed=args.seed,
                )
            )
    if "gdelt" in source_names:
        sources.append(GDELTDocSource(query=args.gdelt_query, max_records=args.gdelt_max, user_agent=args.user_agent))

    results = run_pipeline(sources=sources, filterer=filterer, max_results=args.max_results)
    payload = {
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "result_count": len(results),
        "results": [it.to_json() for it in results],
    }

    output_text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False)
    if args.output == "-" or not args.output:
        sys.stdout.write(output_text + "\n")
        return 0

    with open(args.output, "w", encoding="utf-8") as f:
        f.write(output_text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
