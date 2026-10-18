# 🥋 Martial Moves

Martial Moves reads your martial arts books (PDF, EPUB or TXT). It uses Claude to find every technique in each book, then picks the **top 5 attacks** and **top 5 defenses**. You get a page of move cards for each book, and you can download the reports.

The app runs on your own computer and opens in your web browser. You don't need to type any commands.

---

## One-time setup (Windows)

### 1. Install Python
1. Go to **https://www.python.org/downloads/** and click the big yellow **Download Python** button.
2. Run the installer. **On the first screen, tick "Add python.exe to PATH"**, then click **Install Now**.
3. When it says "Setup was successful", close it.

### 2. Get an Anthropic API key
1. Go to **https://platform.claude.com** and sign in or create an account.
2. Under **Billing**, add some credit. A few dollars covers many books.
3. Under **API keys**, click **Create key** and copy it. It starts with `sk-ant-`.
   Keep it private, like a password.

### 3. Start the app
1. Open the `martial-moves` folder.
2. **Double-click `start.bat`.**
   - If Windows shows "Windows protected your PC", click **More info**, then **Run anyway**.
   - The first start takes a minute or two while it installs what it needs. Later starts are quick.
3. Your browser opens on the app. If it doesn't, go to **http://localhost:8501**.

**Keep the black window open while you use the app.** Close it when you're done to quit.

---

## Using the app

1. **Settings** (left side)
   - Paste your API key and click **Test key**. You should see ✅ **Key works**.
   - Tick **Remember key on this computer** so you don't have to paste it again. The key is saved in your own user folder (`%APPDATA%\MartialMoves\config.json`), not in the app folder. **Forget key** deletes it.
   - If you've set the `ANTHROPIC_API_KEY` environment variable, the key box fills in automatically.
   - **Model**: Sonnet 5.5 is the default and the best balance. Opus 5.5 is more thorough and costs about twice as much. Haiku 5.5 is the fastest and cheapest.
2. **📚 Upload books**
   - Drag your books onto the box, or click **Upload**. You can add several at once.
   - The table shows each book's pages (or sections) and its size in tokens.
   - **⚠️ Scanned PDFs**: if a PDF is just photos of pages, the app can't read it. You need to run OCR (text recognition) on it first, for example with Adobe Acrobat's "Recognize Text" or the free tool *ocrmypdf*. Then upload the new file.
   - Click **🔍 Analyze**.
3. **⏳ Progress**
   - The top bar shows progress across all books. The second bar shows progress through the current book ("Book 2 of 4 · chunk 3 of 7").
   - The log shows what's happening right now.
   - **Cancel** stops after the current request to Claude finishes.
   - Work is saved as it goes. If you cancel, or the computer goes to sleep, click **Analyze** again and it picks up where it left off without paying twice.
4. **🏆 Results**
   - Pick a book. You'll see **Top 5 Attacks** and **Top 5 Defenses** side by side. Each card shows the move's other names, how it's done, why it ranks, and the pages or sections where it appears.
   - For PDF books, click **📄 Page …** under a move to see a picture of the actual book page, with the photos and diagrams. (EPUB and TXT books don't have fixed pages, so they have no page pictures.)
   - Download that book's report (`.md`, which opens in any text editor) or data (`.json`). **Download all (zip)** gives you every report plus `summary.md`.
   - Results from earlier runs appear here automatically. They're stored in the `results` folder.

### What things cost (rough guide)
With Sonnet 5.5, a 300-page book costs roughly **$0.30–$0.60**. Opus 5.5 costs about twice that, and Haiku 5.5 costs a few cents. The "Est. tokens" column gives a sense of size: about 1 million tokens of text costs about $2 to read with Sonnet.

### If something goes wrong
| Message | What to do |
|---|---|
| *Your API key was rejected* | Copy the key again from platform.claude.com. Make sure you got the whole key. |
| *Your account is out of credit* | Add credit under Billing at platform.claude.com. |
| *Rate limit… retrying* | Nothing. The app waits and retries by itself. |
| *Looks like a scanned PDF* | Run OCR on the file first (see above). |
| *No attack or defense techniques were found* | The book may not teach specific moves, or its text didn't extract well. |
| *Python 3.10 or newer was not found* (black window) | Install Python as in step 1. Remember the "Add to PATH" tick box. |

If one book fails, the others keep going. The Progress page lists what failed and why.

To start fresh, close the app and delete the `.venv` folder. The next `start.bat` reinstalls everything.

---

## For the technically curious

The app is `app.py` (Streamlit). All the analysis lives in `martial_moves.py`, which still works on its own from a terminal:

```
set ANTHROPIC_API_KEY=sk-ant-...
python martial_moves.py "C:\Books\karate.pdf" C:\Books\more_books --model claude-sonnet-5-5 --out results
```

You can pass files, folders or wildcards (`books\*.pdf`). Finished chunks are cached in `results\.cache`, so a re-run resumes where it stopped.

The `samples` folder has two small test books (a PDF and an EPUB) and a fake "scanned" PDF. To run the test suite, which mocks the Claude API and costs nothing:

```
.venv\Scripts\python -m unittest discover tests -v
```

`tests/make_samples.py` rebuilds the sample books (needs `pip install reportlab`).
