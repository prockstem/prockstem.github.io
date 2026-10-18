#!/usr/bin/env python3
"""Extract martial arts techniques from books and rank the top 5 attacks and defenses.

Reads PDF, EPUB and TXT files, sends the text to Claude in chunks to pull out every
technique, merges the results, then asks Claude to pick the top 5 attacks and top 5
defenses for each book. Writes <book>.md and <book>.json per book plus summary.md.

Command line:
    python martial_moves.py BOOK [BOOK ...] [--model MODEL] [--out results]

BOOK can be a file, a folder (every PDF/EPUB/TXT inside it) or a wildcard like
"books/*.pdf". The API key comes from the ANTHROPIC_API_KEY environment variable.

Finished chunks are cached in <out>/.cache, so re-running a book resumes where it
stopped instead of paying for the same chunks again.
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import logging
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Callable

import anthropic

logging.getLogger("pypdf").setLevel(logging.ERROR)

MODELS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]
DEFAULT_MODEL = MODELS[0]
SUPPORTED_EXTS = {".pdf", ".epub", ".txt"}

CHUNK_TOKENS = 12_000          # target size of one chunk sent to Claude
CHARS_PER_TOKEN = 4            # rough estimate, good enough for sizing and display
MIN_CHARS_PER_PAGE = 40        # below this on average, a PDF is probably scanned images
PROMPT_VERSION = "1"           # bump to invalidate cached chunk results

# Models that support server-side refusal fallback (retry on another model if the
# safety classifier declines a chunk). Haiku does not.
FALLBACK_MODELS = {"claude-sonnet-5-5", "claude-opus-5-5"}
FALLBACK_BETA = "server-side-fallback-2026-07-01"


# --------------------------------------------------------------------------- errors

class MartialMovesError(Exception):
    """An error with a message that is safe to show to a non-programmer."""


class BookError(MartialMovesError):
    """This book can't be processed; other books can continue."""


class FatalAPIError(MartialMovesError):
    """Problem with the key or account; no point trying further books."""


class Cancelled(MartialMovesError):
    """The user asked to stop."""


def friendly_api_error(e: Exception) -> MartialMovesError:
    """Translate an Anthropic SDK exception into a plain-English error."""
    msg = str(getattr(e, "message", "") or e)
    low = msg.lower()
    status = getattr(e, "status_code", None)
    if isinstance(e, anthropic.AuthenticationError):
        return FatalAPIError("Your API key was rejected. Check that you copied the whole key "
                             "(it starts with sk-ant-) and that it hasn't been deleted in the Claude Console.")
    if status == 402 or "credit balance" in low or "billing" in low:
        return FatalAPIError("Your Anthropic account is out of credit. Add credit under "
                             "Billing in the Claude Console (platform.claude.com), then try again.")
    if isinstance(e, anthropic.PermissionDeniedError):
        return FatalAPIError(f"This key isn't allowed to do that: {msg}")
    if isinstance(e, anthropic.NotFoundError):
        return FatalAPIError("That model isn't available to your account. Pick another model in Settings.")
    if isinstance(e, anthropic.RateLimitError):
        return MartialMovesError("Claude's rate limit was hit too many times in a row. Wait a minute and run again; "
                                 "finished chunks are saved.")
    if isinstance(e, anthropic.RequestTooLargeError):
        return BookError("A chunk of this book was too large for the API.")
    if isinstance(e, (anthropic.InternalServerError, anthropic.OverloadedError)) or (status or 0) >= 500:
        return MartialMovesError("Claude's servers are busy or having trouble right now. Try again in a few minutes; "
                                 "finished chunks are saved.")
    if isinstance(e, anthropic.APIConnectionError):
        return MartialMovesError("Couldn't reach the Claude API. Check your internet connection.")
    if isinstance(e, anthropic.BadRequestError):
        return BookError(f"Claude rejected the request: {msg}")
    return MartialMovesError(f"Unexpected API error: {msg}")


# --------------------------------------------------------------------------- extract

