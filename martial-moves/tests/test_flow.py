"""End-to-end tests with the Claude API mocked. Run:  python -m unittest discover tests -v"""

import json
import os
import re
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import anthropic  # noqa: E402
import httpx2  # noqa: E402

import martial_moves as mm  # noqa: E402

SAMPLES = ROOT / "samples"
KARATE = SAMPLES / "Basic Karate Handbook.pdf"
JUDO = SAMPLES / "Judo Basics.epub"
SCANNED = SAMPLES / "Scanned Example (needs OCR).pdf"

# What the fake Claude "recognises": pattern -> (name, alias, category)
KNOWN = {
    r"straight punch": ("Straight punch", "oi-zuki", "attack"),
    r"reverse punch": ("Reverse punch", "gyaku-zuki", "attack"),
    r"front kick": ("Front kick", "mae-geri", "attack"),
    r"roundhouse kick": ("Roundhouse kick", "mawashi-geri", "attack"),
    r"side kick": ("Side kick", "yoko-geri", "attack"),
    r"elbow strike": ("Elbow strike", "empi-uchi", "attack"),
    r"rising block": ("Rising block", "age-uke", "defense"),
    r"outside block": ("Outside block", "soto-uke", "defense"),
    r"downward block": ("Downward block", "gedan-barai", "defense"),
    r"body shifting": ("Body shifting", "tai-sabaki", "defense"),
    r"knife-hand block": ("Knife-hand block", "shuto-uke", "defense"),
    r"major outer reap": ("Major outer reap", "osoto-gari", "attack"),
    r"hip throw": ("Hip throw", "o-goshi", "attack"),
    r"shoulder throw": ("Shoulder throw", "seoi-nage", "attack"),
    r"arm lock": ("Cross arm lock", "juji-gatame", "attack"),
    r"naked choke": ("Naked choke", "hadaka-jime", "attack"),
    r"scarf hold": ("Scarf hold", "kesa-gatame", "other"),
    r"breakfalls": ("Breakfall", "ukemi", "defense"),
    r"bridge and roll": ("Bridge and roll escape", "upa", "defense"),
    r"hip block": ("Hip block", "", "defense"),
    r"grip breaking": ("Grip breaking", "", "defense"),
    r"sprawling": ("Sprawl", "", "defense"),
}


def fake_extract(text):
    found = {}
    for m in re.finditer(r"\[([^\]]+)\]\n(.*?)(?=\n\n\[|\Z)", text, re.S):
        ref, body = m.group(1), m.group(2).lower()
        for pat, (name, alias, cat) in KNOWN.items():
            if re.search(pat, body):
                t = found.setdefault(name, {"name": name, "aliases": [alias] if alias else [], "category": cat,
                                            "summary": f"How to do the {name.lower()}.", "refs": [],
                                            "emphasis": 5 if "fundamental" in body else 3})
                t["refs"].append(ref)
    return {"techniques": list(found.values())}


def fake_rank(text):
    cat = json.loads(text.split("Technique catalogue (JSON):\n", 1)[1].rsplit("\n\nPick the top", 1)[0])
    out = {}
    for c, key in (("attack", "attacks"), ("defense", "defenses")):
        picks = [t for t in cat if t["category"] == c][:5]
        out[key] = [{"rank": i, "name": t["name"], "aliases": t["aliases"], "summary": t["summary"],
                     "why": "Stressed by the book.", "refs": t["refs"]} for i, t in enumerate(picks, 1)]
    return out


def response(tool_name=None, data=None, stop="tool_use", text=None):
    content = []
    if text:
        content.append(SimpleNamespace(type="text", text=text))
    if tool_name:
        content.append(SimpleNamespace(type="tool_use", name=tool_name, input=data, id="tu_1"))
    return SimpleNamespace(stop_reason=stop, content=content)


class FakeClient:
    """Stands in for anthropic.Anthropic. `script` can inject errors/refusals per call."""

    def __init__(self, script=None):
        self.calls = []
        self.script = list(script or [])
        self.messages = SimpleNamespace(create=self._create)
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kw):
        self.calls.append(kw)
        if self.script:
            action = self.script.pop(0)
            if isinstance(action, Exception):
                raise action
            if action is not None:
                return action
        tool = kw["tools"][0]["name"] if kw.get("tools") else None
        assert kw.get("tool_choice", {}).get("type") in (None, "auto"), "forced tool_choice 400s on 5.5 models"
        user = kw["messages"][0]["content"]
        if tool == "record_techniques":
            return response(tool, fake_extract(user))
        if tool == "record_rankings":
            return response(tool, fake_rank(user))
        return response(text="OK", stop="end_turn")

    def count(self, tool):
        return sum(1 for c in self.calls if c.get("tools") and c["tools"][0]["name"] == tool)


