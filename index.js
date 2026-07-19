// BF Cache Verify — SillyTavern UI extension
// Verifies whether Claude prompt caching works via OpenRouter chat completions.
// All SillyTavern access goes through the global SillyTavern.getContext()
// (same pattern as bf-memory-pipeline) — no static imports, no build step.
//
// Companion server plugin (optional, graceful degradation if missing):
//   GET  <pluginBase>/probe            -> { ok: true, version }
//   GET  <pluginBase>/config           -> { claude/effective: <boot-time values>, file: <fresh parse>, restartRequired, raw }
//   GET  <pluginBase>/generation?id=X  -> { ok, data: { cache_discount, native_tokens_cached, ... } }
//   POST <pluginBase>/fix-config {cachingAtDepth} -> { ok, from, to, backup, restartRequired }
//   POST <pluginBase>/log {line}       -> { ok: true }
//   GET  <pluginBase>/log/tail?n=200   -> { lines: [...] }

'use strict';

(function () {
    const EXT_NAME = 'bf-cache-verify';
    const LOG_PREFIX = '[BFCacheVerify]';
    const VERSION = '1.1.0';

    const DEFAULT_SETTINGS = {
        enabled: true,
        autoCheck: true,
        pluginBase: '/api/plugins/bf-cache-verify',
        panelCollapsed: false,
    };

    /** @type {typeof DEFAULT_SETTINGS} */
    let settings = { ...DEFAULT_SETTINGS };

    // 'unknown' | 'ok' | 'down'
    let pluginState = 'unknown';
    let pluginVersion = null;

    // In-memory prompt snapshots keyed by chat id (check 4).
    const snapshots = new Map();

    // Last intercepted /generate request+response (check 5).
    let lastCapture = null;
    // Last CHAT_COMPLETION_SETTINGS_READY payload facts.
    let lastRequestMeta = null;

    // ---------------------------------------------------------------- helpers

    function ctx() {
        return SillyTavern.getContext();
    }

    function nowStamp() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function waitFor(condFn, timeoutMs, intervalMs = 250) {
        return new Promise((resolve) => {
            const started = Date.now();
            const timer = setInterval(() => {
                let ok = false;
                try { ok = condFn(); } catch { /* ignore */ }
                if (ok || Date.now() - started > timeoutMs) {
                    clearInterval(timer);
                    resolve(ok);
                }
            }, intervalMs);
        });
    }

    // -------------------------------------------------------------- settings

    function loadSettings() {
        try {
            const c = ctx();
            const stored = c.extensionSettings[EXT_NAME] || {};
            settings = { ...DEFAULT_SETTINGS, ...stored };
            c.extensionSettings[EXT_NAME] = settings;
        } catch (err) {
            console.error(LOG_PREFIX, 'loadSettings failed', err);
        }
    }

    function saveSettings() {
        try {
            const c = ctx();
            c.extensionSettings[EXT_NAME] = settings;
            c.saveSettingsDebounced();
        } catch (err) {
            console.error(LOG_PREFIX, 'saveSettings failed', err);
        }
    }

    // ------------------------------------------------------------ log (check 6)

    const logLines = [];

    function log(message, level = 'info') {
        const line = `[${nowStamp()}] ${message}`;
        logLines.push({ line, level });
        if (logLines.length > 500) logLines.splice(0, logLines.length - 500);

        try {
            const el = document.getElementById('bfcv-log');
            if (el) {
                const div = document.createElement('div');
                div.className = `bfcv-log-line bfcv-log-${level}`;
                div.textContent = line;
                el.appendChild(div);
                while (el.childElementCount > 500) el.removeChild(el.firstChild);
                el.scrollTop = el.scrollHeight;
            }
        } catch { /* ignore DOM errors */ }

        console.debug(LOG_PREFIX, message);
        postLogToPlugin(`[${level}] ${message}`);
    }

    function postLogToPlugin(line) {
        if (pluginState !== 'ok') return;
        try {
            pluginFetch('/log', {
                method: 'POST',
                body: JSON.stringify({ line }),
            }).catch(() => { /* silent — do not recurse into log() */ });
        } catch { /* ignore */ }
    }

    // ---------------------------------------------------------- plugin client

    function pluginBase() {
        return (settings.pluginBase || DEFAULT_SETTINGS.pluginBase).replace(/\/+$/, '');
    }

    async function pluginFetch(path, opts = {}) {
        const c = ctx();
        const headers = typeof c.getRequestHeaders === 'function'
            ? c.getRequestHeaders()
            : { 'Content-Type': 'application/json' };
        const resp = await fetch(pluginBase() + path, { headers, ...opts });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
    }

    async function probePlugin() {
        try {
            const data = await pluginFetch('/probe');
            if (data && data.ok) {
                pluginState = 'ok';
                pluginVersion = data.version || '?';
                return true;
            }
            pluginState = 'down';
            return false;
        } catch {
            pluginState = 'down';
            return false;
        }
    }

    const PLUGIN_DOWN_HINT = 'Plugin nicht erreichbar — Companion-Plugin installieren (SillyTavern/plugins/bf-cache-verify) und in config.yaml enableServerPlugins: true setzen, dann ST neu starten.';

    // ------------------------------------------------------------- checklist UI

    // state: 'green' | 'yellow' | 'red' | 'gray'
    function setLight(checkNo, state, detailHtml) {
        try {
            const row = document.getElementById(`bfcv-check-${checkNo}`);
            if (!row) return;
            const light = row.querySelector('.bfcv-light');
            light.className = `bfcv-light bfcv-${state}`;
            const detail = row.querySelector('.bfcv-check-detail');
            detail.innerHTML = detailHtml;
        } catch (err) {
            console.error(LOG_PREFIX, 'setLight failed', err);
        }
    }

    // ------------------------------------------------------ check 1: settings

    function runCheck1() {
        try {
            const c = ctx();
            const isChatCompletion = c.mainApi === 'openai';
            const source = c.chatCompletionSettings?.chat_completion_source || '(unbekannt)';
            const isOpenRouter = source === 'openrouter';
            let model = '';
            try { model = c.getChatCompletionModel() || ''; } catch { /* ignore */ }
            const isClaude = /claude/i.test(model);
            // Server-side gate: cache_control is only injected when the model matches /^anthropic\/claude/
            const matchesServerGate = /^anthropic\/claude/.test(model);
            const streaming = !!c.chatCompletionSettings?.stream_openai;

            const items = [];
            const li = (ok, text) => items.push(`<span class="bfcv-mini ${ok ? 'bfcv-ok' : 'bfcv-bad'}">${ok ? '✔' : '✘'}</span> ${text}`);
            li(isChatCompletion, `Modus: ${isChatCompletion ? 'Chat Completion' : escapeHtml(String(c.mainApi)) + ' (Caching nur im Chat-Completion-Modus!)'}`);
            li(isOpenRouter, `Quelle: ${escapeHtml(source)}${isOpenRouter ? '' : ' (OpenRouter erwartet)'}`);
            li(isClaude, `Modell: ${escapeHtml(model || '(keins)')}${isClaude ? '' : ' (kein Claude-Modell)'}`);
            if (isClaude && !matchesServerGate) {
                items.push('<span class="bfcv-mini bfcv-warn">⚠</span> Modell-ID beginnt nicht mit "anthropic/claude" — ST injiziert cache_control serverseitig nur bei diesem Präfix!');
            }
            items.push(`<span class="bfcv-mini bfcv-info">ℹ</span> Streaming: ${streaming ? 'AN (usage evtl. nicht im Stream sichtbar; Plugin-Lookup wird genutzt)' : 'AUS'}`);

            const allOk = isChatCompletion && isOpenRouter && isClaude && matchesServerGate;
            setLight(1, allOk ? 'green' : (isChatCompletion && isOpenRouter && isClaude ? 'yellow' : 'red'), items.join('<br>'));
            log(`Check 1 (Einstellungen): Modus=${c.mainApi}, Quelle=${source}, Modell=${model || '-'}, Streaming=${streaming} → ${allOk ? 'OK' : 'PROBLEM'}`, allOk ? 'ok' : 'warn');
            return allOk;
        } catch (err) {
            setLight(1, 'gray', `Fehler: ${escapeHtml(err.message)}`);
            log(`Check 1 Fehler: ${err.message}`, 'error');
            return false;
        }
    }

    // --------------------------------------------------- check 2: config.yaml

    async function runCheck2() {
        try {
            if (pluginState !== 'ok') await probePlugin();
            if (pluginState !== 'ok') {
                setLight(2, 'gray', escapeHtml(PLUGIN_DOWN_HINT));
                log('Check 2 (config.yaml): Plugin nicht erreichbar — übersprungen.', 'warn');
                return null;
            }
            const data = await pluginFetch('/config');
            // 'effective' = boot-time values the RUNNING server uses; 'file' =
            // fresh parse of config.yaml. ST reads the claude section only once
            // at startup, so the verdict must be based on 'effective'.
            const eff = data?.effective ?? data?.claude ?? {};
            const depth = eff.cachingAtDepth;
            const sysCache = eff.enableSystemPromptCache;
            const items = [];
            let state = 'green';

            const fixButton = ' <button id="bfcv-btn-fixdepth" class="bfcv-btn bfcv-btn-fix" title="Setzt claude.cachingAtDepth = 2 in config.yaml (Backup wird angelegt). Danach ST neu starten!">🔧 Auto-Fix: auf 2 setzen</button>';
            if (typeof depth !== 'number' || depth === -1) {
                state = 'red';
                items.push('<span class="bfcv-mini bfcv-bad">✘</span> claude.cachingAtDepth = ' + escapeHtml(String(depth)) + ' → Nachrichten-Caching DEAKTIVIERT.' + fixButton);
            } else if (depth % 2 !== 0) {
                state = 'yellow';
                items.push(`<span class="bfcv-mini bfcv-warn">⚠</span> claude.cachingAtDepth = ${depth} (ungerade). Gerade Zahl empfohlen, z.B. 2 — ungerade Tiefe setzt den Breakpoint auf eine User-Nachricht-Grenze, die sich häufiger verschiebt.${fixButton}`);
            } else {
                items.push(`<span class="bfcv-mini bfcv-ok">✔</span> claude.cachingAtDepth = ${depth}`);
            }
            items.push(`<span class="bfcv-mini bfcv-info">ℹ</span> claude.enableSystemPromptCache = ${escapeHtml(String(sysCache))} (bei OpenRouter ist System-Prompt-Caching effektiv immer aktiv, sobald ein Breakpoint existiert)`);

            if (data?.restartRequired) {
                if (state === 'green') state = 'yellow';
                const f = data.file ?? {};
                items.push(`<span class="bfcv-mini bfcv-warn">⚠</span> config.yaml geändert — ST-Neustart nötig! Der laufende Server nutzt noch die Werte oben; auf der Festplatte steht bereits: cachingAtDepth=${escapeHtml(String(f.cachingAtDepth))}, enableSystemPromptCache=${escapeHtml(String(f.enableSystemPromptCache))}.`);
            }

            setLight(2, state, items.join('<br>'));
            // setLight replaces innerHTML — (re)wire the auto-fix button afterwards.
            const fixBtn = document.getElementById('bfcv-btn-fixdepth');
            if (fixBtn) fixBtn.addEventListener('click', () => { autoFixDepth().catch(() => { /* logged inside */ }); });
            log(`Check 2 (config.yaml): cachingAtDepth=${depth}, enableSystemPromptCache=${sysCache}${data?.restartRequired ? ' [config.yaml geändert — Neustart nötig]' : ''} → ${state.toUpperCase()}`, state === 'green' ? 'ok' : 'warn');
            return data;
        } catch (err) {
            setLight(2, 'gray', `Fehler beim Abruf: ${escapeHtml(err.message)}. ${escapeHtml(PLUGIN_DOWN_HINT)}`);
            log(`Check 2 Fehler: ${err.message}`, 'error');
            return null;
        }
    }

    /**
     * Auto-fix: let the plugin set claude.cachingAtDepth = 2 in config.yaml
     * (comment-preserving, with backup). Only cachingAtDepth can be automated —
     * enableServerPlugins can't fix itself: the plugin that writes config.yaml
     * only runs once that flag is already true.
     */
    async function autoFixDepth() {
        try {
            log('Auto-Fix: setze claude.cachingAtDepth = 2 in config.yaml …', 'info');
            const resp = await pluginFetch('/fix-config', {
                method: 'POST',
                body: JSON.stringify({ cachingAtDepth: 2 }),
            });
            if (resp?.ok) {
                log(`Auto-Fix erfolgreich: cachingAtDepth ${String(resp.from)} → ${resp.to} (Backup: ${resp.backup}). WICHTIG: SillyTavern neu starten, damit der Wert wirkt!`, 'ok');
            } else {
                log(`Auto-Fix fehlgeschlagen: ${resp?.error || 'unbekannter Fehler'}`, 'error');
            }
            await runCheck2();
        } catch (err) {
            log(`Auto-Fix Fehler: ${err.message}`, 'error');
        }
    }

    // ------------------------------------------- check 3: minimum token count

    function minCacheTokens(model) {
        const m = String(model || '').toLowerCase();
        // Opus 4.5+ and Haiku 4.5: ~4096; Haiku 3.5: ~2048; Sonnet 4/4.5/4.6, Opus 4/4.1: ~1024.
        if (/opus[-.]?4[.-][5-9]/.test(m)) return 4096;
        if (/haiku/.test(m)) {
            if (/4[.-]5|4\.5/.test(m)) return 4096;
            if (/3[.-]5|3\.5/.test(m)) return 2048;
            return 2048;
        }
        return 1024;
    }

    function contentToText(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content.map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part.text === 'string') return part.text;
                if (part && part.type === 'image_url') return '[image]';
                return JSON.stringify(part ?? null);
            }).join('\n');
        }
        return content == null ? '' : JSON.stringify(content);
    }

    async function estimateTokens(text) {
        try {
            const c = ctx();
            if (typeof c.getTokenCountAsync === 'function') {
                const n = await c.getTokenCountAsync(text);
                if (Number.isFinite(n) && n > 0) return { count: n, method: 'ST-Tokenizer' };
            }
        } catch { /* fall through to heuristic */ }
        return { count: Math.ceil(text.length / 3.5), method: 'Heuristik (Zeichen/3.5)' };
    }

    async function runCheck3(normalized) {
        try {
            let model = '';
            try { model = ctx().getChatCompletionModel() || ''; } catch { /* ignore */ }
            const minTokens = minCacheTokens(model);
            const fullText = normalized.map((m) => m.text).join('\n');
            const { count, method } = await estimateTokens(fullText);

            if (count >= minTokens) {
                setLight(3, 'green', `Prompt ≈ ${count} Tokens (${method}) ≥ Minimum ${minTokens} für ${escapeHtml(model || 'Claude')}.`);
                log(`Check 3 (Tokens): ≈${count} Tokens (${method}), Minimum ${minTokens} → OK`, 'ok');
            } else {
                setLight(3, 'red', `Prompt ≈ ${count} Tokens (${method}) &lt; Minimum ${minTokens} für ${escapeHtml(model || 'Claude')} — unterhalb der Schwelle wird STILL nicht gecacht (kein Fehler von Anthropic!).`);
                log(`Check 3 (Tokens): ≈${count} < Minimum ${minTokens} → ZU KURZ, kein Caching möglich`, 'warn');
            }
        } catch (err) {
            setLight(3, 'gray', `Fehler: ${escapeHtml(err.message)}`);
            log(`Check 3 Fehler: ${err.message}`, 'error');
        }
    }

    // ------------------------------------- check 4: prefix stability / diffing

    function normalizeMessages(chat) {
        return (chat || []).map((m) => ({
            role: String(m?.role ?? ''),
            text: contentToText(m?.content),
        }));
    }

    function firstDiffPos(a, b) {
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
        return n;
    }

    function excerptAt(text, pos, span = 60) {
        const start = Math.max(0, pos - Math.floor(span / 2));
        const cut = text.slice(start, start + span);
        return (start > 0 ? '…' : '') + cut + (start + span < text.length ? '…' : '');
    }

    function detectVolatileContent(normalized) {
        const warnings = [];
        const sys = normalized.filter((m) => m.role === 'system').map((m) => m.text).join('\n');
        if (/\{\{(random|roll|pick)[^}]*\}\}/i.test(sys)) {
            warnings.push('Unersetztes {{random}}/{{roll}}/{{pick}}-Makro im System-Prompt gefunden.');
        }
        // Substituted {{random}}/{{roll}} results can't be detected statically — the diff catches them.
        if (/\b\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM|Uhr)?\b/i.test(sys) || /\b\d{4}-\d{2}-\d{2}\b/.test(sys)) {
            warnings.push('Zeit-/Datumsangabe im System-Prompt gefunden — {{time}}/{{date}}-Makros zerstören den Cache bei jeder Anfrage.');
        }
        return warnings;
    }

    function runCheck4(normalized) {
        try {
            const chatId = ctx().chatId ?? '(no-chat)';
            const prev = snapshots.get(chatId);
            snapshots.set(chatId, normalized);

            const volatileWarnings = detectVolatileContent(normalized);

            if (!prev) {
                const extra = volatileWarnings.length
                    ? '<br><span class="bfcv-mini bfcv-warn">⚠</span> ' + volatileWarnings.map(escapeHtml).join('<br><span class="bfcv-mini bfcv-warn">⚠</span> ')
                    : '';
                setLight(4, volatileWarnings.length ? 'yellow' : 'gray', `Erster Snapshot für diesen Chat gespeichert (${normalized.length} Nachrichten). Diff ab der nächsten Generierung.${extra}`);
                log(`Check 4 (Präfix): erster Snapshot (${normalized.length} Nachrichten)${volatileWarnings.length ? '; Warnungen: ' + volatileWarnings.join(' | ') : ''}`, volatileWarnings.length ? 'warn' : 'info');
                return;
            }

            // Find first divergence point.
            let divergence = null;
            const n = Math.max(prev.length, normalized.length);
            for (let i = 0; i < n; i++) {
                const a = prev[i];
                const b = normalized[i];
                if (!a) { divergence = { index: i, desc: `Nachricht neu hinzugefügt (${b.role})`, excerpt: excerptAt(b.text, 0) }; break; }
                if (!b) { divergence = { index: i, desc: `Nachricht entfernt (${a.role})`, excerpt: excerptAt(a.text, 0) }; break; }
                if (a.role !== b.role) { divergence = { index: i, desc: `Rolle geändert: ${a.role} → ${b.role}`, excerpt: excerptAt(b.text, 0) }; break; }
                if (a.text !== b.text) {
                    const pos = firstDiffPos(a.text, b.text);
                    divergence = {
                        index: i,
                        desc: `Inhalt geändert (${a.role}, ab Zeichen ${pos})`,
                        excerpt: `vorher: "${excerptAt(a.text, pos)}"\nnachher: "${excerptAt(b.text, pos)}"`,
                    };
                    break;
                }
            }

            const volatileHtml = volatileWarnings.length
                ? '<br><span class="bfcv-mini bfcv-warn">⚠</span> ' + volatileWarnings.map(escapeHtml).join('<br><span class="bfcv-mini bfcv-warn">⚠</span> ')
                : '';

            if (!divergence) {
                setLight(4, 'green', `Prompt identisch zum letzten Snapshot (${normalized.length} Nachrichten) — perfekte Cache-Voraussetzung (voller Präfix-Treffer).${volatileHtml}`);
                log('Check 4 (Präfix): identisch zum letzten Prompt → optimal für Cache-Hit', 'ok');
            } else {
                const tailAppend = divergence.index >= prev.length;
                const state = tailAppend ? 'green' : (divergence.index <= 1 ? 'red' : 'yellow');
                const where = tailAppend
                    ? `Nur am Ende angehängt (Index ${divergence.index}) — Präfix stabil, Cache kann greifen.`
                    : `ERSTE Abweichung bei Nachricht #${divergence.index}: ${escapeHtml(divergence.desc)} — ab hier bricht der Cache; alles danach wird neu berechnet.`;
                setLight(4, state, `${where}<br><code class="bfcv-excerpt">${escapeHtml(divergence.excerpt)}</code>${volatileHtml}`);
                log(`Check 4 (Präfix): Abweichung bei #${divergence.index} (${divergence.desc})${tailAppend ? ' [nur Anhang — ok]' : ' [CACHE-BRUCH]'}`, state === 'green' ? 'ok' : 'warn');
            }
        } catch (err) {
            setLight(4, 'gray', `Fehler: ${escapeHtml(err.message)}`);
            log(`Check 4 Fehler: ${err.message}`, 'error');
        }
    }

    // -------------------------------------------- check 5: live proof (usage)

    // Intercept window.fetch for /api/backends/chat-completions/generate.
    // ST core never surfaces API usage / the OpenRouter generation id to
    // extensions, so this is the only client-side route (confirmed by recon).
    function installFetchInterceptor() {
        const origFetch = window.fetch.bind(window);
        window.fetch = function (input, init) {
            try {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                if (!settings.enabled || !url.includes('/api/backends/chat-completions/generate')) {
                    return origFetch(input, init);
                }

                let reqBody = null;
                try {
                    if (init && typeof init.body === 'string') reqBody = JSON.parse(init.body);
                } catch { /* ignore */ }

                // Quiet generations (summaries, captioning, /gen, background prompts
                // from other extensions) go through the same endpoint. Never let them
                // overwrite lastCapture — check 5 must report the user's real message.
                if (reqBody && reqBody.type === 'quiet') {
                    return origFetch(input, init);
                }

                const capture = {
                    pending: true,
                    id: null,
                    usage: null,
                    streaming: !!(reqBody && reqBody.stream),
                    model: reqBody?.model ?? null,
                    source: reqBody?.chat_completion_source ?? null,
                    ts: Date.now(),
                };
                lastCapture = capture;

                return origFetch(input, init).then((resp) => {
                    try {
                        if (!resp.ok || !resp.body) {
                            capture.pending = false;
                            return resp;
                        }
                        const clone = resp.clone();
                        if (capture.streaming) {
                            consumeStreamClone(clone, capture);
                        } else {
                            clone.json()
                                .then((json) => {
                                    capture.id = json?.id ?? null;
                                    capture.usage = json?.usage ?? null;
                                })
                                .catch(() => { /* ignore */ })
                                .finally(() => { capture.pending = false; });
                        }
                    } catch {
                        capture.pending = false;
                    }
                    return resp;
                }, (err) => {
                    capture.pending = false;
                    throw err;
                });
            } catch (err) {
                console.error(LOG_PREFIX, 'fetch interceptor error', err);
                return origFetch(input, init);
            }
        };
    }

    async function consumeStreamClone(clone, capture) {
        try {
            const reader = clone.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const rawLine of lines) {
                    const line = rawLine.trim();
                    if (!line.startsWith('data:')) continue;
                    const payload = line.slice(5).trim();
                    if (!payload || payload === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(payload);
                        if (parsed?.id) capture.id = parsed.id;
                        if (parsed?.usage) capture.usage = parsed.usage;
                    } catch { /* partial/non-JSON chunk */ }
                }
            }
        } catch { /* stream aborted etc. */ }
        finally { capture.pending = false; }
    }

    function extractCacheNumbers(usage) {
        const details = usage?.prompt_tokens_details || {};
        const cachedRead = details.cached_tokens
            ?? usage?.cache_read_input_tokens
            ?? 0;
        const cacheWrite = details.cache_write_tokens
            ?? details.cache_creation_tokens
            ?? usage?.cache_creation_input_tokens
            ?? 0;
        return { cachedRead: Number(cachedRead) || 0, cacheWrite: Number(cacheWrite) || 0 };
    }

    async function runCheck5AfterGeneration() {
        const capture = lastCapture;
        if (!capture) {
            setLight(5, 'gray', 'Keine Generierung abgefangen.');
            return;
        }
        try {
            // Wait until the response body (or stream clone) is fully consumed.
            await waitFor(() => !capture.pending, 8000);

            const { cachedRead, cacheWrite } = extractCacheNumbers(capture.usage);
            const hasUsage = !!capture.usage;

            // Plugin proxy for OpenRouter /generation stats (cache_discount).
            let genStats = null;
            if (capture.id && pluginState === 'ok') {
                try {
                    const resp = await pluginFetch(`/generation?id=${encodeURIComponent(capture.id)}`);
                    if (resp?.ok && resp.data) genStats = resp.data;
                } catch (err) {
                    log(`Check 5: OpenRouter /generation-Lookup fehlgeschlagen: ${err.message}`, 'warn');
                }
            } else if (capture.id && pluginState !== 'ok') {
                log('Check 5: cache_discount-Lookup übersprungen (Plugin nicht erreichbar).', 'warn');
            }

            const discount = genStats?.cache_discount;
            const nativeCached = Number(genStats?.native_tokens_cached) || 0;
            const discountStr = (typeof discount === 'number' && discount !== 0)
                ? ` cache_discount: $${discount.toFixed(6)}${discount > 0 ? ' gespart' : ' (Aufpreis für Cache-Write)'}`
                : '';

            let verdict, state;
            const effectiveRead = Math.max(cachedRead, nativeCached);
            if (effectiveRead > 0) {
                verdict = `CACHE HIT — ${effectiveRead} Tokens aus dem Cache gelesen (≈0.1x Kosten).${discountStr}`;
                state = 'green';
            } else if (cacheWrite > 0 || (typeof discount === 'number' && discount < 0)) {
                verdict = `CACHE WRITE — ${cacheWrite || '?'} Tokens in den Cache geschrieben (erste Anfrage / Präfix geändert; 1.25x Kosten, nächste Anfrage sollte HIT sein).${discountStr}`;
                state = 'yellow';
            } else if (hasUsage || genStats) {
                verdict = `NO CACHING — usage meldet weder Cache-Read noch Cache-Write.${discountStr} Checks 1-4 prüfen!`;
                state = 'red';
            } else {
                verdict = capture.streaming
                    ? 'Keine usage-Daten im Stream sichtbar und kein Plugin-Lookup möglich — keine Aussage. (Plugin installieren oder Streaming testweise ausschalten.)'
                    : 'Keine usage-Daten in der Antwort — keine Aussage.';
                state = 'gray';
            }

            const meta = `Modell: ${escapeHtml(capture.model || '?')}, Streaming: ${capture.streaming}, gen-id: ${escapeHtml(capture.id || '-')}`;
            setLight(5, state, `${escapeHtml(verdict)}<br><span class="bfcv-mini bfcv-info">ℹ</span> ${meta}`);
            log(`Check 5 (Live-Beweis): ${verdict}`, state === 'green' ? 'ok' : (state === 'red' ? 'error' : 'warn'));
        } catch (err) {
            setLight(5, 'gray', `Fehler: ${escapeHtml(err.message)}`);
            log(`Check 5 Fehler: ${err.message}`, 'error');
        }
    }

    // ------------------------------------------------------------ event hooks

    // Prompt staged by PROMPT_READY, committed or discarded by SETTINGS_READY.
    // PROMPT_READY fires for EVERY chat-completion generation, including type
    // 'quiet' (summaries, captioning, background prompts) — but only
    // SETTINGS_READY carries generate_data.type, and it always follows
    // PROMPT_READY within the same generation (openai.js:1610 vs 3052).
    // Committing only on non-quiet generations keeps the per-chat snapshot
    // (check 4 diff baseline) free of quiet-prompt pollution.
    let stagedPrompt = null;

    function onPromptReady(eventData) {
        try {
            if (!settings.enabled || !settings.autoCheck) return;
            if (!eventData || eventData.dryRun) return;
            stagedPrompt = normalizeMessages(eventData.chat);
        } catch (err) {
            log(`PROMPT_READY-Handler Fehler: ${err.message}`, 'error');
        }
    }

    function onSettingsReady(generateData) {
        try {
            if (!settings.enabled) return;
            lastRequestMeta = {
                stream: !!generateData?.stream,
                model: generateData?.model ?? null,
                source: generateData?.chat_completion_source ?? null,
                type: generateData?.type ?? null,
            };
            log(`Anfrage geht raus: Quelle=${lastRequestMeta.source}, Modell=${lastRequestMeta.model}, stream=${lastRequestMeta.stream}, Typ=${lastRequestMeta.type}`, 'info');

            const staged = stagedPrompt;
            stagedPrompt = null;
            if (lastRequestMeta.type === 'quiet') {
                log('Quiet-Generierung (Hintergrund) erkannt — Checks 3/4 übersprungen, Snapshot bleibt unverändert.', 'info');
                return;
            }
            if (staged && settings.autoCheck) {
                // Sync + fast: snapshot diff. (This listener blocks generation while it runs.)
                runCheck4(staged);
                // Token estimate may hit the server tokenizer — run detached, don't block generation.
                runCheck3(staged).catch(() => { /* logged inside */ });
                runCheck1();
            }
        } catch (err) {
            log(`SETTINGS_READY-Handler Fehler: ${err.message}`, 'error');
        }
    }

    function onGenerationEnded() {
        try {
            if (!settings.enabled || !settings.autoCheck) return;
            // GENERATION_ENDED is not awaited by core — async work is fine here.
            setTimeout(() => { runCheck5AfterGeneration().catch(() => { /* logged inside */ }); }, 500);
        } catch (err) {
            log(`GENERATION_ENDED-Handler Fehler: ${err.message}`, 'error');
        }
    }

    function wireEvents() {
        const { eventSource, eventTypes } = ctx();
        eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
        eventSource.on(eventTypes.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
        eventSource.on(eventTypes.GENERATION_ENDED, onGenerationEnded);
        if (eventTypes.CHATCOMPLETION_SOURCE_CHANGED) {
            eventSource.on(eventTypes.CHATCOMPLETION_SOURCE_CHANGED, () => { try { runCheck1(); } catch { /* ignore */ } });
        }
        if (eventTypes.CHATCOMPLETION_MODEL_CHANGED) {
            eventSource.on(eventTypes.CHATCOMPLETION_MODEL_CHANGED, () => { try { runCheck1(); } catch { /* ignore */ } });
        }
        if (eventTypes.CHAT_CHANGED) {
            eventSource.on(eventTypes.CHAT_CHANGED, () => {
                try { log(`Chat gewechselt (id=${ctx().chatId ?? '?'}) — Snapshot-Diff startet neu für diesen Chat.`, 'info'); } catch { /* ignore */ }
            });
        }
    }

    // -------------------------------------------------------------- run all

    async function runAllChecks() {
        log('--- Manuelle Prüfung gestartet ---', 'info');
        runCheck1();
        await probePlugin();
        if (pluginState === 'ok') {
            log(`Plugin erreichbar (v${pluginVersion}) unter ${pluginBase()}`, 'ok');
        } else {
            log(PLUGIN_DOWN_HINT, 'warn');
        }
        await runCheck2();

        // Checks 3+4 need the outgoing prompt — reuse the last snapshot if present.
        const chatId = ctx().chatId ?? '(no-chat)';
        const snap = snapshots.get(chatId);
        if (snap) {
            await runCheck3(snap);
            setLight(4, 'gray', 'Diff wird bei der nächsten Generierung aktualisiert (Snapshot vorhanden).');
        } else {
            setLight(3, 'gray', 'Noch kein Prompt beobachtet — einmal generieren, dann wird geschätzt.');
            setLight(4, 'gray', 'Noch kein Snapshot — wird bei der nächsten Generierung erstellt.');
        }
        if (!lastCapture) {
            setLight(5, 'gray', 'Noch keine Generierung beobachtet.');
        }
        log('--- Manuelle Prüfung beendet ---', 'info');
    }

    // ------------------------------------------------------------------ panel

    const CHECK_LABELS = [
        [1, 'Einstellungen (OpenRouter / Chat Completion / Claude)'],
        [2, 'config.yaml (cachingAtDepth)'],
        [3, 'Mindest-Tokenzahl'],
        [4, 'Präfix-Stabilität (Prompt-Diff)'],
        [5, 'Live-Beweis (usage / cache_discount)'],
        [6, 'Live-Log'],
    ];

    function buildPanel() {
        const panel = document.createElement('div');
        panel.id = 'bfcv-panel';
        if (settings.panelCollapsed) panel.classList.add('bfcv-collapsed');

        const checksHtml = CHECK_LABELS.map(([no, label]) => `
            <div class="bfcv-check" id="bfcv-check-${no}">
                <div class="bfcv-check-head">
                    <span class="bfcv-light bfcv-gray"></span>
                    <span class="bfcv-check-no">${no}.</span>
                    <span class="bfcv-check-label">${label}</span>
                </div>
                <div class="bfcv-check-detail">–</div>
            </div>`).join('');

        panel.innerHTML = `
            <div class="bfcv-header">
                <span class="bfcv-title">🧊 BF Cache Verify</span>
                <span class="bfcv-header-buttons">
                    <button id="bfcv-btn-run" class="bfcv-btn" title="Alle Checks ausführen">Prüfen</button>
                    <button id="bfcv-btn-collapse" class="bfcv-btn" title="Ein-/Ausklappen">▁</button>
                    <button id="bfcv-btn-close" class="bfcv-btn" title="Panel schließen">✕</button>
                </span>
            </div>
            <div class="bfcv-body">
                <div class="bfcv-checks">${checksHtml}</div>
                <div class="bfcv-logbar">
                    <span>Log</span>
                    <span>
                        <button id="bfcv-btn-copylog" class="bfcv-btn" title="Log in Zwischenablage kopieren">Kopieren</button>
                        <button id="bfcv-btn-clearlog" class="bfcv-btn" title="Log leeren">Leeren</button>
                    </span>
                </div>
                <div id="bfcv-log"></div>
            </div>`;

        document.body.appendChild(panel);

        // Check 6 is the log itself — mark it green once the panel exists.
        setLight(6, 'green', `Log aktiv. Serverseitige Datei: SillyTavern/plugins/bf-cache-verify/cache-verify.log (nur mit Plugin). Live verfolgen: <code>Get-Content -Wait</code> (Windows) / <code>tail -f</code> (Termux).`);

        document.getElementById('bfcv-btn-run').addEventListener('click', () => {
            runAllChecks().catch((err) => log(`runAllChecks Fehler: ${err.message}`, 'error'));
        });
        document.getElementById('bfcv-btn-collapse').addEventListener('click', () => {
            panel.classList.toggle('bfcv-collapsed');
            settings.panelCollapsed = panel.classList.contains('bfcv-collapsed');
            saveSettings();
        });
        document.getElementById('bfcv-btn-close').addEventListener('click', () => {
            panel.style.display = 'none';
        });
        document.getElementById('bfcv-btn-copylog').addEventListener('click', async () => {
            try {
                const text = logLines.map((l) => l.line).join('\n');
                await navigator.clipboard.writeText(text);
                log('Log in Zwischenablage kopiert.', 'info');
            } catch (err) {
                log(`Kopieren fehlgeschlagen: ${err.message}`, 'error');
            }
        });
        document.getElementById('bfcv-btn-clearlog').addEventListener('click', () => {
            logLines.length = 0;
            const el = document.getElementById('bfcv-log');
            if (el) el.innerHTML = '';
        });
    }

    function showPanel() {
        const panel = document.getElementById('bfcv-panel');
        if (panel) panel.style.display = '';
    }

    // -------------------------------------------------------- settings drawer

    async function initSettingsDrawer() {
        let html;
        try {
            html = await $.get(`scripts/extensions/third-party/${EXT_NAME}/templates/settings.html`);
        } catch {
            try {
                html = await $.get(`scripts/extensions/${EXT_NAME}/templates/settings.html`);
            } catch (err) {
                console.error(LOG_PREFIX, 'settings template not found', err);
                return;
            }
        }
        $('#extensions_settings').append(html);

        const $enabled = $('#bfcv-set-enabled');
        const $auto = $('#bfcv-set-autocheck');
        const $base = $('#bfcv-set-pluginbase');

        $enabled.prop('checked', settings.enabled);
        $auto.prop('checked', settings.autoCheck);
        $base.val(settings.pluginBase);

        $enabled.on('change', function () {
            settings.enabled = this.checked;
            saveSettings();
            log(`Extension ${settings.enabled ? 'aktiviert' : 'deaktiviert'}.`, 'info');
        });
        $auto.on('change', function () {
            settings.autoCheck = this.checked;
            saveSettings();
        });
        $base.on('input', function () {
            settings.pluginBase = String($(this).val()).trim() || DEFAULT_SETTINGS.pluginBase;
            pluginState = 'unknown';
            saveSettings();
        });
        $('#bfcv-set-showpanel').on('click', () => showPanel());
        $('#bfcv-set-run').on('click', () => {
            showPanel();
            runAllChecks().catch((err) => log(`runAllChecks Fehler: ${err.message}`, 'error'));
        });
    }

    // ------------------------------------------------------------------- init

    jQuery(async () => {
        try {
            loadSettings();
            installFetchInterceptor();
            buildPanel();
            await initSettingsDrawer();
            wireEvents();

            log(`BF Cache Verify v${VERSION} geladen.`, 'info');

            // Initial probe + first checks (delayed so ST finishes connecting).
            setTimeout(() => {
                probePlugin().then((ok) => {
                    if (ok) log(`Plugin erreichbar (v${pluginVersion}) unter ${pluginBase()}`, 'ok');
                    else log(PLUGIN_DOWN_HINT, 'warn');
                    runCheck1();
                    runCheck2().catch(() => { /* logged inside */ });
                }).catch(() => { /* ignore */ });
            }, 3000);

            console.log(LOG_PREFIX, 'Extension loaded successfully');
        } catch (error) {
            console.error(LOG_PREFIX, 'Failed to load extension:', error);
        }
    });
})();