def extract(path: str | Path) -> dict:
    """Read a book into units (pages for PDF, sections for EPUB/TXT).

    Returns {"name", "kind", "unit_label", "units": [{"ref", "text"}], "scanned"}.
    Raises BookError if the file can't be read.
    """
    path = Path(path)
    ext = path.suffix.lower()
    if ext not in SUPPORTED_EXTS:
        raise BookError("Unsupported file type (use PDF, EPUB or TXT).")
    try:
        if ext == ".pdf":
            units, label = _extract_pdf(path), "pages"
        elif ext == ".epub":
            units, label = _extract_epub(path), "sections"
        else:
            units, label = _extract_txt(path), "sections"
    except BookError:
        raise
    except Exception as e:  # corrupt / encrypted / not really that format
        raise BookError(f"Couldn't read the file ({type(e).__name__}: {e}). "
                        "It may be damaged, password-protected or not really a "
                        f"{ext[1:].upper()} file.") from e

    total_chars = sum(len(u["text"]) for u in units)
    scanned = ext == ".pdf" and bool(units) and total_chars / len(units) < MIN_CHARS_PER_PAGE
    return {"name": path.name, "kind": ext[1:], "unit_label": label,
            "units": units, "scanned": scanned, "chars": total_chars}


def _extract_pdf(path: Path) -> list[dict]:
    from pypdf import PdfReader
    reader = PdfReader(str(path))
    if reader.is_encrypted:
        try:
            reader.decrypt("")
        except Exception:
            raise BookError("The PDF is password-protected.")
    units = []
    for i, page in enumerate(reader.pages, 1):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        units.append({"ref": f"p. {i}", "text": _clean(text)})
    return units


def _extract_epub(path: Path) -> list[dict]:
    import warnings
    import ebooklib
    from ebooklib import epub
    from bs4 import BeautifulSoup
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        book = epub.read_epub(str(path), {"ignore_ncx": True})
    # Reading order comes from the spine; fall back to file order if it's missing.
    docs = [book.get_item_with_id(idref) for idref, _ in book.spine]
    docs = [d for d in docs if d is not None and d.get_type() == ebooklib.ITEM_DOCUMENT]
    if not docs:
        docs = list(book.get_items_of_type(ebooklib.ITEM_DOCUMENT))
    units = []
    for n, item in enumerate((d for d in docs if not isinstance(d, epub.EpubNav)), 1):
        soup = BeautifulSoup(item.get_content(), "html.parser")
        if soup.find("nav"):  # table of contents page
            continue
        heading = soup.find(["h1", "h2", "h3"])
        title = heading.get_text(" ", strip=True) if heading else ""
        text = _clean(soup.get_text("\n"))
        if not text:
            continue
        ref = f"§{n}" + (f" {title[:60]}" if title else "")
        units.append({"ref": ref, "text": text})
    return units


def _extract_txt(path: Path) -> list[dict]:
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    # Split on blank-line paragraphs, then group into ~3000-character sections.
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    units, buf = [], []
    for p in paras:
        buf.append(p)
        if sum(len(b) for b in buf) > 3000:
            units.append(buf)
            buf = []
    if buf:
        units.append(buf)
    return [{"ref": f"§{i}", "text": _clean("\n\n".join(u))} for i, u in enumerate(units, 1)]


