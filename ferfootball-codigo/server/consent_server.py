#!/usr/bin/env python3
"""
FerFootBall — Registro de consentimientos de cookies
-----------------------------------------------------
Recibe cada decisión del banner de cookies y la guarda, junto a la
dirección IP del visitante, en:
  - data/consentimientos.jsonl  (copia de seguridad, una línea por registro)
  - data/consentimientos.docx   (documento Word con la tabla de registros)

Endpoints:
  POST /api/consent                    -> guarda un consentimiento
  GET  /api/consents?key=CLAVE         -> lista en JSON (solo administrador)
  GET  /api/consents.docx?key=CLAVE    -> descarga el documento Word (solo administrador)
  GET  /api/health                     -> estado del servidor

La clave de administrador se lee de la variable FF_ADMIN_KEY; si no existe,
se genera una aleatoria y se guarda en data/admin_key.txt.

Ejecutar:  pip install fastapi uvicorn python-docx
           python consent_server.py
"""
import ipaddress
import json
import os
import secrets
import threading
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

BASE = Path(__file__).resolve().parent
DATA = BASE / "data"
DATA.mkdir(exist_ok=True)
JSONL = DATA / "consentimientos.jsonl"
DOCX = DATA / "consentimientos.docx"
KEY_FILE = DATA / "admin_key.txt"
TZ = ZoneInfo("Europe/Madrid")
LOCK = threading.Lock()
MAX_RECORDS_PER_IP_PER_HOUR = 30

if os.environ.get("FF_ADMIN_KEY"):
    ADMIN_KEY = os.environ["FF_ADMIN_KEY"]
elif KEY_FILE.exists():
    ADMIN_KEY = KEY_FILE.read_text().strip()
else:
    ADMIN_KEY = secrets.token_urlsafe(18)
    KEY_FILE.write_text(ADMIN_KEY)

# Orígenes permitidos (añade aquí el dominio de tu web)
ALLOWED = os.environ.get("FF_ALLOWED_ORIGINS", "*").split(",")

app = FastAPI(title="FerFootBall · Consentimientos")
app.add_middleware(CORSMiddleware, allow_origins=ALLOWED, allow_methods=["GET", "POST"], allow_headers=["*"])


class Choices(BaseModel):
    necessary: bool = True
    preferences: bool = False
    analytics: bool = False
    marketing: bool = False


class Consent(BaseModel):
    consent_id: str = Field(default="", max_length=64)
    action: str = Field(default="custom", max_length=20)  # accept_all | reject_all | custom
    choices: Choices
    version: int = 1
    page: str = Field(default="", max_length=2000)
    language: str = Field(default="", max_length=100)
    client_ip: str = Field(default="", max_length=64)  # IP pública detectada por el navegador (respaldo)


# ---------- Utilidades ----------
def valid_ip(value: str) -> str:
    try:
        return str(ipaddress.ip_address(value.strip()))
    except (ValueError, AttributeError):
        return ""


def is_public(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
        return not (a.is_private or a.is_loopback or a.is_link_local or a.is_reserved)
    except ValueError:
        return False


def request_ip(req: Request) -> str:
    """IP real del visitante teniendo en cuenta proxies y CDN."""
    for header in ("cf-connecting-ip", "true-client-ip", "x-real-ip"):
        ip = valid_ip(req.headers.get(header, ""))
        if ip:
            return ip
    fwd = req.headers.get("x-forwarded-for", "")
    for part in fwd.split(","):
        ip = valid_ip(part)
        if ip and is_public(ip):
            return ip
    return req.client.host if req.client else ""


def load_records():
    if not JSONL.exists():
        return []
    out = []
    with JSONL.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return out


def short_ua(ua: str) -> str:
    """Resume el user-agent: navegador + sistema."""
    import re
    browser = "Otro"
    for name, pat in (("Edge", r"Edg/(\d+)"), ("Opera", r"OPR/(\d+)"), ("Samsung", r"SamsungBrowser/(\d+)"),
                      ("Chrome", r"Chrome/(\d+)"), ("Firefox", r"Firefox/(\d+)"), ("Safari", r"Version/(\d+).*Safari")):
        m = re.search(pat, ua)
        if m:
            browser = f"{name} {m.group(1)}"
            break
    system = "—"
    for name, pat in (("Android", "Android"), ("iPhone", "iPhone"), ("iPad", "iPad"), ("Windows", "Windows"),
                      ("macOS", "Mac OS X"), ("Linux", "Linux")):
        if pat in ua:
            system = name
            break
    return f"{browser} · {system}"


def yes(v: bool) -> str:
    return "Sí" if v else "No"


ACTION_ES = {"accept_all": "Aceptar todas", "reject_all": "Rechazar opcionales", "custom": "Personalizado"}


def shade(cell, hex_color: str):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hex_color)
    tc_pr.append(shd)


