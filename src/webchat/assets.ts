/**
 * O que o navegador do visitante carrega: o script que vai no site do cliente
 * (bolinha flutuante ou chat embutido) e a página do chat (dentro do quadro ou
 * aberta pelo link, em tela cheia). Sem bibliotecas: JavaScript e CSS puros.
 *
 * Protocolo entre o site e o quadro (postMessage, { mavi_wc: true, ev }):
 * quadro → site: "ready", "unread" (n), "close", "started"; site → quadro:
 * "open", "closed".
 */

/** O script do site: <script src=".../w/widget.js" data-key="wc_…" async></script>. */
export const LOADER_JS = String.raw`(function () {
  var s = document.currentScript || (function () { var a = document.querySelectorAll('script[data-key^="wc_"]'); return a[a.length - 1]; })();
  if (!s) return;
  var key = s.getAttribute("data-key");
  var mode = s.getAttribute("data-mode") || "bubble";
  var base = new URL(s.src).origin;
  var host = location.origin;
  var flag = "mavi-wc:" + key + ":started";
  if (!key || window["__maviwc_" + key]) return;
  window["__maviwc_" + key] = true;

  function frameUrl() { return base + "/w/" + encodeURIComponent(key) + "?embed=1&host=" + encodeURIComponent(host) + "&page=" + encodeURIComponent(location.href.slice(0, 1500)) + "&ref=" + encodeURIComponent((document.referrer || "").slice(0, 500)); }
  function makeFrame() {
    var f = document.createElement("iframe");
    f.src = frameUrl();
    f.title = "Chat";
    f.allow = "clipboard-write";
    f.style.cssText = "border:0;width:100%;height:100%;display:block;background:transparent;color-scheme:normal";
    return f;
  }

  fetch(base + "/w/" + encodeURIComponent(key) + "/config?host=" + encodeURIComponent(host)).then(function (r) { return r.ok ? r.json() : null; }).then(function (cfg) {
    if (!cfg) { console.warn("Chat MAVI: este site não está liberado para o chat " + key + "."); return; }
    if (mode === "inline") return inline(cfg);
    bubble(cfg);
  }).catch(function () {});

  function inline(cfg) {
    var sel = s.getAttribute("data-target");
    var box = sel ? document.querySelector(sel) : null;
    if (!box) { box = document.createElement("div"); s.parentNode.insertBefore(box, s); }
    var h = s.getAttribute("data-height") || "600px";
    box.style.height = box.style.height || h;
    box.style.borderRadius = box.style.borderRadius || "16px";
    box.style.overflow = "hidden";
    box.style.boxShadow = box.style.boxShadow || "0 2px 18px rgba(0,0,0,.08)";
    box.appendChild(makeFrame());
  }

  function bubble(cfg) {
    var left = cfg.position === "left";
    var side = left ? "left" : "right";
    var root = document.createElement("div");
    root.style.cssText = "position:fixed;bottom:20px;" + side + ":20px;z-index:2147483000;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", cfg.title || "Abrir o chat");
    btn.style.cssText = "display:flex;align-items:center;gap:10px;height:58px;min-width:58px;padding:0 " + (cfg.launcher_text ? "20px 0 16px" : "0") + ";justify-content:center;border:0;border-radius:29px;cursor:pointer;color:#fff;background:" + cfg.color + ";box-shadow:0 6px 24px rgba(0,0,0,.22);font-size:15px;font-weight:600;transition:transform .15s";
    btn.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' + (cfg.launcher_text ? "<span></span>" : "");
    if (cfg.launcher_text) btn.querySelector("span").textContent = cfg.launcher_text;
    btn.onmouseenter = function () { btn.style.transform = "scale(1.05)"; };
    btn.onmouseleave = function () { btn.style.transform = ""; };
    var badge = document.createElement("span");
    badge.style.cssText = "position:absolute;top:-4px;" + (left ? "left" : "right") + ":-4px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#e5484d;color:#fff;font:600 12px/20px system-ui,sans-serif;text-align:center;display:none";
    var panel = document.createElement("div");
    var mobile = window.matchMedia("(max-width: 520px)").matches;
    panel.style.cssText = mobile
      ? "position:fixed;inset:0;display:none;background:#fff;z-index:2147483001"
      : "position:absolute;bottom:72px;" + side + ":0;width:380px;height:min(640px,calc(100vh - 110px));display:none;border-radius:18px;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,.24);background:#fff";
    var frame = null;
    var open = false;
    function ensure() { if (!frame) { frame = makeFrame(); panel.appendChild(frame); } }
    function post(ev) { if (frame && frame.contentWindow) frame.contentWindow.postMessage({ mavi_wc: true, ev: ev }, base); }
    function setOpen(v) {
      open = v;
      if (v) ensure();
      panel.style.display = v ? "block" : "none";
      btn.style.display = v && mobile ? "none" : "flex";
      btn.setAttribute("aria-expanded", v ? "true" : "false");
      if (v) badge.style.display = "none";
      post(v ? "open" : "closed");
    }
    btn.onclick = function () { setOpen(!open); };
    window.addEventListener("message", function (e) {
      if (e.origin !== base || !e.data || !e.data.mavi_wc) return;
      if (e.data.ev === "close") setOpen(false);
      if (e.data.ev === "ready") post(open ? "open" : "closed");
      if (e.data.ev === "started") { try { localStorage.setItem(flag, "1"); } catch (x) {} }
      if (e.data.ev === "unread") {
        var n = Number(e.data.n) || 0;
        badge.textContent = n > 9 ? "9+" : String(n);
        badge.style.display = n > 0 && !open ? "block" : "none";
      }
    });
    root.appendChild(panel);
    root.appendChild(btn);
    btn.appendChild(badge);
    btn.style.position = "relative";
    document.body.appendChild(root);
    // Quem já conversou: o quadro carrega escondido para avisar das respostas novas.
    var started = false;
    try { started = localStorage.getItem(flag) === "1"; } catch (x) {}
    if (started) setTimeout(ensure, 1500);
    window.MaviChat = window.MaviChat || {};
    window.MaviChat.open = function () { setOpen(true); };
    window.MaviChat.close = function () { setOpen(false); };
  }
})();
`;