def _clean(text: str) -> str:
    text = text.replace("\x00", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def estimate_tokens(text_or_chars) -> int:
    n = text_or_chars if isinstance(text_or_chars, int) else len(text_or_chars)
    return max(1, n // CHARS_PER_TOKEN) if n else 0


def inspect_book(path: str | Path) -> dict:
    """Quick look at a book for the upload table: counts, tokens, scanned warning."""
    try:
        info = extract(path)
    except BookError as e:
        return {"name": Path(path).name, "ok": False, "error": str(e)}
    units = info["units"]
    if info["scanned"] or info["chars"] == 0:
        warn = ("Looks like a scanned PDF (no text layer). Run it through OCR first "
                "(e.g. Adobe Acrobat 'Recognize Text' or the free ocrmypdf), then upload the result."
                if info["kind"] == "pdf" else "No readable text found in this file.")
        return {"name": info["name"], "ok": False, "units": len(units), "unit_label": info["unit_label"],
                "tokens": estimate_tokens(info["chars"]), "error": warn}
    return {"name": info["name"], "ok": True, "units": len(units), "unit_label": info["unit_label"],
            "tokens": estimate_tokens(info["chars"]), "error": ""}


# --------------------------------------------------------------------------- prefilter / chunk

TECHNIQUE_WORDS = re.compile(
    r"\b(strike|strikes|punch|kick|block|parry|throw|sweep|lock|hold|choke|grab|grip|stance|"
    r"elbow|knee|palm|fist|counter|escape|evade|dodge|deflect|attack|defen[cs]e|guard|"
    r"opponent|technique|kata|form|takedown|joint|wrist|thrust|cut|slash|disarm|footwork|"
    r"uke|tori|nage|waza|tsuki|geri|uke|osae|shime|kansetsu|seize|trap|hook|uppercut|jab)\b",
    re.IGNORECASE)
FRONT_MATTER = re.compile(
    r"\b(copyright|all rights reserved|isbn|table of contents|acknowledg|index|bibliography|"
    r"about the author|printed in)\b", re.IGNORECASE)


def prefilter(units: list[dict]) -> list[dict]:
    """Drop units that clearly hold no techniques (blank pages, copyright, index...).

    Keeps a unit if it mentions technique vocabulary. If filtering would drop
    everything, returns the non-empty units unchanged.
    """
    nonempty = [u for u in units if len(u["text"]) >= 80]
    kept = []
    for u in nonempty:
        hits = len(TECHNIQUE_WORDS.findall(u["text"]))
        if hits == 0:
            continue
        if FRONT_MATTER.search(u["text"][:400]) and hits < 3:
            continue
        kept.append(u)
    return kept or nonempty


def chunk(units: list[dict], max_tokens: int | None = None) -> list[dict]:
    """Group units into chunks of about max_tokens. Each unit keeps its [ref] marker."""
    limit = (max_tokens or CHUNK_TOKENS) * CHARS_PER_TOKEN
    chunks, parts, size, refs = [], [], 0, []

    def flush():
        if parts:
            chunks.append({"text": "\n\n".join(parts), "refs": refs[:]})
            parts.clear()
            refs.clear()

    for u in units:
        text = u["text"]
        # Split very long units so one page/section can't blow past the limit.
        pieces = [text[i:i + limit] for i in range(0, len(text), limit)] or [""]
        for piece in pieces:
            block = f"[{u['ref']}]\n{piece}"
            if size + len(block) > limit and parts:
                flush()
                size = 0
            parts.append(block)
            refs.append(u["ref"])
            size += len(block)
    flush()
    return chunks


# --------------------------------------------------------------------------- prompts & tools

EXTRACT_SYSTEM = """You are an expert martial arts instructor and technical editor. You read \
excerpts from martial arts books and catalogue every distinct technique they teach or describe.

Rules:
- A technique is a specific, repeatable move: a strike, kick, throw, sweep, lock, choke, block, \
parry, evasion, escape, counter, disarm or similar. Stances, warm-ups, philosophy and history are \
not techniques unless the text teaches them as a combat move.
- Classify each technique as "attack" (initiates offence on the opponent), "defense" (blocks, \
evades, escapes or neutralises an attack; counters that start from a defense count as defense) \
or "other".
- Use the book's own name for the move. Put translations and alternate names in aliases.
- refs: the [page/section] markers from the excerpt where the technique appears, exactly as written \
inside the brackets (for example "p. 12").
- emphasis: 1-5, how much weight this excerpt gives the technique (5 = taught in detail, called \
fundamental or recommended; 1 = passing mention).
- Report only what the excerpt supports. If there are no techniques, return an empty list.
Always answer by calling the record_techniques tool exactly once."""

EXTRACT_USER = """Book: {book}
Excerpt {i} of {n}:

<excerpt>
{text}
</excerpt>

Catalogue every technique in this excerpt by calling record_techniques."""

EXTRACT_TOOL = {
    "name": "record_techniques",
    "description": "Record every martial arts technique found in the excerpt.",
    "strict": True,
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["techniques"],
        "properties": {
            "techniques": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["name", "aliases", "category", "summary", "refs", "emphasis"],
                    "properties": {
                        "name": {"type": "string"},
                        "aliases": {"type": "array", "items": {"type": "string"}},
                        "category": {"type": "string", "enum": ["attack", "defense", "other"]},
                        "summary": {"type": "string", "description": "One or two sentences: how it is done."},
                        "refs": {"type": "array", "items": {"type": "string"}},
                        "emphasis": {"type": "integer", "description": "1-5"},
                    },
                },
            }
        },
    },
}