def build_docx(records):
    """Genera el documento Word completo con todos los registros."""
    doc = Document()
    sec = doc.sections[0]
    sec.orientation = WD_ORIENT.LANDSCAPE
    sec.page_width, sec.page_height = sec.page_height, sec.page_width
    for side in ("left_margin", "right_margin", "top_margin", "bottom_margin"):
        setattr(sec, side, Cm(1.5))

    style = doc.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(9)

    title = doc.add_heading("FerFootBall · Registro de consentimientos de cookies", level=1)
    title.alignment = WD_ALIGN_PARAGRAPH.LEFT
    now = datetime.now(TZ).strftime("%d/%m/%Y %H:%M")
    p = doc.add_paragraph()
    p.add_run(f"Generado el {now} (hora de Madrid) · Total de registros: {len(records)}").italic = True
    doc.add_paragraph(
        "Prueba del consentimiento conforme al art. 7.1 del RGPD y al art. 22.2 de la LSSI-CE. "
        "Cada fila recoge la decisión del visitante en el banner de cookies, la fecha y hora, "
        "y la dirección IP desde la que se realizó."
    )

    if records:
        accepted = sum(1 for r in records if r["action"] == "accept_all")
        rejected = sum(1 for r in records if r["action"] == "reject_all")
        custom = len(records) - accepted - rejected
        doc.add_paragraph(f"Resumen: {accepted} aceptan todas · {rejected} rechazan opcionales · {custom} personalizadas.")

    headers = ["#", "Fecha y hora", "Dirección IP", "IP (navegador)", "Acción", "Prefer.",
               "Analíticas", "Marketing", "Página", "Navegador", "ID consentimiento"]
    widths = [0.7, 2.4, 3.0, 3.0, 2.5, 1.9, 1.8, 1.8, 1.6, 3.1, 4.2]
    table = doc.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    table.autofit = False
    for i, h in enumerate(headers):
        cell = table.rows[0].cells[i]
        cell.text = ""
        run = cell.paragraphs[0].add_run(h)
        run.bold = True
        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        shade(cell, "FF4D2E")

    for n, r in enumerate(records, 1):
        row = table.add_row().cells
        values = [
            str(n), r["date_local"], r["ip"], r.get("client_ip") or "—", ACTION_ES.get(r["action"], r["action"]),
            yes(r["choices"]["preferences"]), yes(r["choices"]["analytics"]), yes(r["choices"]["marketing"]),
            r.get("page", "") or "/", short_ua(r.get("user_agent", "")), r["consent_id"],
        ]
        for i, v in enumerate(values):
            row[i].text = v
            if n % 2 == 0:
                shade(row[i], "F3F1EC")

    # Anchos fijos (Word usa las celdas; LibreOffice usa la rejilla de columnas)
    grid = table._tbl.tblGrid
    for i, col in enumerate(grid.findall(qn("w:gridCol"))):
        col.set(qn("w:w"), str(int(Cm(widths[i]).twips)))
    for row in table.rows:
        for i, w in enumerate(widths):
            row.cells[i].width = Cm(w)

    if not records:
        doc.add_paragraph("Todavía no hay registros.")

    tmp = DOCX.with_suffix(".tmp.docx")
    doc.save(tmp)
    tmp.replace(DOCX)


def check_key(key: str):
    if not key or not secrets.compare_digest(key, ADMIN_KEY):
        raise HTTPException(status_code=401, detail="Clave de administrador incorrecta")


# ---------- Endpoints ----------
@app.get("/api/health")
def health():
    return {"ok": True, "records": len(load_records())}


@app.post("/api/consent", status_code=201)
def save_consent(body: Consent, request: Request):
    ip = request_ip(request)
    client_ip = valid_ip(body.client_ip)
    # Si el servidor solo ve una IP interna (proxy), usa la que detectó el navegador
    if (not ip or not is_public(ip)) and client_ip:
        ip_shown = client_ip
    else:
        ip_shown = ip
    now = datetime.now(TZ)
    record = {
        "consent_id": body.consent_id or uuid.uuid4().hex,
        "date_iso": now.isoformat(),
        "date_local": now.strftime("%d/%m/%Y %H:%M:%S"),
        "ip": ip_shown or "desconocida",
        "server_ip": ip,
        "client_ip": client_ip,
        "action": body.action if body.action in ACTION_ES else "custom",
        "choices": body.choices.model_dump(),
        "version": body.version,
        "page": body.page[:200],
        "language": body.language,
        "user_agent": request.headers.get("user-agent", "")[:300],
    }
    with LOCK:
        records = load_records()
        hour_ago = now.timestamp() - 3600
        recent = [r for r in records if r["ip"] == record["ip"]
                  and datetime.fromisoformat(r["date_iso"]).timestamp() > hour_ago]
        if len(recent) >= MAX_RECORDS_PER_IP_PER_HOUR:
            raise HTTPException(status_code=429, detail="Demasiadas solicitudes")
        with JSONL.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        records.append(record)
        build_docx(records)
    return {"saved": True, "consent_id": record["consent_id"], "ip": record["ip"]}


@app.get("/api/consents")
def list_consents(key: str = ""):
    check_key(key)
    return load_records()


@app.get("/api/consents.docx")
def download_docx(key: str = ""):
    check_key(key)
    with LOCK:
        build_docx(load_records())
    return FileResponse(
        DOCX,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename=f"consentimientos-cookies-{datetime.now(TZ):%Y%m%d}.docx",
    )


if __name__ == "__main__":
    import uvicorn
    print(f"Clave de administrador: {ADMIN_KEY}")
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
