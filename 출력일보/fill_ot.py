#!/usr/bin/env python3
"""출력일보(서명지) 하루치를 '출입기록 기반 출퇴근표' 양식에 채운다.

사용:
  python3 fill_ot.py <양식.xlsx> <기록/YYYY-MM-DD.csv> [-o 결과.xlsx]

- 양식의 이름 명단(AA열)과 입력 이름을 맞춘다(같은 이름 우선, 한 글자만 다르면 고쳐 쓰고 알림).
- 엑셀 파일은 셀 값만 XML 에서 바꾼다(서식·그림·수식 보존). 열면 수식이 다시 계산된다.
- 이미 값이 있는 칸은 덮어쓰지 않고 알린다(--force 로 덮어씀).
"""
import argparse, csv, datetime as dt, re, shutil, sys, zipfile
from pathlib import Path
import openpyxl
from lxml import etree

SHEET = "출입기록 기반 출퇴근표"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
# 구분 → (기본퇴근, 기본급, O/T, 비고)   양식의 'OT 산정 공수표'(평일) 기준
RULES = {
    "연장": ("19:00", 1, 0.5, "연장"),
    "조출": (None, 1, 0.5, "조출"),
    "야간": (None, 1, 1, "야간"),
    "철야": (None, 1, 1, "철야"),
    "주간": (None, 1, None, None),
    "연차": (None, None, None, "연차"),
}
OT_KINDS = {"연장", "조출", "야간", "철야"}  # 번호(OT 일수)를 매기는 구분


