"""Create the small sample books in samples/ (PDF, EPUB, and a scanned-style PDF)."""
from pathlib import Path

from ebooklib import epub
from reportlab.lib.pagesizes import A5
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer
from reportlab.pdfgen import canvas

OUT = Path(__file__).resolve().parent.parent / "samples"

KARATE_PAGES = [
    ("Basic Karate Handbook", "Copyright 2026 Sample Press. All rights reserved. ISBN 000-0-00-000000-0."),
    ("Chapter 1: Strikes",
     "The straight punch (oi-zuki) is the fundamental attack of karate. Step forward and drive the fist "
     "from the hip, twisting at the end. Practice it daily against the opponent's centre line. "
     "The reverse punch (gyaku-zuki) throws the rear hand while the front leg stays planted; it is "
     "the most powerful strike for a counter attack."),
    ("Chapter 2: Kicks",
     "The front kick (mae-geri) raises the knee and snaps the ball of the foot into the opponent's stomach. "
     "The roundhouse kick (mawashi-geri) swings the shin or instep in an arc toward the head or ribs. "
     "The side kick (yoko-geri) thrusts the edge of the foot sideways and is a strong attack against a charging opponent."),
    ("Chapter 3: Blocks",
     "The rising block (age-uke) lifts the forearm to deflect a strike aimed at the face. "
     "The outside block (soto-uke) sweeps the forearm across the body to parry a punch to the chest. "
     "The downward block (gedan-barai) sweeps down to deflect a front kick. Every block should flow into a counter."),
    ("Chapter 4: Evasion",
     "Body shifting (tai-sabaki) is the best defense: step off the line of the attack and turn so the "
     "opponent's strike misses. The knife-hand block (shuto-uke) defends while setting up a counter strike. "
     "An elbow strike (empi-uchi) is an attack for close range when the opponent grabs you."),
]

JUDO_SECTIONS = [
    ("Throws",
     "The major outer reap (osoto-gari) is the classic judo throw: break the opponent's balance backward, "
     "step beside them and reap their leg. The hip throw (o-goshi) loads the opponent onto your hip and turns. "
     "The shoulder throw (seoi-nage) is a fundamental attack: turn in, grip the sleeve and lift over the shoulder."),
    ("Groundwork",
     "The scarf hold (kesa-gatame) pins the opponent on their back. The arm lock (juji-gatame) is a joint lock "
     "attack that straightens the arm across the hips. The naked choke (hadaka-jime) is applied from behind."),
    ("Defenses and escapes",
     "Breakfalls (ukemi) are the first defense every student learns: slap the mat to absorb the throw. "
     "The bridge and roll escape frees you from the scarf hold. Blocking the hip (hip block) stops the hip throw "
     "by pushing the opponent's hip away. Grip breaking defends against the opponent's attack before it starts. "
     "Sprawling defends against a leg grab takedown."),
]


def make_pdf(path: Path):
    styles = getSampleStyleSheet()
    story = []
    for title, body in KARATE_PAGES:
        story += [Paragraph(title, styles["Heading2"]), Spacer(1, 8), Paragraph(body, styles["BodyText"]), PageBreak()]
    SimpleDocTemplate(str(path), pagesize=A5).build(story)


def make_epub(path: Path):
    book = epub.EpubBook()
    book.set_identifier("sample-judo-001")
    book.set_title("Judo Basics")
    book.set_language("en")
    book.add_author("Sample Author")
    chapters = []
    for i, (title, body) in enumerate(JUDO_SECTIONS, 1):
        c = epub.EpubHtml(title=title, file_name=f"chap_{i}.xhtml", lang="en")
        c.content = f"<html><body><h1>{title}</h1><p>{body}</p></body></html>"
        book.add_item(c)
        chapters.append(c)
    book.toc = chapters
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = ["nav", *chapters]
    epub.write_epub(str(path), book)


def make_scanned(path: Path):
    """A PDF with only drawn shapes and no text layer, like a scan."""
    c = canvas.Canvas(str(path), pagesize=A5)
    for _ in range(3):
        c.rect(40, 40, 300, 500, fill=1)
        c.showPage()
    c.save()


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    make_pdf(OUT / "Basic Karate Handbook.pdf")
    make_epub(OUT / "Judo Basics.epub")
    make_scanned(OUT / "Scanned Example (needs OCR).pdf")
    print("Wrote samples to", OUT)
