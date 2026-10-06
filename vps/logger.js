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
                                       error: L.error || undefined, warnings: L.parsed && L.parsed.warnings.length ? L.parsed.warnings : undefined })),
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