def col_letter(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def to_time(s):
    h, m = map(int, s.strip().split(":")[:2])
    return (h * 60 + m) / 1440


def find_blocks(ws):
    """사람별 칸 묶음: {이름: (번호열, 머리행)}"""
    blocks = {}
    for row in ws.iter_rows():
        for c in row:
            if c.column in (3, 15) and isinstance(c.value, str):
                m = re.fullmatch(r"=AA(\d+)", c.value.strip())
                if m:
                    name = ws.cell(int(m.group(1)), 27).value
                    if name:
                        blocks[str(name).strip()] = (c.column, c.row)
    return blocks


def date_row(ws, col, top, day):
    for r in range(top + 1, top + 36):
        v = ws.cell(r, col + 1).value
        if isinstance(v, dt.datetime) and v.date() == day:
            return r
    return None


def match_name(name, names):
    if name in names:
        return name, False
    # 글자 수가 같고 같은 자리 글자가 하나만 다를 때만 고친다 (예: 박구태→박규태).
    # 그보다 느슨하면 다른 사람으로 잘못 붙는다 (박규태↛박태원).
    near = [n for n in names if len(n) == len(name)
            and sum(x != y for x, y in zip(n, name)) == 1]
    return (near[0], True) if len(near) == 1 else (None, False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("template")
    ap.add_argument("day_csv")
    ap.add_argument("-o", "--out")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    day = dt.date.fromisoformat(Path(a.day_csv).stem[:10])
    out = Path(a.out or Path(a.template).with_name(f"{Path(a.template).stem}_{day:%m%d}.xlsx"))

    if day.weekday() >= 5:
        print(f"주의: {day} 는 주말 — 주말 공수(1.5/2.25/3)는 스크립트가 채우지 않음. 공휴일도 직접 확인.")
    wb = openpyxl.load_workbook(a.template)  # 수식 그대로 읽기(위치 찾기용)
    ws = wb[SHEET]
    blocks = find_blocks(ws)
    names = list(blocks)
    print(f"양식 명단 {len(names)}명: {', '.join(names)}")

    edits = {}  # 셀주소 -> (값, 종류, 서식 가져올 셀)
    seen = set()
    report = {"채움": [], "고친 이름": [], "양식에 없음": [], "건너뜀": [], "확인 필요": []}
    with open(a.day_csv, encoding="utf-8-sig") as f:
        for rec in csv.DictReader(f):
            raw = rec["이름"].strip()
            kind = rec["구분"].strip()
            name, fixed = match_name(raw, names)
            if not name:
                report["양식에 없음"].append(raw)
                continue
            if name in seen:
                report["확인 필요"].append(f"{raw}: {name} 이(가) 입력에 두 번 — 두 번째는 건너뜀")
                continue
            seen.add(name)
            if fixed:
                report["고친 이름"].append(f"{raw}→{name}")
            if kind not in RULES:
                report["확인 필요"].append(f"{name}: 구분 '{kind}' 은 규칙 없음 — 직접 입력")
                continue
            c, top = blocks[name]
            r = date_row(ws, c, top, day)
            if not r:
                report["확인 필요"].append(f"{name}: 양식에 {day} 줄 없음")
                continue
            out_t, base, ot, note = RULES[kind]
            out_t = (rec.get("퇴근") or "").strip() or out_t
            ref = r - 1  # 서식은 앞날 줄에서
            vals = {c + 6: (to_time(out_t), "n") if out_t else None,
                    c + 7: (base, "n") if base is not None else None,
                    c + 8: (ot, "n") if ot is not None else None,
                    c + 9: (note, "s") if note else None}
            if kind in OT_KINDS:
                prev = [ws.cell(rr, c).value for rr in range(top + 2, r)]
                nums = [v for v in prev if isinstance(v, (int, float))]
                vals[c] = ((max(nums) if nums else 0) + 1, "n")
                later = [ws.cell(rr, c).value for rr in range(r + 1, top + 33)]
                if any(isinstance(v, (int, float)) for v in later):
                    report["확인 필요"].append(f"{name}: 뒤 날짜 번호를 다시 매겨야 함")
            busy = [col_letter(k) for k, v in vals.items() if v and ws.cell(r, k).value not in (None, "")]
            if busy and not a.force:
                report["건너뜀"].append(f"{name}: 이미 값 있음({','.join(busy)}{r})")
                continue
            vals.setdefault(c, None)
            for k, v in vals.items():
                if v:
                    edits[f"{col_letter(k)}{r}"] = (v[0], v[1], f"{col_letter(k)}{ref}")
                elif a.force and ws.cell(r, k).value not in (None, ""):
                    edits[f"{col_letter(k)}{r}"] = (None, "clear", None)
            if kind == "주간" and not out_t:
                report["확인 필요"].append(f"{name}: 주간 — 퇴근 시간은 출입기록에서 입력")
            report["채움"].append(f"{name} {kind}" + (f" {out_t}" if out_t else ""))

    # 시트 XML 찾기
    rels = {}
    with zipfile.ZipFile(a.template) as z:
        wbx = etree.fromstring(z.read("xl/workbook.xml"))
        relx = etree.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        for rel in relx:
            rels[rel.get("Id")] = rel.get("Target")
        rid = next(s.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
                   for s in wbx.find("m:sheets", NS) if s.get("name") == SHEET)
        sheet_path = "xl/" + rels[rid].lstrip("/").removeprefix("xl/")
        sx = etree.fromstring(z.read(sheet_path))

    cells = {c.get("r"): c for c in sx.iter("{%s}c" % NS["m"])}
    for addr, (val, typ, ref) in edits.items():
        cell = cells.get(addr)
        if cell is None:
            raise SystemExit(f"셀 {addr} 이 XML 에 없음 — 양식이 달라졌는지 확인")
        for ch in list(cell):
            cell.remove(ch)
        if typ == "clear":
            cell.attrib.pop("t", None)
            continue
        if ref in cells and cells[ref].get("s"):
            cell.set("s", cells[ref].get("s"))
        if typ == "s":
            cell.set("t", "inlineStr")
            is_ = etree.SubElement(cell, "{%s}is" % NS["m"])
            etree.SubElement(is_, "{%s}t" % NS["m"]).text = str(val)
        else:
            cell.attrib.pop("t", None)
            etree.SubElement(cell, "{%s}v" % NS["m"]).text = repr(val) if isinstance(val, float) else str(val)

    # 열 때 수식 다시 계산
    calc = wbx.find("m:calcPr", NS)
    if calc is None:
        calc = etree.SubElement(wbx, "{%s}calcPr" % NS["m"])
    calc.set("fullCalcOnLoad", "1")

    tmp = out.with_suffix(".tmp")
    with zipfile.ZipFile(a.template) as zi, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zo:
        for item in zi.infolist():
            data = zi.read(item.filename)
            if item.filename == sheet_path:
                data = etree.tostring(sx, xml_declaration=True, encoding="UTF-8", standalone=True)
            elif item.filename == "xl/workbook.xml":
                data = etree.tostring(wbx, xml_declaration=True, encoding="UTF-8", standalone=True)
            zo.writestr(item, data)
    shutil.move(tmp, out)

    print(f"\n{day} → {out}")
    for k, v in report.items():
        if v:
            print(f"[{k}] {len(v)}: " + " / ".join(v))
    return 0


if __name__ == "__main__":
    sys.exit(main())
