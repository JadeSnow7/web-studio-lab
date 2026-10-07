#!/usr/bin/env python3
"""Export the submission Markdown and evidence index; never writes acceptance."""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
INK = colors.HexColor("#172739")
BLUE = colors.HexColor("#295B82")
MUTED = colors.HexColor("#576B7B")
RULE = colors.HexColor("#CBD5DF")
WIDTH = A4[0] - 36 * mm


class Exporter:
    def __init__(self, font: Path, sources: list[Path]):
        pdfmetrics.registerFont(TTFont("Submission", str(font)))
        pdfmetrics.registerFontFamily(
            "Submission", normal="Submission", bold="Submission",
            italic="Submission", boldItalic="Submission",
        )
        self.sources = sources
        self.source_names = {p.name for p in sources}
        snapshot = re.search(r"对应仓库快照为 main 的 `([0-9a-f]{40})`", sources[0].read_text())
        if not snapshot:
            raise ValueError("The source must identify its 40-character repository snapshot")
        self.snapshot = snapshot.group(1)
        cutoff = re.search(r"证据截止日期为 \*\*(\d{4}) 年 (\d{1,2}) 月 (\d{1,2}) 日\*\*", sources[0].read_text())
        if not cutoff:
            raise ValueError("The source must identify its evidence cutoff date")
        self.cutoff = "{}-{:02d}-{:02d}".format(int(cutoff[1]), int(cutoff[2]), int(cutoff[3]))
        self.style = ParagraphStyle(
            "Body", fontName="Submission", fontSize=10, leading=16,
            textColor=INK, spaceAfter=8, wordWrap="CJK", splitLongWords=True,
        )
        self.cell_style = ParagraphStyle(
            "Cell", parent=self.style, fontSize=8.5, leading=13, spaceAfter=0,
        )
        self.head_style = ParagraphStyle(
            "CellHead", parent=self.cell_style, textColor=colors.white,
        )
        self.code_style = ParagraphStyle(
            "Code", parent=self.style, fontSize=8.5, leading=13,
            leftIndent=8, rightIndent=8, backColor=colors.HexColor("#EFF3F7"),
            borderPadding=8, spaceBefore=3, spaceAfter=10,
        )

    def link(self, url: str, source: Path) -> str:
        parts = urlsplit(url)
        if parts.scheme:
            return url
        if parts.fragment and (not parts.path or Path(parts.path).name in self.source_names):
            return "#" + parts.fragment
        target = (source.parent / unquote(parts.path)).resolve()
        try:
            relative = target.relative_to(ROOT).as_posix()
        except ValueError:
            raise ValueError(f"Link escapes the repository: {url}") from None
        if not target.exists():
            raise ValueError(f"Missing relative link: {url}")
        return (
            f"https://github.com/JadeSnow7/web-studio-lab/blob/{self.snapshot}/"
            + quote(relative, safe="/")
            + ("#" + parts.fragment if parts.fragment else "")
        )

    def inline(self, nodes: list[dict], source: Path) -> str:
        result = []
        for node in nodes:
            kind, value = node["t"], node.get("c")
            if kind == "Str":
                result.append(html.escape(value))
            elif kind in ("Space", "SoftBreak"):
                result.append(" ")
            elif kind == "LineBreak":
                result.append("<br/>")
            elif kind == "Code":
                result.append('<font color="#334B61">' + html.escape(value[1]) + "</font>")
            elif kind == "Strong":
                result.append("<b>" + self.inline(value, source) + "</b>")
            elif kind == "Emph":
                result.append(self.inline(value, source))
            elif kind == "Link":
                target = html.escape(self.link(value[2][0], source), quote=True)
                result.append(f'<a href="{target}" color="#295B82">' + self.inline(value[1], source) + "</a>")
            elif kind == "Quoted":
                result.append("“" + self.inline(value[1], source) + "”")
            else:
                raise ValueError(f"Unsupported Markdown inline: {kind}")
        return "".join(result)

    def cell(self, cell: list, source: Path, heading: bool):
        pieces = []
        for block in cell[4]:
            if block["t"] not in ("Plain", "Para"):
                raise ValueError("Only paragraph table cells are supported")
            pieces.append(self.inline(block["c"], source))
        return Paragraph("<br/>".join(pieces), self.head_style if heading else self.cell_style)

    def table(self, value: list, source: Path):
        rows = value[3][1][:]
        head_count = len(rows)
        for body in value[4]:
            rows.extend(body[2])
            rows.extend(body[3])
        rows.extend(value[5][1])
        count = len(value[2])
        widths = {2: [0.23, 0.77], 3: [0.22, 0.39, 0.39]}.get(count, [1 / count] * count)
        data = []
        for i, row in enumerate(rows):
            if any(cell[2:4] != [1, 1] for cell in row[1]):
                raise ValueError("Spanned cells are not supported")
            data.append([self.cell(cell, source, i < head_count) for cell in row[1]])
        table = Table(data, colWidths=[WIDTH * w for w in widths], repeatRows=head_count, hAlign="LEFT")
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, head_count - 1), INK),
            ("ROWBACKGROUNDS", (0, head_count), (-1, -1), [colors.white, colors.HexColor("#F4F7FA")]),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 7),
            ("RIGHTPADDING", (0, 0), (-1, -1), 7),
            ("TOPPADDING", (0, 0), (-1, -1), 7),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ("LINEBELOW", (0, head_count), (-1, -1), 0.35, RULE),
        ]))
        return [table, Spacer(1, 11)]

    def blocks(self, blocks: list[dict], source: Path):
        story = []
        for block in blocks:
            kind, value = block["t"], block.get("c")
            if kind == "Header":
                level, attrs, nodes = value
                sizes = {1: (22, 30), 2: (15, 23), 3: (11, 18)}
                size, leading = sizes.get(level, (10, 16))
                style = ParagraphStyle(
                    f"H{level}", parent=self.style, fontSize=size, leading=leading,
                    spaceBefore=14 if level > 1 else 0, spaceAfter=9,
                    textColor=BLUE if level == 3 else INK, keepWithNext=True,
                )
                anchor = html.escape(attrs[0], quote=True)
                story.append(Paragraph(f'<a name="{anchor}"/>' + self.inline(nodes, source), style))
                if level == 1:
                    story.extend([HRFlowable(width="100%", color=RULE, thickness=0.6), Spacer(1, 9)])
            elif kind in ("Para", "Plain"):
                style = self.style
                if len(value) == 1 and value[0]["t"] == "Strong":
                    style = ParagraphStyle("EvidenceLabel", parent=self.style, keepWithNext=True)
                story.append(Paragraph(self.inline(value, source), style))
            elif kind in ("BulletList", "OrderedList"):
                items = value if kind == "BulletList" else value[1]
                for i, item in enumerate(items):
                    prefix = "• " if kind == "BulletList" else f"{i + 1}. "
                    for j, paragraph in enumerate(item):
                        if paragraph["t"] not in ("Para", "Plain"):
                            raise ValueError("Only paragraph list items are supported")
                        style = ParagraphStyle("List", parent=self.style, leftIndent=10)
                        story.append(Paragraph((prefix if j == 0 else "") + self.inline(paragraph["c"], source), style))
            elif kind == "CodeBlock":
                story.append(Paragraph(html.escape(value[1]).replace("\n", "<br/>"), self.code_style))
            elif kind == "Table":
                story.extend(self.table(value, source))
            else:
                raise ValueError(f"Unsupported Markdown block: {kind}")
        return story

    def page(self, canvas, doc):
        canvas.saveState()
        canvas.setFont("Submission", 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(18 * mm, A4[1] - 12 * mm, "WEB STUDIO LAB / 参赛作品介绍")
        canvas.setStrokeColor(RULE)
        canvas.line(18 * mm, 16 * mm, A4[0] - 18 * mm, 16 * mm)
        canvas.drawString(18 * mm, 11 * mm, "审阅草稿 / 证据截止 " + self.cutoff)
        canvas.drawRightString(A4[0] - 18 * mm, 11 * mm, str(doc.page))
        canvas.restoreState()

    def export(self, output: Path):
        story = []
        for i, source in enumerate(self.sources):
            ast = json.loads(subprocess.check_output(["pandoc", "--from=gfm", "--to=json", str(source)], text=True))
            if i:
                story.append(PageBreak())
            story.extend(self.blocks(ast["blocks"], source))
        output.parent.mkdir(parents=True, exist_ok=True)
        doc = SimpleDocTemplate(
            str(output), pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
            topMargin=22 * mm, bottomMargin=23 * mm,
            title="Web Studio Lab - 2026 上海开源软件应用创新大赛作品介绍（审阅草稿）",
            author="Web Studio Lab", subject="作品介绍与固定提交证据索引",
        )
        doc.build(story, onFirstPage=self.page, onLaterPages=self.page)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", type=Path, required=True, help="Static TrueType font with Simplified Chinese glyphs")
    parser.add_argument("--output", type=Path, default=ROOT / "output/submission/oschina-2026-draft.pdf")
    args = parser.parse_args()
    if not args.font.is_file():
        parser.error("--font must be an existing static TrueType font")
    if not shutil.which("pandoc"):
        parser.error("pandoc is required on PATH")
    output = args.output.resolve()
    if not output.name.lower().endswith(".pdf"):
        parser.error("--output must end in .pdf")
    if (ROOT / "docs/acceptance").resolve() in output.parents:
        parser.error("Export output must not be inside docs/acceptance")
    Exporter(args.font.resolve(), [HERE / "oschina-2026.md", HERE / "oschina-2026-evidence.md"]).export(output)
    print(output)


if __name__ == "__main__":
    main()