def api_error(cls, status, message):
    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls(message, response=httpx2.Response(status, request=req), body=None)


class FlowTests(unittest.TestCase):
    def setUp(self):
        self.out = Path(tempfile.mkdtemp())
        self.logs = []
        self.chunk_events = []
        p = mock.patch.object(mm, "_sleep", lambda s, c: None)
        p.start()
        self.addCleanup(p.stop)
        self.addCleanup(shutil.rmtree, self.out, True)

    def progress(self, e):
        if e["type"] == "log":
            self.logs.append(e["msg"])
        else:
            self.chunk_events.append((e["done"], e["total"]))

    def run_book(self, path, client, **kw):
        return mm.process_book(path, client, "claude-sonnet-5-5", self.out, progress=self.progress, **kw)

    def test_pdf_and_epub_end_to_end(self):
        client = FakeClient()
        for book, attack, defense in ((KARATE, "Straight punch", "Rising block"),
                                      (JUDO, "Major outer reap", "Breakfall")):
            r = self.run_book(book, client)
            self.assertIn(attack, [m["name"] for m in r["attacks"]])
            self.assertEqual([m["rank"] for m in r["attacks"]], list(range(1, len(r["attacks"]) + 1)))
            self.assertIn(defense, [m["name"] for m in r["defenses"]])
            self.assertLessEqual(len(r["attacks"]), 5)
            self.assertTrue(all(m["refs"] for m in r["attacks"] + r["defenses"]))
            stem = mm.safe_stem(book.name)
            self.assertTrue((self.out / f"{stem}.md").exists())
            md = (self.out / f"{stem}.md").read_text(encoding="utf-8")
            self.assertIn("## Top 5 Attacks", md)
            self.assertIn("**Why it ranks:**", md)
        karate = json.loads((self.out / "Basic Karate Handbook.json").read_text(encoding="utf-8"))
        punch = next(m for m in karate["attacks"] if m["name"] == "Straight punch")
        self.assertEqual(punch["refs"], ["p. 2"])
        self.assertIn("oi-zuki", punch["aliases"])
        judo = json.loads((self.out / "Judo Basics.json").read_text(encoding="utf-8"))
        self.assertTrue(judo["attacks"][0]["refs"][0].startswith("§"))
        self.assertEqual(self.chunk_events[-1][0], self.chunk_events[-1][1])
        summary = mm.write_summary(self.out).read_text(encoding="utf-8")
        self.assertIn("Basic Karate Handbook.pdf", summary)
        self.assertIn("Judo Basics.epub", summary)
        self.assertEqual(len(mm.load_results(self.out)), 2)
        # Sonnet/Opus use the beta endpoint with server-side refusal fallback.
        self.assertEqual(client.calls[0]["fallbacks"], "default")

    def test_cache_resumes_finished_chunks(self):
        with mock.patch.object(mm, "CHUNK_TOKENS", 100):   # force several chunks
            c1 = FakeClient()
            self.run_book(KARATE, c1)
            n = c1.count("record_techniques")
            self.assertGreater(n, 1)
            c2 = FakeClient()
            self.run_book(KARATE, c2)
            self.assertEqual(c2.count("record_techniques"), 0)
            self.assertTrue(any("cached" in l for l in self.logs))

    def test_cancel_then_resume(self):
        with mock.patch.object(mm, "CHUNK_TOKENS", 100):
            client = FakeClient()
            with self.assertRaises(mm.Cancelled):
                self.run_book(KARATE, client, should_cancel=lambda: client.count("record_techniques") >= 1)
            self.assertEqual(client.count("record_techniques"), 1)   # stopped after the current call
            c2 = FakeClient()
            r = self.run_book(KARATE, c2)
            total = mm.chunk(mm.prefilter(mm.extract(KARATE)["units"]))
            self.assertEqual(c2.count("record_techniques"), len(total) - 1)
            self.assertTrue(r["attacks"])

    def test_rate_limit_retries_automatically(self):
        client = FakeClient([api_error(anthropic.RateLimitError, 429, "rate limited"),
                             api_error(anthropic.OverloadedError, 529, "overloaded")])
        r = self.run_book(JUDO, client)
        self.assertTrue(r["attacks"])
        self.assertTrue(any("Rate limited; retrying" in l for l in self.logs))

    def test_invalid_key_is_fatal_and_friendly(self):
        client = FakeClient([api_error(anthropic.AuthenticationError, 401, "invalid x-api-key")])
        with self.assertRaises(mm.FatalAPIError) as cm:
            self.run_book(JUDO, client)
        self.assertIn("API key was rejected", str(cm.exception))

    def test_out_of_credit_is_fatal_and_friendly(self):
        client = FakeClient([api_error(anthropic.BadRequestError, 400,
                                       "Your credit balance is too low to access the Anthropic API.")])
        with self.assertRaises(mm.FatalAPIError) as cm:
            self.run_book(JUDO, client)
        self.assertIn("out of credit", str(cm.exception))

    def test_scanned_pdf_and_bad_file(self):
        with self.assertRaises(mm.BookError) as cm:
            self.run_book(SCANNED, FakeClient())
        self.assertIn("OCR", str(cm.exception))
        bad = self.out / "broken.pdf"
        bad.write_bytes(b"this is not a pdf")
        with self.assertRaises(mm.BookError) as cm:
            self.run_book(bad, FakeClient())
        self.assertIn("Couldn't read", str(cm.exception))

    def test_no_techniques_found(self):
        txt = self.out / "cookbook.txt"
        txt.write_text("A recipe for bread.\n\nKnead the dough and let the opponent... no, let it rise. "
                       "This technique gives a soft crust.", encoding="utf-8")
        with self.assertRaises(mm.BookError) as cm:
            self.run_book(txt, FakeClient())
        self.assertIn("No attack or defense techniques", str(cm.exception))

    def test_refusal_skips_chunk_and_text_reply_is_nudged(self):
        client = FakeClient([response(stop="refusal"), None])
        with mock.patch.object(mm, "CHUNK_TOKENS", 100):
            r = self.run_book(KARATE, client)
        self.assertTrue(any("declined" in l for l in self.logs))
        self.assertTrue(r["attacks"])
        c2 = FakeClient([response(text="Here are the techniques...", stop="end_turn")])
        r2 = self.run_book(JUDO, c2)
        self.assertTrue(r2["attacks"])
        self.assertEqual(len(c2.calls[1]["messages"]), 3)

    def test_haiku_uses_plain_endpoint(self):
        client = FakeClient()
        mm.process_book(JUDO, client, "claude-haiku-5-5", self.out, progress=self.progress)
        self.assertNotIn("fallbacks", client.calls[0])

    def test_page_numbers(self):
        self.assertEqual(mm.page_numbers(["p. 12", "pp. 14-16", "p. 12", "§3 Throws", "p. 20–21"]),
                         [12, 14, 15, 16, 20, 21])
        self.assertEqual(mm.page_numbers([]), [])

    def test_test_key(self):
        with mock.patch.object(mm, "make_client", lambda k=None: FakeClient()):
            self.assertEqual(mm.test_key("sk-ant-good"), "")
        bad = FakeClient([api_error(anthropic.AuthenticationError, 401, "invalid")])
        with mock.patch.object(mm, "make_client", lambda k=None: bad):
            self.assertIn("rejected", mm.test_key("sk-ant-bad"))
        self.assertIn("Enter", mm.test_key("  "))

    def test_cli(self):
        with mock.patch.object(mm, "make_client", lambda k=None: FakeClient()), \
                mock.patch.dict(os.environ, {"ANTHROPIC_API_KEY": "sk-ant-test"}):
            code = mm.main([str(SAMPLES), "--out", str(self.out)])
        self.assertEqual(code, 1)   # the scanned sample fails, the other two succeed
        self.assertTrue((self.out / "Basic Karate Handbook.md").exists())
        self.assertTrue((self.out / "Judo Basics.md").exists())
        self.assertTrue((self.out / "summary.md").exists())


