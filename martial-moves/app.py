"""Martial Moves: a point-and-click front end for martial_moves.py.

Run with:  streamlit run app.py   (or double-click start.bat on Windows)
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import threading
import time
import traceback
import zipfile
from pathlib import Path

import streamlit as st

import martial_moves as mm

APP_DIR = Path(__file__).resolve().parent
RESULTS_DIR = Path(os.environ.get("MARTIAL_MOVES_RESULTS") or APP_DIR / "results")
UPLOADS_DIR = Path(os.environ.get("MARTIAL_MOVES_UPLOADS") or APP_DIR / "uploads")
MODEL_LABELS = {
    "claude-sonnet-5-5": "Claude Sonnet 5.5 (recommended)",
    "claude-opus-5-5": "Claude Opus 5.5 (most thorough, costs more)",
    "claude-haiku-5-5": "Claude Haiku 5.5 (fastest, cheapest)",
}


# --------------------------------------------------------------------------- config (key storage)

def config_path() -> Path:
    """Settings live in the user's folder, never in the project folder."""
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
        return base / "MartialMoves" / "config.json"
    return Path.home() / ".config" / "martial_moves" / "config.json"


def load_config() -> dict:
    try:
        return json.loads(config_path().read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(cfg: dict):
    p = config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


# --------------------------------------------------------------------------- background job

class Job:
    """Runs process_book over several books in a background thread.

    The Streamlit page only reads this object's fields; the thread never calls st.*.
    """

    def __init__(self, books: list[tuple[Path, str]], api_key: str, model: str):
        self.books = books
        self.api_key = api_key
        self.model = model
        self.logs: list[str] = []
        self.book_idx = 0             # 0-based index of the book being worked on
        self.chunk_done = 0
        self.chunk_total = 0
        self.status = "running"       # running | done | cancelled | stopped
        self.failures: list[tuple[str, str]] = []
        self.succeeded: list[str] = []
        self.fatal = ""
        self.cancel_event = threading.Event()
        self.finished_at = 0.0
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()

    @property
    def running(self) -> bool:
        return self.status == "running"

    def log(self, msg: str):
        self.logs.append(msg)

    def _progress(self, event: dict):
        if event["type"] == "log":
            self.log(event["msg"])
        elif event["type"] == "chunks":
            self.chunk_done, self.chunk_total = event["done"], event["total"]

    def _run(self):
        try:
            client = mm.make_client(self.api_key)
            for i, (path, name) in enumerate(self.books):
                if self.cancel_event.is_set():
                    break
                self.book_idx, self.chunk_done, self.chunk_total = i, 0, 0
                try:
                    mm.process_book(path, client, self.model, RESULTS_DIR, progress=self._progress,
                                    should_cancel=self.cancel_event.is_set, display_name=name)
                    self.succeeded.append(name)
                except mm.Cancelled:
                    break
                except mm.FatalAPIError as e:
                    self.fatal = str(e)
                    self.log(f"!! {e}")
                    self.status = "stopped"
                    break
                except mm.MartialMovesError as e:
                    self.failures.append((name, str(e)))
                    self.log(f"!! {name}: {e}")
                except Exception as e:  # never let one book kill the run
                    self.failures.append((name, f"Unexpected problem ({type(e).__name__}: {e})"))
                    self.log(f"!! {name}: unexpected problem\n{traceback.format_exc(limit=3)}")
            if self.succeeded:
                mm.write_summary(RESULTS_DIR)
        finally:
            if self.status == "running":
                self.status = "cancelled" if self.cancel_event.is_set() else "done"
            if self.status == "cancelled":
                self.log("Cancelled. Finished chunks are saved; analyze again to resume.")
            elif self.status == "done":
                self.log("All done.")
            self.finished_at = time.time()


@st.cache_resource
def job_holder() -> dict:
    """One shared slot so a page refresh reconnects to a running analysis."""
    return {"job": None}


# --------------------------------------------------------------------------- uploads

def save_upload(f) -> tuple[Path, str]:
    data = f.getvalue()
    digest = hashlib.sha256(data).hexdigest()[:12]
    folder = UPLOADS_DIR / digest
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / (mm.safe_stem(f.name) + Path(f.name).suffix.lower())
    if not path.exists():
        path.write_bytes(data)
    return path, f.name


@st.cache_data(show_spinner=False)
def inspect_cached(path_str: str, _mtime: float) -> dict:
    return mm.inspect_book(path_str)


# --------------------------------------------------------------------------- page

st.set_page_config(page_title="Martial Moves", page_icon="🥋", layout="wide")

cfg = load_config()
if "api_key" not in st.session_state:
    st.session_state.api_key = cfg.get("api_key") or os.environ.get("ANTHROPIC_API_KEY", "")
    st.session_state.remember = bool(cfg.get("api_key"))
    st.session_state.model = cfg.get("model") if cfg.get("model") in mm.MODELS else mm.DEFAULT_MODEL
    st.session_state.key_test = None   # (key, error message or "")
if "nav" not in st.session_state:
    st.session_state.nav = "📚 Upload books"

holder = job_holder()
job: Job | None = holder["job"]


def on_key_change():
    st.session_state.key_test = None
    if st.session_state.remember:
        save_config({**load_config(), "api_key": st.session_state.api_key.strip()})


def on_remember_change():
    c = load_config()
    if st.session_state.remember and st.session_state.api_key.strip():
        c["api_key"] = st.session_state.api_key.strip()
    else:
        c.pop("api_key", None)
    save_config(c)


def on_forget():
    c = load_config()
    c.pop("api_key", None)
    save_config(c)
    st.session_state.api_key = ""
    st.session_state.remember = False
    st.session_state.key_test = None


def on_model_change():
    save_config({**load_config(), "model": st.session_state.model})


def on_test_key():
    key = st.session_state.api_key.strip()
    st.session_state.key_test = (key, mm.test_key(key, st.session_state.model))


# ---- sidebar: settings
with st.sidebar:
    st.header("⚙️ Settings")
    st.text_input("Anthropic API key", type="password", key="api_key", on_change=on_key_change,
                  placeholder="sk-ant-...",
                  help="Get one at platform.claude.com → API keys.")
    st.button("Test key", on_click=on_test_key, width="stretch")
    test = st.session_state.key_test
    if test and test[0] == st.session_state.api_key.strip():
        if test[1]:
            st.error(test[1])
        else:
            st.success("✅ Key works")
    st.checkbox("Remember key on this computer", key="remember", on_change=on_remember_change,
                help=f"Saved to {config_path()}")
    st.button("Forget key", on_click=on_forget, width="stretch",
              disabled=not load_config().get("api_key") and not st.session_state.api_key)
    if os.environ.get("ANTHROPIC_API_KEY") and not cfg.get("api_key"):
        st.caption("Key pre-filled from the ANTHROPIC_API_KEY environment variable.")
    st.selectbox("Model", mm.MODELS, key="model", format_func=lambda m: MODEL_LABELS.get(m, m),
                 on_change=on_model_change)
    st.caption(f"Reports are saved in `{RESULTS_DIR}`")

st.title("🥋 Martial Moves")
st.caption("Find the top 5 attacks and top 5 defenses in your martial arts books.")

nav = st.radio("Section", ["📚 Upload books", "⏳ Progress", "🏆 Results"], key="nav",
               horizontal=True, label_visibility="collapsed")
st.divider()


# ---- upload tab
def on_upload():
    """Move dropped files into the session's book list and reset the drop zone.

    The list lives in session_state so it survives switching sections (an unmounted
    file_uploader forgets its files).
    """
    key = f"uploader_{st.session_state.uploader_n}"
    for f in st.session_state.get(key) or []:
        try:
            path, name = save_upload(f)
            st.session_state.books[str(path)] = name
        except Exception as e:
            st.session_state.upload_errors.append(f"{f.name}: couldn't save the file ({e})")
    st.session_state.uploader_n += 1


def on_clear_books():
    st.session_state.books = {}
    st.session_state.upload_errors = []


def upload_section():
    st.session_state.setdefault("books", {})
    st.session_state.setdefault("upload_errors", [])
    st.session_state.setdefault("uploader_n", 0)
    st.file_uploader("Drop PDF, EPUB or TXT books here", type=["pdf", "epub", "txt"],
                     accept_multiple_files=True, key=f"uploader_{st.session_state.uploader_n}",
                     on_change=on_upload)
    for err in st.session_state.upload_errors:
        st.error(err)

    readable: list[tuple[Path, str]] = []
    books = {p: n for p, n in st.session_state.books.items() if Path(p).exists()}
    if books:
        rows, total = [], 0
        for path_str, name in books.items():
            info = inspect_cached(path_str, Path(path_str).stat().st_mtime)
            units = info.get("units")
            rows.append({
                "Book": name,
                "Pages / sections": f"{units} {info.get('unit_label', '')}" if units is not None else "—",
                "Est. tokens": f"{info['tokens']:,}" if info.get("tokens") is not None else "—",
                "Status": "✅ Ready" if info.get("ok") else f"⚠️ {info.get('error', 'Unreadable')}",
            })
            if info.get("ok"):
                readable.append((Path(path_str), name))
                total += info["tokens"]
        st.table(rows)
        c1, c2 = st.columns([4, 1])
        c1.caption(f"{len(readable)} of {len(books)} book(s) readable · about {total:,} tokens of text in total. "
                   "Books analyzed before resume from saved chunks.")
        c2.button("Clear list", on_click=on_clear_books, width="stretch")

    has_key = bool(st.session_state.api_key.strip())
    busy = job is not None and job.running
    reason = ("An analysis is already running." if busy else
              "Enter your API key in Settings (left)." if not has_key else
              "Upload at least one readable book." if not readable else "")

    def start():
        new = Job(readable, st.session_state.api_key.strip(), st.session_state.model)
        holder["job"] = new
        new.start()
        st.session_state.nav = "⏳ Progress"

    st.button("🔍 Analyze", type="primary", disabled=bool(reason), on_click=start)
    if reason and (books or not has_key):
        st.caption(reason)
    if busy:
        st.info("Analysis running, see the **⏳ Progress** section.")


# ---- progress tab
def progress_section():
    j: Job | None = holder["job"]
    if j is None:
        st.info("Nothing running. Upload books and press **Analyze**.")
        return
    n = len(j.books)
    frac_chunk = j.chunk_done / j.chunk_total if j.chunk_total else 0.0
    books_done = j.book_idx + frac_chunk if j.running else (n if j.status == "done" else j.book_idx + frac_chunk)
    name = j.books[min(j.book_idx, n - 1)][1]
    st.progress(min(1.0, books_done / n), text=f"Overall: book {min(j.book_idx + 1, n)} of {n}")
    chunk_txt = f"chunk {j.chunk_done} of {j.chunk_total}" if j.chunk_total else "reading..."
    st.progress(min(1.0, frac_chunk), text=f"Book {min(j.book_idx + 1, n)} of {n} · {chunk_txt} · {name}")

    if j.running:
        c1, c2 = st.columns([1, 5])
        if j.cancel_event.is_set():
            c1.button("Cancelling...", disabled=True)
            c2.caption("Stopping after the current API call...")
        elif c1.button("⏹ Cancel"):
            j.cancel_event.set()
            st.rerun(scope="fragment")
    else:
        if j.fatal:
            st.error(j.fatal)
        elif j.status == "cancelled":
            st.warning("Cancelled. Finished chunks are saved; press Analyze again to resume.")
        if j.succeeded:
            st.success(f"Finished {len(j.succeeded)} book(s): {', '.join(j.succeeded)}. See **🏆 Results**.")
        for book, err in j.failures:
            st.error(f"**{book}**: {err}")

    # Newest lines stay visible without scrolling; the whole log is one click away.
    st.code("\n".join(j.logs[-15:]) or "Starting...", language=None)
    with st.expander(f"Full log ({len(j.logs)} lines)"):
        st.code("\n".join(j.logs), language=None)

    # When the job finishes, rerun the whole page once so Results and buttons refresh.
    if not j.running and st.session_state.get("seen_finish") != id(j):
        st.session_state.seen_finish = id(j)
        st.rerun()


# ---- results tab
def move_card(m: dict):
    with st.container(border=True):
        st.markdown(f"#### {m.get('rank', '')}. {m.get('name', '')}")
        if m.get("aliases"):
            st.caption("Also called: " + ", ".join(m["aliases"]))
        st.write(m.get("summary", ""))
        st.markdown(f"**Why it ranks:** {m.get('why', '')}")
        if m.get("refs"):
            st.caption("📖 " + ", ".join(m["refs"]))


def build_zip(results: list[dict]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for r in results:
            stem = mm.safe_stem(r["book"])
            clean = {k: v for k, v in r.items() if not k.startswith("_")}
            z.writestr(f"{stem}.md", mm.md_report(clean))
            z.writestr(f"{stem}.json", json.dumps(clean, indent=2, ensure_ascii=False))
        z.writestr("summary.md", mm.summary_md(results))
    return buf.getvalue()


def results_section():
    results = mm.load_results(RESULTS_DIR) if RESULTS_DIR.exists() else []
    if not results:
        st.info("No results yet. Analyze a book and its top moves will appear here.")
        return
    names = [r["book"] for r in results]
    j: Job | None = holder["job"]
    default = names.index(j.succeeded[-1]) if j and j.succeeded and j.succeeded[-1] in names else 0
    choice = st.selectbox("Book", names, index=default)
    r = results[names.index(choice)]
    st.caption(f"{r.get('technique_count', 0)} techniques found · model {r.get('model', '?')}")

    left, right = st.columns(2)
    for col, title, key in ((left, "🗡️ Top 5 Attacks", "attacks"), (right, "🛡️ Top 5 Defenses", "defenses")):
        with col:
            st.subheader(title)
            if not r.get(key):
                st.caption("None found in this book.")
            for m in r.get(key, []):
                move_card(m)

    clean = {k: v for k, v in r.items() if not k.startswith("_")}
    stem = mm.safe_stem(r["book"])
    c1, c2, c3 = st.columns(3)
    c1.download_button("⬇️ Report (.md)", mm.md_report(clean), f"{stem}.md", "text/markdown",
                       width="stretch")
    c2.download_button("⬇️ Data (.json)", json.dumps(clean, indent=2, ensure_ascii=False), f"{stem}.json",
                       "application/json", width="stretch")
    c3.download_button("⬇️ Download all (zip)", build_zip(results), "martial_moves_results.zip",
                       "application/zip", width="stretch")
    with st.expander(f"All {len(r.get('all_techniques', []))} techniques found"):
        st.dataframe([{"Name": t["name"], "Type": t["category"], "Mentions": t["mentions"],
                       "Emphasis": t["emphasis"], "Where": ", ".join(t["refs"])}
                      for t in r.get("all_techniques", [])], hide_index=True, width="stretch")


if nav == "📚 Upload books":
    upload_section()
elif nav == "⏳ Progress":
    running = job is not None and job.running
    st.fragment(run_every=1.0 if running else None)(progress_section)()
else:
    results_section()