RANK_SYSTEM = """You are an expert martial arts instructor. You are given the full catalogue of \
techniques extracted from one book, with how often and how strongly the book emphasises each. \
Choose the five most important attacks and the five most important defenses in this book.

Judge importance by: how much the book itself stresses the move (detail, repetition, being called \
fundamental), how widely it is applicable, and how effective it is in practice. Merge entries that are \
clearly the same move under different names. If the book has fewer than five of a kind, return only \
what exists. Every move you return must come from the catalogue; keep its page/section refs.
Always answer by calling the record_rankings tool exactly once."""

RANK_USER = """Book: {book}

Technique catalogue (JSON):
{catalogue}

Pick the top 5 attacks and top 5 defenses and call record_rankings."""

_RANKED_MOVE = {
    "type": "object",
    "additionalProperties": False,
    "required": ["rank", "name", "aliases", "summary", "why", "refs"],
    "properties": {
        "rank": {"type": "integer"},
        "name": {"type": "string"},
        "aliases": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string", "description": "How the move is performed, 1-3 sentences."},
        "why": {"type": "string", "description": "Why it earns this rank, 1-2 sentences."},
        "refs": {"type": "array", "items": {"type": "string"}},
    },
}

RANK_TOOL = {
    "name": "record_rankings",
    "description": "Record the top 5 attacks and top 5 defenses for the book.",
    "strict": True,
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["attacks", "defenses"],
        "properties": {
            "attacks": {"type": "array", "items": _RANKED_MOVE},
            "defenses": {"type": "array", "items": _RANKED_MOVE},
        },
    },
}


# --------------------------------------------------------------------------- API

def make_client(api_key: str | None = None) -> anthropic.Anthropic:
    # Our own loop in call_tool handles rate limits with logging, so keep SDK retries low.
    return anthropic.Anthropic(api_key=api_key, max_retries=2, timeout=600)


def _create(client, model: str, **kwargs):
    if model in FALLBACK_MODELS:
        return client.beta.messages.create(model=model, betas=[FALLBACK_BETA], fallbacks="default", **kwargs)
    return client.messages.create(model=model, **kwargs)


def test_key(api_key: str, model: str = DEFAULT_MODEL) -> str:
    """Make one tiny API call. Returns "" on success or a friendly error message."""
    if not api_key or not api_key.strip():
        return "Enter an API key first."
    try:
        make_client(api_key.strip()).messages.create(
            model=model, max_tokens=64, messages=[{"role": "user", "content": "Reply with OK."}])
        return ""
    except anthropic.APIError as e:
        return str(friendly_api_error(e))
    except Exception as e:
        return f"Unexpected error: {e}"