class AppTests(unittest.TestCase):
    """The Streamlit app: starts cleanly, and its background job handles a mixed batch."""

    def setUp(self):
        self.out = Path(tempfile.mkdtemp())
        self.home = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.out, True)
        self.addCleanup(shutil.rmtree, self.home, True)
        self.env = mock.patch.dict(os.environ, {"HOME": str(self.home), "APPDATA": str(self.home),
                                                "ANTHROPIC_API_KEY": "",
                                                "MARTIAL_MOVES_RESULTS": str(self.out / "results"),
                                                "MARTIAL_MOVES_UPLOADS": str(self.out / "uploads")})
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_app_starts_without_errors(self):
        from streamlit.testing.v1 import AppTest
        at = AppTest.from_file(str(ROOT / "app.py"), default_timeout=30).run()
        self.assertFalse(at.exception, at.exception)
        analyze = [b for b in at.button if "Analyze" in b.label][0]
        self.assertTrue(analyze.disabled)                   # no key, no books yet
        at.sidebar.text_input[0].set_value("sk-ant-test").run()
        at.sidebar.checkbox[0].check().run()
        self.assertFalse(at.exception)
        import app as app_module  # noqa: F401  (same config_path logic)
        cfg = json.loads(app_module.config_path().read_text(encoding="utf-8"))
        self.assertEqual(cfg["api_key"], "sk-ant-test")
        self.assertTrue(str(app_module.config_path()).startswith(str(self.home)))
        [b for b in at.sidebar.button if b.label == "Forget key"][0].click().run()
        cfg = json.loads(app_module.config_path().read_text(encoding="utf-8"))
        self.assertNotIn("api_key", cfg)
        self.assertEqual(at.sidebar.text_input[0].value, "")
        for page in ("⏳ Progress", "🏆 Results"):
            at.radio[0].set_value(page).run()
            self.assertFalse(at.exception, at.exception)

    def test_results_page_shows_saved_results(self):
        import app as app_module
        results_dir = Path(os.environ["MARTIAL_MOVES_RESULTS"])
        r = mm.process_book(KARATE, FakeClient(), "claude-sonnet-5-5", results_dir, progress=lambda e: None)
        from streamlit.testing.v1 import AppTest
        at = AppTest.from_file(str(ROOT / "app.py"), default_timeout=30).run()
        at.radio[0].set_value("🏆 Results").run()
        self.assertFalse(at.exception, at.exception)
        md = " ".join(m.value for m in at.markdown)
        self.assertIn(r["attacks"][0]["name"], md)
        self.assertIn(r["defenses"][0]["name"], md)
        zipped = app_module.build_zip(mm.load_results(results_dir))
        self.assertGreater(len(zipped), 100)

    def test_results_show_page_screenshots(self):
        import app as app_module
        results_dir = Path(os.environ["MARTIAL_MOVES_RESULTS"])
        r = mm.process_book(KARATE, FakeClient(), "claude-sonnet-5-5", results_dir, progress=lambda e: None)
        self.assertEqual(Path(r["source"]), KARATE.resolve())
        png = app_module.page_png(str(KARATE), 2, 0.0)
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertIsNone(app_module.page_png(str(KARATE), 99, 0.0))
        from streamlit.testing.v1 import AppTest
        at = AppTest.from_file(str(ROOT / "app.py"), default_timeout=30).run()
        at.radio[0].set_value("🏆 Results").run()
        self.assertFalse(at.exception, at.exception)
        labels = [e.label for e in at.expander]
        self.assertTrue(any(l.startswith("📄 Page") for l in labels), labels)
        self.assertGreater(len(at.get("image")), 0)
        # EPUB results have no page images.
        mm.process_book(JUDO, FakeClient(), "claude-sonnet-5-5", results_dir, progress=lambda e: None)
        at.run()
        at.selectbox[0].set_value("Judo Basics.epub").run()
        self.assertFalse(at.exception, at.exception)
        self.assertFalse(any(e.label.startswith("📄 Page") for e in at.expander))

    def test_job_runs_batch_one_failure_does_not_stop_others(self):
        import app as app_module
        with mock.patch.object(app_module, "RESULTS_DIR", self.out), \
                mock.patch.object(mm, "make_client", lambda k=None: FakeClient()):
            job = app_module.Job([(KARATE, KARATE.name), (SCANNED, SCANNED.name), (JUDO, JUDO.name)],
                                 "sk-ant-test", "claude-sonnet-5-5")
            job.start()
            job.thread.join(30)
        self.assertEqual(job.status, "done")
        self.assertEqual(job.succeeded, [KARATE.name, JUDO.name])
        self.assertEqual([f[0] for f in job.failures], [SCANNED.name])
        self.assertIn("OCR", job.failures[0][1])
        self.assertTrue((self.out / "summary.md").exists())

    def test_job_cancel_and_fatal(self):
        import app as app_module

        class SlowClient(FakeClient):
            def _create(self, **kw):
                time.sleep(0.2)
                return super()._create(**kw)

        with mock.patch.object(app_module, "RESULTS_DIR", self.out), \
                mock.patch.object(mm, "CHUNK_TOKENS", 100), \
                mock.patch.object(mm, "make_client", lambda k=None: SlowClient()):
            job = app_module.Job([(KARATE, KARATE.name), (JUDO, JUDO.name)], "k", "claude-sonnet-5-5")
            job.start()
            time.sleep(0.3)
            job.cancel_event.set()
            job.thread.join(30)
        self.assertEqual(job.status, "cancelled")
        self.assertEqual(job.succeeded, [])
        bad = FakeClient([api_error(anthropic.AuthenticationError, 401, "invalid")])
        with mock.patch.object(app_module, "RESULTS_DIR", self.out), \
                mock.patch.object(mm, "make_client", lambda k=None: bad):
            job = app_module.Job([(KARATE, KARATE.name), (JUDO, JUDO.name)], "k", "claude-sonnet-5-5")
            job.start()
            job.thread.join(30)
        self.assertEqual(job.status, "stopped")
        self.assertIn("API key was rejected", job.fatal)
        self.assertEqual(len(bad.calls), 1)   # second book never attempted


if __name__ == "__main__":
    unittest.main()
