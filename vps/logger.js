// Logging for the k-keiei.jp copy only. The deploy workflow adds this file
// and a <script src="logger.js"> to that copy; index.html itself (and so the
// GitHub Pages copy) has no logging code at all.
//
// It hooks in from outside: loadFiles is a global function, so wrapping it
// sees every load, and the layer list and error events are observed through
// the DOM. Events go to log.php; the opened files are sent only while the
// checkbox is on.
(function () {
  "use strict";
  const ENDPOINT = "log.php";
  const session = Math.random().toString(36).slice(2, 12);
  let lastFiles = [];

  function logEvent(kind, data) {
    try {
      fetch(ENDPOINT + "?session=" + session, {
        method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, data }),
      }).catch(() => {});
    } catch (e) {}
  }
  function uploadFiles(files) {
    if (!box.checked) return;
    for (const f of files) {
      if (f.uploaded) continue;
      f.uploaded = true;
      fetch(ENDPOINT + "?session=" + session + "&file=" + encodeURIComponent(f.name), {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f,
      }).catch(() => { f.uploaded = false; });
    }
  }

  // The checkbox, next to the header buttons.
  const label = document.createElement("label");
  label.title = "このサーバ版は動作ログを記録しています。チェックすると、開いたガーバーファイルもサーバに保存します。";
  const box = document.createElement("input");
  box.type = "checkbox";
  label.append(box, " ガーバーデータもサーバに保存");
  document.querySelector("header").appendChild(label);
  try { box.checked = localStorage.getItem("gerberview.savedata") === "1"; } catch (e) {}
  box.onchange = () => {
    try { localStorage.setItem("gerberview.savedata", box.checked ? "1" : "0"); } catch (e) {}
    logEvent("savedata", { on: box.checked });
    uploadFiles(lastFiles);
  };
  const note = document.getElementById("privacy");
  if (note) note.textContent = "このサーバ版は動作ログ (ファイル名・警告・エラー) を記録します。ガーバーデータの保存はチェックボックスで選べます";

  // Shape of a file without its contents: sizes, line counts and how often
  // each kind of command appears, so a misread can be narrowed down even when
  // the file itself was not sent. No coordinates, sizes or text are kept.
  function count(re, text) { const m = text.match(re); return m ? m.length : 0; }
  function tally(re, text, key) {
    const out = {};
    for (const m of text.matchAll(re)) { const k = key(m); out[k] = (out[k] || 0) + 1; }
    return out;
  }
  function fileStats(data, text) {
    const st = {
      bytes: data.length,
      lines: count(/\n/g, text) + (text.length && !text.endsWith("\n") ? 1 : 0),
      crlf: /\r\n/.test(text),
      binary: /\x00/.test(text.slice(0, 4096)),
    };
    if (st.binary) return st;
    if (/%FS|%MO|%ADD|G04/.test(text.slice(0, 20000))) {
      const ext = (text.match(/%[^%]*%/g) || []);
      const words = text.replace(/%[^%]*%/g, "").split("*").map(w => w.replace(/\s+/g, "")).filter(Boolean);
      st.kind = "gerber";
      const fs = /%FS([LTD]?[AI]?)X(\d\d)Y(\d\d)/.exec(text);
      if (fs) st.format = fs[1] + " X" + fs[2] + " Y" + fs[3];
      const mo = /%MO(MM|IN)/.exec(text);
      st.unit = mo ? mo[1] : (/G70/.test(text) ? "G70" : /G71/.test(text) ? "G71" : undefined);
      st.apertures = tally(/%ADD\d+([A-Za-z_$][^,*%]*)/g, text, m => ["C", "R", "O", "P"].includes(m[1]) ? m[1] : "macro");
      st.macros = count(/%AM/g, text);
      st.macroPrimitives = {};
      for (const am of ext.filter(e => e.startsWith("%AM"))) {
        for (const stmt of am.slice(1, -1).split("*").slice(1)) {
          const m = /^\s*(\d+)\s*,/.exec(stmt);
          if (m) st.macroPrimitives[m[1]] = (st.macroPrimitives[m[1]] || 0) + 1;
        }
      }
      st.extended = tally(/%([A-Z]{2})/g, ext.join(""), m => m[1]);
      st.gcodes = {};
      st.dcodes = { D01: 0, D02: 0, D03: 0, select: 0, modal: 0 };
      for (const w of words) {
        for (const g of w.matchAll(/G0*(\d+)/g)) { const k = "G" + g[1].padStart(2, "0"); st.gcodes[k] = (st.gcodes[k] || 0) + 1; }
        if (/^G0*4/.test(w)) continue;
        const d = /D0*(\d+)$/.exec(w);
        if (d && +d[1] >= 10) st.dcodes.select++;
        else if (d) st.dcodes["D0" + d[1]] = (st.dcodes["D0" + d[1]] || 0) + 1;
        else if (/[XYIJ][+-]?\d/.test(w)) st.dcodes.modal++;
      }
      st.comments = st.gcodes.G04 || 0;
      st.clearPolarity = count(/%LPC/g, text);
      const ff = /%TF\.FileFunction,([^*%]+)/.exec(text);
      if (ff) st.fileFunction = ff[1];
      const gs = /%TF\.GenerationSoftware,([^,*%]*),([^,*%]*)/.exec(text);
      if (gs) st.software = gs[1] + " " + gs[2];
      st.end = /M0*2\*/.test(text);
    } else if (/^\s*(M48|;)/m.test(text) || /^T\d+C/m.test(text)) {
      st.kind = "excellon";
      const hdr = /^(METRIC|INCH)(,(LZ|TZ))?(,(0+\.0+))?/m.exec(text);
      if (hdr) st.header = hdr[1] + (hdr[3] ? "," + hdr[3] : "") + (hdr[5] ? "," + hdr[5].replace(/0/g, "#") : "");
      st.m71m72 = count(/^M7[12]\b/gm, text);
      st.tools = count(/^T\d+.*C[0-9.]/gm, text);
      st.toolSelects = count(/^T\d+\s*$/gm, text);
      st.hits = count(/^(T\d+)?[XY][+-]?[0-9.]/gm, text);
      st.decimalCoords = /^[XY][+-]?\d*\.\d/m.test(text);
      st.slotsG85 = count(/G85/g, text);
      st.routes = count(/^G0*0[XY]/gm, text);
      st.comments = count(/^;/gm, text);
      st.incremental = /^G91/m.test(text);
      const ff = /TF\.FileFunction,([^\r\n]+)/.exec(text);
      if (ff) st.fileFunction = ff[1].trim();
      const sw = /^;\s*(DRILL file \{[^}]*\}|Generated by [^\r\n]{0,40})/m.exec(text);
      if (sw) st.software = sw[1];
    }
    return st;
  }
  const origLoad = window.loadLayerFile;
  window.loadLayerFile = function (name, data) {
    const t0 = performance.now();
    const L = origLoad.apply(this, arguments);
    const ms = Math.round(performance.now() - t0);
    try { L.stats = Object.assign({ parseMs: ms }, fileStats(data, bytesToText(data))); } catch (e) { L.stats = { parseMs: ms, statsError: String(e) }; }
    return L;
  };

  // Every load goes through the global loadFiles.
  const orig = window.loadFiles;
  window.loadFiles = async function (fileList) {
    lastFiles = fileList;
    uploadFiles(fileList);
    const r = await orig.apply(this, arguments);
    const bb = boardBBox();
    logEvent("load", {
      files: fileList.map(f => ({ name: f.name, size: f.size })),
      board: bb && [+(bb.maxX - bb.minX).toFixed(3), +(bb.maxY - bb.minY).toFixed(3)],
      layers: state.layers.map(L => ({ name: L.name, type: L.type, side: L.side, items: L.parsed ? L.parsed.items.length : 0,
                                       error: L.error || undefined, warnings: L.parsed && L.parsed.warnings.length ? L.parsed.warnings : undefined,
                                       stats: L.stats })),
    });
    return r;
  };

  // A layer type changed by hand says the identification was wrong.
  document.getElementById("layers").addEventListener("change", (e) => {
    if (e.target.tagName !== "SELECT") return;
    const row = e.target.closest(".row");
    const name = row && row.querySelector(".name").title.split("\n")[0];
    logEvent("retype", { name, to: e.target.value });
  });

  window.addEventListener("error", (e) => logEvent("error", { message: String(e.message), at: (e.filename || "").replace(/^.*\//, "") + ":" + e.lineno + ":" + e.colno, stack: e.error && String(e.error.stack).slice(0, 2000) }));
  window.addEventListener("unhandledrejection", (e) => logEvent("error", { message: String(e.reason && e.reason.message || e.reason), stack: e.reason && String(e.reason.stack || "").slice(0, 2000) }));
  logEvent("open", { href: location.href, screen: [screen.width, screen.height, window.devicePixelRatio || 1] });
})();