def call_tool(client, model: str, system: str, user: str, tool: dict, *,
              max_tokens: int = 16_000, log: Callable[[str], None] = print,
              should_cancel: Callable[[], bool] = lambda: False, max_attempts: int = 8) -> dict | None:
    """Ask Claude to answer by calling `tool`; return the tool input dict.

    Retries rate limits and overloads with backoff (logging each wait). Returns None
    if the model declined (refusal). Raises a MartialMovesError subclass otherwise.
    """
    messages = [{"role": "user", "content": user}]
    nudged = False
    for attempt in range(1, max_attempts + 1):
        if should_cancel():
            raise Cancelled("Cancelled.")
        try:
            resp = _create(client, model, max_tokens=max_tokens, system=system,
                           tools=[tool], tool_choice={"type": "auto"}, messages=messages)
        except (anthropic.RateLimitError, anthropic.OverloadedError, anthropic.InternalServerError,
                anthropic.APIConnectionError) as e:
            if attempt == max_attempts:
                raise friendly_api_error(e) from e
            wait = _retry_after(e) or min(60, 2 ** attempt) + random.uniform(0, 1)
            kind = "Rate limited" if isinstance(e, anthropic.RateLimitError) else "API busy/unreachable"
            log(f"  {kind}; retrying in {wait:.0f}s (attempt {attempt}/{max_attempts})...")
            _sleep(wait, should_cancel)
            continue
        except anthropic.APIError as e:
            raise friendly_api_error(e) from e

        if resp.stop_reason == "refusal":
            return None
        for block in resp.content:
            if getattr(block, "type", None) == "tool_use" and block.name == tool["name"]:
                data = block.input
                return json.loads(data) if isinstance(data, str) else data
        if resp.stop_reason == "max_tokens":
            raise BookError("Claude's answer for one chunk was cut off (too many techniques at once).")
        if nudged:
            raise BookError("Claude didn't return results in the expected format.")
        # Model answered in text instead of calling the tool: ask once more.
        messages = messages + [
            {"role": "assistant", "content": resp.content},
            {"role": "user", "content": f"Please give your answer by calling the {tool['name']} tool."},
        ]
        nudged = True
    raise MartialMovesError("Gave up after repeated API errors.")


def _retry_after(e) -> float | None:
    try:
        v = e.response.headers.get("retry-after")
        return float(v) + 0.5 if v else None
    except Exception:
        return None


def _sleep(seconds: float, should_cancel: Callable[[], bool]):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if should_cancel():
            raise Cancelled("Cancelled.")
        time.sleep(min(0.5, end - time.monotonic()))


# --------------------------------------------------------------------------- merge & rank

def _norm(name: str) -> str:
    name = name.lower()
    name = re.sub(r"\(.*?\)", " ", name)
    name = re.sub(r"[^a-z0-9]+", " ", name)
    return " ".join(w for w in name.split() if w not in {"the", "a", "an"})


def merge_local(chunk_results: list[list[dict]]) -> list[dict]:
    """Merge per-chunk technique lists: same name or alias -> one entry.

    Adds `mentions` (how many chunks) and keeps the highest emphasis.
    """
    merged: list[dict] = []
    index: dict[str, dict] = {}
    for techniques in chunk_results:
        for t in techniques or []:
            name = (t.get("name") or "").strip()
            if not name:
                continue
            keys = {_norm(name)} | {_norm(a) for a in t.get("aliases", []) if a.strip()}
            keys.discard("")
            entry = next((index[k] for k in keys if k in index), None)
            if entry is None:
                entry = {"name": name, "aliases": [], "category": t.get("category", "other"),
                         "summary": t.get("summary", ""), "refs": [], "emphasis": 0, "mentions": 0}
                merged.append(entry)
            entry["mentions"] += 1
            entry["emphasis"] = max(entry["emphasis"], int(t.get("emphasis") or 1))
            if len(t.get("summary", "")) > len(entry["summary"]):
                entry["summary"] = t["summary"]
            if entry["category"] == "other" and t.get("category") in ("attack", "defense"):
                entry["category"] = t["category"]
            for a in [name] + list(t.get("aliases", [])):
                if a and a != entry["name"] and a not in entry["aliases"]:
                    entry["aliases"].append(a)
            for r in t.get("refs", []):
                if r not in entry["refs"]:
                    entry["refs"].append(r)
            for k in keys:
                index.setdefault(k, entry)
    merged.sort(key=lambda e: (-e["emphasis"] * e["mentions"], e["name"]))
    return merged


def _fallback_rank(merged: list[dict]) -> dict:
    """Rank locally if Claude declines the ranking call."""
    out = {}
    for cat, key in (("attack", "attacks"), ("defense", "defenses")):
        picks = [m for m in merged if m["category"] == cat][:5]
        out[key] = [{"rank": i, "name": m["name"], "aliases": m["aliases"], "summary": m["summary"],
                     "why": f"Mentioned in {m['mentions']} part(s) of the book with emphasis {m['emphasis']}/5.",
                     "refs": m["refs"]} for i, m in enumerate(picks, 1)]
    return out


# --------------------------------------------------------------------------- reports

