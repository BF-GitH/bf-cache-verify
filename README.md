# BF Cache Verify

SillyTavern UI-Extension, die prüft, ob **Claude Prompt-Caching über OpenRouter** (Chat Completions) tatsächlich funktioniert.

## Was es macht (6 Checks als Ampel-Checkliste)

1. **Einstellungen** — Quelle = OpenRouter, Modus = Chat Completion, Claude-Modell (Server injiziert `cache_control` nur bei Modell-IDs mit Präfix `anthropic/claude`), Streaming-Hinweis.
2. **config.yaml** — `claude.cachingAtDepth` (≠ -1, gerade Zahl empfohlen, z.B. 2) und `claude.enableSystemPromptCache` (via Companion-Plugin). Bei falschem Wert erscheint ein **🔧 Auto-Fix-Button**, der `cachingAtDepth: 2` direkt in die config.yaml schreibt (mit Backup `config.yaml.bak-bfcv`; danach ST neu starten). Nur `enableServerPlugins` selbst muss einmalig manuell auf `true` gesetzt werden — das Plugin, das die Datei schreibt, läuft erst, wenn dieser Wert schon stimmt (Henne-Ei).
3. **Mindest-Tokenzahl** — schätzt die Prompt-Länge und vergleicht mit dem Modell-Minimum (~4096 Opus 4.5+/Haiku 4.5, ~2048 Haiku 3.5, ~1024 Sonnet 4.x/Opus 4.x). Darunter wird **still** nicht gecacht.
4. **Präfix-Stabilität** — Snapshot des ausgehenden Prompts pro Chat; beim nächsten Mal Diff mit Anzeige der **ersten Abweichung** (dort bricht der Cache). Warnt vor `{{random}}`-Resten und Zeitstempeln im System-Prompt.
5. **Live-Beweis** — liest `usage.prompt_tokens_details` (cached_tokens / cache_write_tokens) aus der Antwort und holt via Plugin die OpenRouter-`/generation`-Statistik (`cache_discount`). Urteil: CACHE HIT / CACHE WRITE / NO CACHING.
6. **Live-Log** — alle Ergebnisse im Panel (mit Kopieren/Leeren) und via Plugin als JSON-Lines in eine Log-Datei auf der Platte.

Das Panel erscheint unten rechts; "Prüfen" führt alle Checks manuell aus. Einstellungen (aktivieren, Auto-Check, Plugin-URL) im Extensions-Drawer.

## Installation

### Variante A: Über den SillyTavern-Extension-Installer (empfohlen, funktioniert auch unter Termux)

1. SillyTavern öffnen → **Extensions** (Puzzle-Icon) → **Install extension**
2. Diese URL einfügen:

   ```
   https://github.com/BF-GitH/bf-cache-verify
   ```

3. Installieren, Seite neu laden, Extension im Extensions-Menü aktivieren.

### Variante B: Manuell per git

```bash
cd <SillyTavern>/public/scripts/extensions/third-party
git clone https://github.com/BF-GitH/bf-cache-verify
```

Danach SillyTavern-Seite neu laden. Updates später einfach mit `git pull` (oder über den ST-Extension-Manager).

> Für Check 2, `cache_discount` und die Log-Datei zusätzlich das Companion-Server-Plugin installieren: [bf-cache-verify-plugin](https://github.com/BF-GitH/bf-cache-verify-plugin) (Anleitung dort).

## Companion-Server-Plugin installieren (optional, aber empfohlen)

Ohne Plugin funktionieren Checks 1, 3, 4 und der usage-Teil von Check 5 trotzdem; Check 2, `cache_discount` und die Log-Datei brauchen das Plugin.

1. Plugin-Ordner anlegen: `SillyTavern/plugins/bf-cache-verify/` (mit `index.js`, das die Endpunkte `/probe`, `/config`, `/generation`, `/log`, `/log/tail` unter `/api/plugins/bf-cache-verify` bereitstellt).
2. In `config.yaml` setzen: `enableServerPlugins: true`
3. SillyTavern neu starten.

Der OpenRouter-API-Key wird vom Plugin serverseitig aus den ST-Secrets gelesen — er verlässt den Server nie Richtung Browser.

## Log-Datei live verfolgen

Datei: `SillyTavern/plugins/bf-cache-verify/cache-verify.log` (JSON-Lines).

**Windows (PowerShell):**

```powershell
Get-Content -Wait "C:\Users\RedLeader\Desktop\SillyTavern\plugins\bf-cache-verify\cache-verify.log"
```

**Termux / Android (und Linux allgemein):**

```bash
tail -f ~/SillyTavern/plugins/bf-cache-verify/cache-verify.log
```

Die Extension selbst ist reines Client-JavaScript ohne Build-Schritt und ohne Abhängigkeiten — sie läuft unter Termux genauso wie unter Windows.

## Hinweise

- Caching gilt nur für **Chat Completion**, nicht Text Completion.
- Ein einziges geändertes Byte früh im Prompt invalidiert alles danach. Typische Cache-Killer: `{{random}}`/`{{roll}}`/`{{pick}}`, Lorebook-Einträge mit variabler Position, Author's Note bei geringer Tiefe, Gruppenchats, Charakter-/Persona-Edits mitten im Chat.
- Ökonomie: Cache-Write 1.25x (5 min TTL) bzw. 2x (1 h), Cache-Read 0.1x.
