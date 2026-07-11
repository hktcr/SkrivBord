# KODDOKUMENTATION: Skrivr

**Typ:** Fristående HTML-app (single-file)  
**Skapad:** 2026-03-18  
**Status:** 🟢 MVP  
**Deploy:** [hktcr.github.io/SkrivBord](https://hktcr.github.io/SkrivBord/)

---

## Syfte

Minimalistisk markdown-editor med localStorage-persistens. Skrivyta med live-förhandsgranskning, visuell kontroll (färger, storlek, typsnitt), multi-dokument-tabbar, copy-to-clipboard och export (TXT/PDF).

## Arkitektur

| Komponent | Teknik |
|-----------|--------|
| **UI** | Enfilig HTML med inbäddad CSS + JS |
| **Rendering** | Marked.js (CDN) |
| **Persistens** | localStorage (dokument + inställningar) |
| **Typsnitt** | Google Fonts: Inter + Merriweather |
| **Export** | `.txt` via Blob, `.pdf` via `window.print()` |

## Filstruktur

```
SkrivBord/
├── index.html           # Hela appen
└── KODDOKUMENTATION.md  # Denna fil
```

## Datamodell (localStorage)

```json
{
  "skrivbord-docs": [
    {
      "id": "doc-...",
      "title": "Dokumentnamn",
      "content": "# Markdown...",
      "created": "ISO-datum",
      "modified": "ISO-datum"
    }
  ],
  "skrivbord-settings": {
    "previewBg": "#1a1b1e",
    "previewColor": "#c1c2c5",
    "fontSize": 16,
    "fontFamily": "serif",
    "editorBg": "#1a1b1e",
    "editorColor": "#e9ecef"
  },
  "skrivbord-active": "doc-id",
  "skrivbord-view": "both"
}
```

## Tangentbordsgenvägar

| Genväg | Funktion |
|--------|----------|
| `Cmd+N` | Nytt dokument |
| `Cmd+S` | Spara manuellt |
| `Cmd+P` | Exportera PDF |
| `Cmd+Shift+C` | Kopiera markdown |
| `Cmd+1-9` | Byt till flik 1-9 |
| `Esc` | Stäng inställningar/dialog |
| `Tab` | Indentera (4 mellanslag) |

## URL-import (gAIa → Skrivr)

Skrivr stödjer import via URL-parametrar. Detta möjliggör sömlös överlämning av dokument från gAIa-chatten.

**Format:**
```
https://hktcr.github.io/SkrivBord/?doc=BASE64&title=NAMN
```

| Parameter | Innehåll |
|-----------|----------|
| `doc` | Base64-kodat, URL-encodat markdown-innehåll |
| `title` | URL-encodat dokumentnamn |

**Flöde:**
1. Användaren ber gAIa om en "Skrivr-länk"
2. gAIa base64-kodar aktuell text och genererar en URL
3. Användaren klickar → Skrivr öppnar → dokument skapas
4. URL:en rensas automatiskt (förhindrar dubbletter vid omladdning)
5. Toast-notis: `📄 "Titel" importerat från gAIa`

**gAIa-agentens uppgift:** Vid begäran om Skrivr-länk:
```python
import base64, urllib.parse
encoded = base64.b64encode(urllib.parse.quote(content).encode()).decode()
title = urllib.parse.quote('Dokumenttitel')
url = f'https://hktcr.github.io/SkrivBord/?doc={encoded}&title={title}'
```

## Namnkonvention

| Kontext | Namn |
|---------|------|
| **UI / Branding** | Skrivr |
| **Katalognamn** | `SkrivBord/` (legacy, ej ändrad) |
| **localStorage-nycklar** | `skrivbord-*` (backward compat) |
| **GitHub-repo** | `hktcr/SkrivBord` |

## Beroenden

- **Marked.js** v14.1.4 (CDN) — samma version som MarkdownLens

---

*gAIa 🌲 2026-04-11*