def md_report(result: dict) -> str:
    """Markdown report for one book result."""
    lines = [f"# {result['book']}", "",
             f"Model: {result.get('model', '')} · {result.get('technique_count', 0)} techniques found · "
             f"{result.get('chunks', 0)} chunks", ""]
    for title, key in (("Top 5 Attacks", "attacks"), ("Top 5 Defenses", "defenses")):
        lines += [f"## {title}", ""]
        moves = result.get(key) or []
        if not moves:
            lines += ["_None found in this book._", ""]
        for m in moves:
            lines.append(f"### {m['rank']}. {m['name']}")
            if m.get("aliases"):
                lines.append(f"*Also called:* {', '.join(m['aliases'])}  ")
            lines.append(f"{m.get('summary', '')}  ")
            lines.append(f"**Why it ranks:** {m.get('why', '')}  ")
            if m.get("refs"):
                lines.append(f"**Where:** {', '.join(m['refs'])}")
            lines.append("")
    return "\n".join(lines)


def summary_md(results: list[dict]) -> str:
    lines = ["# Martial Moves summary", ""]
    for r in sorted(results, key=lambda r: r["book"].lower()):
        lines += [f"## {r['book']}", ""]
        for title, key in (("Attacks", "attacks"), ("Defenses", "defenses")):
            names = [f"{m['rank']}. {m['name']}" for m in r.get(key) or []]
            lines.append(f"**{title}:** " + ("; ".join(names) if names else "none found"))
            lines.append("")
    return "\n".join(lines)


def safe_stem(name: str) -> str:
    stem = Path(name).stem
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", stem).strip(" .")  # Windows-safe
    return stem or "book"