/** A página do chat (dentro do quadro ou em tela cheia pelo link). */
export function chatPage(input: { key: string; title: string; color: string; embed: boolean; host: string; page: string; referrer: string }): string {
  const boot = JSON.stringify({ key: input.key, embed: input.embed, host: input.host, page: input.page, referrer: input.referrer }).replace(/</g, "\\u003c");
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(input.title)}</title>
<style>${CHAT_CSS.replace(/--c:#56793a/, `--c:${input.color}`)}</style>
</head>
<body class="${input.embed ? "embed" : "full"}">
<div id="app" class="app" aria-live="polite"></div>
<script>window.__WC__=${boot};</script>
<script>${CHAT_JS}</script>
</body>
</html>`;
}

const CHAT_CSS = String.raw`
:root{--c:#56793a;--ink:#1f2a2b;--muted:#6b7778;--line:#e7eaeb;--bg:#f5f6f7;--bubble:#fff;color-scheme:light}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:transparent;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}
body.full{background:var(--bg)}
.app{height:100%;display:flex;flex-direction:column;background:#fff}
body.full .app{max-width:560px;margin:0 auto;box-shadow:0 0 40px rgba(0,0,0,.06)}
@media (min-width:700px){body.full{padding:24px 16px}body.full .app{height:calc(100% - 0px);border-radius:18px;overflow:hidden}}
.head{display:flex;align-items:center;gap:12px;padding:14px 14px 14px 16px;background:var(--c);color:#fff;flex:none}
.av{width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.22);display:grid;place-items:center;font-weight:700;flex:none;overflow:hidden}
.av img{width:100%;height:100%;object-fit:cover}
.ht{flex:1;min-width:0}
.ht b{display:block;font-size:15px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ht span{display:block;font-size:12.5px;opacity:.88;line-height:1.3}
.hb{width:36px;height:36px;border:0;border-radius:10px;background:transparent;color:#fff;display:grid;place-items:center;cursor:pointer;flex:none}
.hb:hover,.hb:focus-visible{background:rgba(255,255,255,.18);outline:none}
.list{flex:1;overflow-y:auto;padding:16px 14px 8px;background:var(--bg);display:flex;flex-direction:column;gap:6px;overscroll-behavior:contain}
.row{display:flex;flex-direction:column;max-width:84%}
.row.me{align-self:flex-end;align-items:flex-end}
.row.them{align-self:flex-start}
.who{font-size:11.5px;color:var(--muted);margin:6px 4px 2px}
.b{padding:9px 12px;border-radius:16px;font-size:14.5px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bubble);box-shadow:0 1px 1px rgba(0,0,0,.05)}
.me .b{background:var(--c);color:#fff;border-bottom-right-radius:5px}
.them .b{border-bottom-left-radius:5px}
.b a{color:inherit;text-decoration:underline}
.b img{display:block;max-width:100%;border-radius:10px;margin-top:6px}
.t{font-size:10.5px;color:var(--muted);margin:2px 6px 0}
.sending .b{opacity:.6}
.fail .t{color:#c2410c}
.typing{align-self:flex-start;background:#fff;border-radius:16px;padding:12px 14px;display:none;gap:4px;box-shadow:0 1px 1px rgba(0,0,0,.05)}
.typing.on{display:flex}
.typing i{width:7px;height:7px;border-radius:50%;background:#a3adae;animation:d 1.2s infinite}
.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}
@keyframes d{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-4px);opacity:1}}
.chips{display:flex;flex-wrap:wrap;gap:6px;padding:4px 14px 10px;background:var(--bg)}
.chip{border:1px solid var(--c);color:var(--c);background:#fff;border-radius:999px;padding:7px 12px;font-size:13.5px;cursor:pointer;font-family:inherit}
.chip:hover,.chip:focus-visible{background:var(--c);color:#fff;outline:none}
.compose{display:flex;align-items:flex-end;gap:8px;padding:10px 10px calc(10px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:#fff;flex:none}
.compose textarea{flex:1;resize:none;overflow-y:hidden;border:1px solid var(--line);border-radius:14px;padding:10px 12px;font:inherit;font-size:15px;line-height:1.4;max-height:120px;min-height:42px;outline:none;color:var(--ink);background:#fff}
.compose textarea:focus{border-color:var(--c)}
.send{width:42px;height:42px;border:0;border-radius:50%;background:var(--c);color:#fff;display:grid;place-items:center;cursor:pointer;flex:none}
.send:disabled{opacity:.45;cursor:default}
.form{flex:1;overflow-y:auto;padding:20px 18px;background:var(--bg);display:flex;flex-direction:column;gap:12px}
.form p{margin:0 0 4px;font-size:14.5px;line-height:1.5}
.form label{display:flex;flex-direction:column;gap:5px;font-size:13px;font-weight:600;color:#3b4748}
.form input{border:1px solid var(--line);border-radius:12px;padding:11px 12px;font:inherit;font-size:15px;outline:none;background:#fff;color:var(--ink)}
.form input:focus{border-color:var(--c)}
.primary{border:0;border-radius:12px;background:var(--c);color:#fff;padding:12px 14px;font:inherit;font-size:15px;font-weight:600;cursor:pointer}
.primary:disabled{opacity:.6}
.err{color:#b42318;font-size:13px;min-height:1em;margin:0}
.note{font-size:11.5px;color:var(--muted);text-align:center;padding:6px 10px;background:var(--bg)}
.empty{margin:auto;color:var(--muted);font-size:14px;text-align:center;padding:30px}
@media (prefers-reduced-motion:reduce){.typing i{animation:none}}
`;

const CHAT_JS = String.raw`(function () {
  var B = window.__WC__;
  var api = "/w/" + encodeURIComponent(B.key);
  var app = document.getElementById("app");
  var store = "mavi-wc:" + B.key;
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
  function rid() { var a = new Uint8Array(24); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
  var visitor = ls(store) || rid();
  ls(store, visitor);
  var cfg = null, me = null, msgs = [], lastId = 0, seenId = Number(ls(store + ":seen") || 0), open = !B.embed, typing = false, polling = false, stopped = false;

  function post(ev, extra) { if (B.embed && parent !== window) { var m = { mavi_wc: true, ev: ev }; for (var k in extra || {}) m[k] = extra[k]; parent.postMessage(m, B.host || "*"); } }
  function req(method, path, body) {
    return fetch(api + path, { method: method, headers: { "content-type": "application/json", "x-visitor": visitor, "x-host": B.host || "" }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || "Erro " + r.status); return d; }); });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function esc(s) { return s.replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function rich(text) {
    var out = esc(text).replace(/\*([^*\n]+)\*/g, "<b>$1</b>");
    return out.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g, function (u) {
      var raw = u.replace(/&amp;/g, "&");
      if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(raw)) return '<a href="' + u + '" target="_blank" rel="noopener">' + '<img src="' + u + '" alt="Imagem" loading="lazy"></a>';
      return '<a href="' + u + '" target="_blank" rel="noopener nofollow">' + u + "</a>";
    });
  }
  function hhmm(at) { var d = at ? new Date(at) : new Date(); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
  var ICON = {
    close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    send: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>',
    wa: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5.3 14.2c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.6-4-4.7-4.2-.1-.2-1.1-1.5-1.1-2.9s.7-2 1-2.3c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.3.5-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1c.2-.3.4-.2.6-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.1 1.3z"/></svg>'
  };

  // ---------------------------------------------------------------- telas
  function header() {
    var h = el("div", "head");
    var av = el("div", "av");
    if (cfg.avatar_url) { var img = el("img"); img.src = cfg.avatar_url; img.alt = ""; av.appendChild(img); } else av.textContent = (cfg.title || "?").trim().charAt(0).toUpperCase();
    var t = el("div", "ht");
    t.appendChild(el("b", null, cfg.title));
    if (cfg.subtitle) t.appendChild(el("span", null, cfg.subtitle));
    h.appendChild(av); h.appendChild(t);
    if (cfg.whatsapp) {
      var w = el("button", "hb"); w.type = "button"; w.title = "Continuar no WhatsApp"; w.setAttribute("aria-label", "Continuar no WhatsApp"); w.innerHTML = ICON.wa;
      w.onclick = goWhatsapp; h.appendChild(w);
    }
    if (B.embed) {
      var c = el("button", "hb"); c.type = "button"; c.setAttribute("aria-label", "Fechar o chat"); c.innerHTML = ICON.close;
      c.onclick = function () { post("close"); }; h.appendChild(c);
    }
    return h;
  }

  function goWhatsapp() {
    var win = window.open("about:blank", "_blank");
    req("POST", "/whatsapp", {}).then(function (d) { if (win) win.location.href = d.url; else location.href = d.url; }).catch(function (e) { if (win) win.close(); alert(e.message); });
  }

  function renderForm() {
    app.innerHTML = "";
    app.appendChild(header());
    var f = el("form", "form");
    f.appendChild(el("p", null, cfg.welcome || "Antes de começar, como podemos te chamar?"));
    var name = field("Seu nome", "text", "name", true, "given-name");
    var phone = field("Seu WhatsApp (com DDD)", "tel", "phone", true, "tel");
    f.appendChild(name.l); f.appendChild(phone.l);
    var email = null;
    if (cfg.ask_email) { email = field("Seu e-mail (opcional)", "email", "email", false, "email"); f.appendChild(email.l); }
    var err = el("p", "err"); f.appendChild(err);
    var go = el("button", "primary", "Começar conversa"); go.type = "submit"; f.appendChild(go);
    f.onsubmit = function (e) {
      e.preventDefault();
      go.disabled = true; err.textContent = "";
      req("POST", "/identify", { name: name.i.value, phone: phone.i.value, email: email ? email.i.value : "" })
        .then(function (d) { me = d.visitor; renderChat(); })
        .catch(function (x) { err.textContent = x.message; go.disabled = false; });
    };
    app.appendChild(f);
    setTimeout(function () { name.i.focus(); }, 50);
  }
  function field(label, type, nm, req_, ac) {
    var l = el("label", null, label); var i = el("input"); i.type = type; i.name = nm; i.required = req_; i.autocomplete = ac; l.appendChild(i); return { l: l, i: i };
  }

  var list, typer, chips, ta, sendBtn;
  function renderChat() {
    app.innerHTML = "";
    app.appendChild(header());
    list = el("div", "list"); list.setAttribute("role", "log");
    typer = el("div", "typing"); typer.innerHTML = "<i></i><i></i><i></i>"; typer.setAttribute("aria-label", "Escrevendo");
    app.appendChild(list);
    chips = el("div", "chips");
    (cfg.suggestions || []).forEach(function (s) { var c = el("button", "chip", s); c.type = "button"; c.onclick = function () { send(s); }; chips.appendChild(c); });
    app.appendChild(chips);
    var comp = el("div", "compose");
    ta = el("textarea"); ta.rows = 1; ta.placeholder = "Escreva sua mensagem…"; ta.setAttribute("aria-label", "Mensagem"); ta.maxLength = 4000;
    sendBtn = el("button", "send"); sendBtn.type = "button"; sendBtn.innerHTML = ICON.send; sendBtn.setAttribute("aria-label", "Enviar");
    ta.oninput = function () { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; ta.style.overflowY = ta.scrollHeight > 120 ? "auto" : "hidden"; sendBtn.disabled = !ta.value.trim(); };
    ta.onkeydown = function (e) { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.value); } };
    sendBtn.onclick = function () { send(ta.value); };
    sendBtn.disabled = true;
    comp.appendChild(ta); comp.appendChild(sendBtn);
    app.appendChild(comp);
    draw();
    if (open) setTimeout(function () { ta.focus(); }, 60);
  }

  function bubble(m) {
    var mine = m.from === "visitor";
    var row = el("div", "row " + (mine ? "me" : "them") + (m.state ? " " + m.state : ""));
    if (m.from === "team" && m.name) row.appendChild(el("div", "who", m.name));
    var b = el("div", "b"); b.innerHTML = rich(m.text); row.appendChild(b);
    if (m.at || m.state) row.appendChild(el("div", "t", m.state === "fail" ? "Não enviada · toque para tentar de novo" : m.state === "sending" ? "Enviando…" : hhmm(m.at)));
    if (m.state === "fail") { row.style.cursor = "pointer"; row.onclick = function () { msgs = msgs.filter(function (x) { return x !== m; }); send(m.text); }; }
    return row;
  }
  function draw() {
    if (!list) return;
    list.innerHTML = "";
    if (cfg.welcome && cfg.identify !== "form") list.appendChild(bubble({ from: "agent", text: cfg.welcome, at: null }));
    msgs.forEach(function (m) { list.appendChild(bubble(m)); });
    typer.className = "typing" + (typing ? " on" : "");
    list.appendChild(typer);
    chips.style.display = msgs.length ? "none" : "flex";
    list.scrollTop = list.scrollHeight;
  }

  // ---------------------------------------------------------------- envio e recebimento
  function send(text) {
    text = (text || "").trim();
    if (!text) return;
    if (ta) { ta.value = ""; ta.oninput(); }
    var m = { from: "visitor", text: text, at: new Date().toISOString(), state: "sending" };
    msgs.push(m); draw();
    req("POST", "/messages", { text: text }).then(function (d) {
      m.state = null; m.id = d.message.id; m.at = d.message.at;
      if (d.message.id > lastId) lastId = d.message.id;
      typing = !!d.typing; draw();
      post("started");
      poll();
    }).catch(function () { m.state = "fail"; draw(); });
  }
  function merge(list_) {
    list_.forEach(function (n) {
      if (n.id <= lastId && msgs.some(function (x) { return x.id === n.id; })) return;
      if (!msgs.some(function (x) { return x.id === n.id; })) msgs.push(n);
      if (n.id > lastId) lastId = n.id;
    });
    msgs.sort(function (a, b) { return (a.id || 1e15) - (b.id || 1e15); });
  }
  function unread() {
    var n = msgs.filter(function (m) { return m.id > seenId && m.from !== "visitor"; }).length;
    if (open) { seenId = lastId; ls(store + ":seen", String(seenId)); n = 0; }
    post("unread", { n: n });
  }
  function poll() {
    if (polling || stopped) return;
    // Sem conversa ainda (nada enviado), não há o que esperar.
    if (!lastId) return;
    polling = true;
    var wait = open && !document.hidden ? 25 : 0;
    req("GET", "/messages?after=" + lastId + "&wait=" + wait)
      .then(function (d) {
        var before = msgs.length;
        merge(d.messages || []);
        typing = !!d.typing;
        if (msgs.length !== before || list) draw();
        unread();
        polling = false;
        setTimeout(poll, open && !document.hidden ? 300 : 30000);
      })
      .catch(function () { polling = false; setTimeout(poll, 8000); });
  }

  window.addEventListener("message", function (e) {
    if (!e.data || !e.data.mavi_wc) return;
    if (B.host && e.origin !== B.host) return;
    if (e.data.ev === "open") { open = true; unread(); if (ta) setTimeout(function () { ta.focus(); }, 60); polling = false; poll(); }
    if (e.data.ev === "closed") open = false;
  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) poll(); });

  // ---------------------------------------------------------------- início
  req("POST", "/session", { page_url: B.page || (B.embed ? "" : location.href), referrer: B.referrer || document.referrer || "" })
    .then(function (d) {
      cfg = d.config; me = d.visitor; merge(d.messages || []);
      document.title = cfg.title;
      if (cfg.identify === "form" && !(me && me.identified) && !msgs.length) renderForm(); else renderChat();
      post("ready");
      if (msgs.length) { post("started"); unread(); }
      poll();
    })
    .catch(function (e) {
      app.innerHTML = "";
      app.appendChild(el("div", "empty", e.message || "O chat não está disponível agora."));
      stopped = true;
    });
})();
`;