def load_results(out_dir: str | Path) -> list[dict]:
    """Load every book result JSON previously written to out_dir."""
    out = []
    for p in sorted(Path(out_dir).glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(data, dict) and "attacks" in data and "book" in data:
            data["_json_path"] = str(p)
            out.append(data)
    return out


def write_summary(out_dir: str | Path) -> Path:
    path = Path(out_dir) / "summary.md"
    path.write_text(summary_md(load_results(out_dir)), encoding="utf-8")
    return path


# --------------------------------------------------------------------------- pipeline

def _cli_progress(event: dict):
    if event["type"] == "log":
        print(event["msg"], flush=True)


def process_book(path: str | Path, client, model: str = DEFAULT_MODEL, out_dir: str | Path = "results",
                 progress: Callable[[dict], None] = _cli_progress,
                 should_cancel: Callable[[], bool] = lambda: False,
                 display_name: str | None = None) -> dict:
    """Extract, rank and write reports for one book. Returns the result dict.

    progress receives events:
      {"type": "log", "msg": str}
      {"type": "chunks", "done": int, "total": int}
    Raises BookError / FatalAPIError / Cancelled / MartialMovesError.
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    name = display_name or Path(path).name

    def log(msg):
        progress({"type": "log", "msg": msg})

    log(f"== {name}")
    info = extract(path)
    if info["scanned"] or info["chars"] == 0:
        raise BookError("No text found. If it is a scanned PDF it needs OCR first.")
    units = prefilter(info["units"])
    chunks = chunk(units)
    log(f"  {len(info['units'])} {info['unit_label']}, {len(units)} kept after prefilter, "
        f"{len(chunks)} chunk(s), ~{estimate_tokens(info['chars']):,} tokens")

    book_hash = hashlib.sha256("".join(u["text"] for u in info["units"]).encode()).hexdigest()[:16]
    cache_dir = out_dir / ".cache" / f"{book_hash}-{model}"
    cache_dir.mkdir(parents=True, exist_ok=True)

    progress({"type": "chunks", "done": 0, "total": len(chunks)})
    chunk_results = []
    for i, c in enumerate(chunks, 1):
        key = hashlib.sha256((PROMPT_VERSION + c["text"]).encode()).hexdigest()[:16]
        cache_file = cache_dir / f"chunk_{i:04d}_{key}.json"
        if cache_file.exists():
            chunk_results.append(json.loads(cache_file.read_text(encoding="utf-8")))
            log(f"  chunk {i}/{len(chunks)}: cached")
        else:
            log(f"  chunk {i}/{len(chunks)}: extracting ({c['refs'][0]} - {c['refs'][-1]})...")
            data = call_tool(client, model, EXTRACT_SYSTEM,
                             EXTRACT_USER.format(book=name, i=i, n=len(chunks), text=c["text"]),
                             EXTRACT_TOOL, log=log, should_cancel=should_cancel)
            if data is None:
                log(f"  chunk {i}/{len(chunks)}: Claude declined this excerpt; skipping it.")
                techniques = []
            else:
                techniques = data.get("techniques", [])
                log(f"  chunk {i}/{len(chunks)}: {len(techniques)} technique(s)")
            cache_file.write_text(json.dumps(techniques, ensure_ascii=False), encoding="utf-8")
            chunk_results.append(techniques)
        progress({"type": "chunks", "done": i, "total": len(chunks)})

    merged = merge_local(chunk_results)
    if not any(m["category"] in ("attack", "defense") for m in merged):
        raise BookError("No attack or defense techniques were found in this book.")
    log(f"  {len(merged)} unique technique(s); ranking top 5 attacks and defenses...")

    catalogue = json.dumps([{k: m[k] for k in ("name", "aliases", "category", "summary", "refs",
                                               "emphasis", "mentions")}
                            for m in merged if m["category"] in ("attack", "defense")],
                           ensure_ascii=False)
    ranked = call_tool(client, model, RANK_SYSTEM, RANK_USER.format(book=name, catalogue=catalogue),
                       RANK_TOOL, log=log, should_cancel=should_cancel)
    if ranked is None:
        log("  Claude declined the ranking step; ranking by how much the book stresses each move instead.")
        ranked = _fallback_rank(merged)

    result = {
        "book": name, "model": model, "chunks": len(chunks), "technique_count": len(merged),
        "attacks": sorted(ranked.get("attacks", []), key=lambda m: m.get("rank", 99))[:5],
        "defenses": sorted(ranked.get("defenses", []), key=lambda m: m.get("rank", 99))[:5],
        "all_techniques": merged,
    }
    stem = safe_stem(name)
    (out_dir / f"{stem}.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    (out_dir / f"{stem}.md").write_text(md_report(result), encoding="utf-8")
    log(f"  wrote {stem}.md and {stem}.json")
    return result


# --------------------------------------------------------------------------- CLI

def expand_inputs(args: list[str]) -> list[Path]:
    """Expand folders and wildcards (Windows cmd doesn't expand * for us)."""
    paths: list[Path] = []
    for a in args:
        p = Path(a)
        if p.is_dir():
            paths += sorted(q for q in p.iterdir() if q.suffix.lower() in SUPPORTED_EXTS)
        elif any(ch in a for ch in "*?["):
            paths += sorted(Path(m) for m in glob.glob(a) if Path(m).suffix.lower() in SUPPORTED_EXTS)
        else:
            paths.append(p)
    return paths


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Rank the top 5 attacks and defenses in martial arts books.")
    ap.add_argument("books", nargs="+", help="PDF/EPUB/TXT files, folders or wildcards")
    ap.add_argument("--model", default=DEFAULT_MODEL, choices=MODELS)
    ap.add_argument("--out", default="results", help="output folder (default: results)")
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):   # don't crash printing odd titles to a Windows console
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Set the ANTHROPIC_API_KEY environment variable first.", file=sys.stderr)
        return 2
    books = expand_inputs(args.books)
    if not books:
        print("No PDF/EPUB/TXT files found.", file=sys.stderr)
        return 2

    client = make_client()
    failed = 0
    for path in books:
        if not path.exists():
            print(f"!! {path}: file not found", file=sys.stderr)
            failed += 1
            continue
        try:
            process_book(path, client, args.model, args.out)
        except FatalAPIError as e:
            print(f"!! {e}", file=sys.stderr)
            return 1
        except MartialMovesError as e:
            print(f"!! {path.name}: {e}", file=sys.stderr)
            failed += 1
        except KeyboardInterrupt:
            print("\nStopped. Finished chunks are cached; run again to resume.", file=sys.stderr)
            return 130
    print(f"Summary: {write_summary(args.out)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
