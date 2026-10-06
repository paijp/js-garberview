// Run with: node tests/run.js
// The parsing code lives in index.html between "// @@lib-begin" and
// "// @@lib-end"; it is pulled out here so it can be tested without a browser.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const zlib = require("zlib");

function loadLib() {
  const s = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const i = s.indexOf("// @@lib-begin"), j = s.indexOf("// @@lib-end");
  const ctx = { TextDecoder, Blob, Response, DecompressionStream, Uint8Array, DataView, Math };
  vm.createContext(ctx);
  vm.runInContext(s.slice(i, j) + "\nthis.lib = { readZip, parseGerber, parseExcellon, identifyLayer, loadLayerFile, itemsBBox, evalMacroExpr };", ctx);
  return ctx.lib;
}
const lib = loadLib();
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, (msg || "") + " " + a + " != " + b);

function makeZip(files) {
  const parts = [], central = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text), comp = zlib.deflateRawSync(raw), nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(off, 42);
    parts.push(lh, nm, comp); central.push(cd, nm);
    off += 30 + nm.length + comp.length;
  }
  const cdb = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(central.length / 2, 8); e.writeUInt16LE(central.length / 2, 10);
  e.writeUInt32LE(cdb.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdb, e]);
}

test("zip: deflated entries come back intact", async () => {
  const z = makeZip({ "a/board.GTL": "G04 x*\nM02*\n", "b.txt": "hello" });
  const out = await lib.readZip(z);
  assert.strictEqual(JSON.stringify(out.map(e => e.name)), JSON.stringify(["a/board.GTL", "b.txt"]));
  assert.strictEqual(Buffer.from(out[1].data).toString(), "hello");
});

test("gerber: line, flash and units", () => {
  const g = lib.parseGerber("%FSLAX24Y24*%%MOIN*%%ADD10C,0.010*%%ADD11R,0.1X0.05*%D10*X0Y0D02*X10000Y0D01*D11*X5000Y5000D03*M02*");
  const [a, b] = g.items;
  assert.strictEqual(a.kind, "stroke"); near(a.width, 0.254); near(a.path[1][1], 25.4);
  assert.strictEqual(b.kind, "fill");
  const bb = lib.itemsBBox([b]);
  near(bb.minX, 12.7 - 1.27); near(bb.maxY, 12.7 + 0.635);
});

test("gerber: G75 arc keeps its end point and direction", () => {
  const g = lib.parseGerber("%FSLAX26Y26*%%MOMM*%%ADD10C,0.1*%D10*G75*X1000000Y0D02*G03X0Y1000000I-1000000J0D01*M02*");
  const arc = g.items[0].path[1];
  assert.strictEqual(arc[0], "A"); near(arc[1], 0); near(arc[3], 1); near(arc[4], 0); near(arc[5], Math.PI / 2);
  assert.strictEqual(arc[6], false);
});

test("gerber: G74 single-quadrant arc picks the right center", () => {
  const g = lib.parseGerber("%FSLAX26Y26*%%MOMM*%%ADD10C,0.1*%D10*G74*X1000000Y0D02*G02X0Y-1000000I1000000J0D01*M02*");
  const arc = g.items[0].path[1];
  near(arc[1], 0); near(arc[2], 0); near(arc[5], -Math.PI / 2);
});

test("gerber: region and clear polarity", () => {
  const g = lib.parseGerber("%FSLAX26Y26*%%MOMM*%G36*X0Y0D02*X0Y1000000D01*X1000000Y1000000D01*X1000000Y0D01*X0Y0D01*G37*%LPC*%%ADD10C,0.5*%D10*X500000Y500000D03*M02*");
  assert.strictEqual(g.items.length, 2);
  assert.strictEqual(g.items[0].kind, "fill"); assert.strictEqual(g.items[0].pol, "D");
  assert.strictEqual(g.items[1].pol, "C");
});

test("gerber: aperture macro with variables and rotation", () => {
  near(lib.evalMacroExpr("$1x2-(3/$2)", [0, 4, 3]), 7);
  const g = lib.parseGerber("%FSLAX26Y26*%%MOMM*%%AMBOX*$3=$1/2*21,1,$1,$2,0,0,90*%%ADD10BOX,2X1*%D10*X0Y0D03*M02*");
  const bb = lib.itemsBBox(g.items);
  near(bb.maxX - bb.minX, 1); near(bb.maxY - bb.minY, 2);
});

test("gerber: step and repeat copies the block", () => {
  const g = lib.parseGerber("%FSLAX26Y26*%%MOMM*%%ADD10C,1*%%SRX3Y2I5.0J4.0*%D10*X0Y0D03*%SR*%M02*");
  assert.strictEqual(g.items.length, 6);
  const bb = lib.itemsBBox(g.items);
  near(bb.maxX, 10.5); near(bb.maxY, 4.5);
});

test("excellon: header formats and slots", () => {
  const e = lib.parseExcellon("M48\nMETRIC,TZ,000.000\nT1C0.800\nT2C1.000\n%\nT1\nX10000Y5000\nX12.5Y5.0\nT2\nX0Y0G85X0Y2000\nM30\n");
  assert.strictEqual(e.items.length, 3);
  const bb = lib.itemsBBox([e.items[0]]);
  near(bb.minX, 9.6); near(bb.maxY, 5.4);
  near(lib.itemsBBox([e.items[1]]).minX, 12.1);
  assert.strictEqual(e.items[2].kind, "stroke"); near(e.items[2].width, 1);
});

test("excellon: inch with leading zeros kept", () => {
  const e = lib.parseExcellon("M48\nINCH,LZ\nT01C0.0320\n%\nT01\nX01Y005\nM30\n");
  const bb = lib.itemsBBox(e.items);
  near((bb.minX + bb.maxX) / 2, 25.4); near((bb.minY + bb.maxY) / 2, 12.7);
});

test("identify: common naming schemes", () => {
  const cases = {
    "board.GTL": "copper/top", "board.GBS": "mask/bottom", "board.GKO": "outline/all",
    "proj-F_Cu.gbr": "copper/top", "proj-B_Silkscreen.gbr": "silk/bottom", "proj-Edge_Cuts.gbr": "outline/all",
    "proj-F_Mask.gbr": "mask/top", "proj-PTH.drl": "drill/all", "hole.grb": "drill/all", "board.G2": "copper/inner",
  };
  for (const [n, want] of Object.entries(cases)) {
    const id = lib.identifyLayer(n, "");
    assert.strictEqual(id.type + "/" + id.side, want, n);
  }
  const x2 = lib.identifyLayer("x.gbr", "%TF.FileFunction,Soldermask,Bot*%");
  assert.strictEqual(x2.type + "/" + x2.side, "mask/bottom");
});

// textpcb's own exporter, when its checkout sits next to this one.
const textpcb = path.join(__dirname, "..", "..", "textpcb", "static", "index.html");
if (fs.existsSync(textpcb)) test("textpcb: its export reads back with the same geometry", () => {
  const s = fs.readFileSync(textpcb, "utf8");
  const a = s.indexOf("function fmtGerberCoord"), b = s.indexOf("function exportGerber");
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(s.slice(a, b) + "\nthis.f = buildGerberFile;", ctx);
  const prims = [
    { type: "line", layer: "P", x1: 0, y1: 0, x2: 10, y2: 0, width: 0.5 },
    { type: "circle", layer: "P", cx: 5, cy: 5, r: 1 },
    { type: "rect", layer: "P", x: 8, y: 8, w: 2, h: 1 },
    { type: "circle", layer: "T", cx: 5, cy: 5, r: 0.4 },
  ];
  const cu = lib.parseGerber(ctx.f(prims, new Set(["P"]), "t", false, { x: 0, y: 0 }));
  assert.strictEqual(cu.warnings.length, 0, cu.warnings.join());
  const bb = lib.itemsBBox(cu.items);
  near(bb.minX, -0.25); near(bb.maxX, 10.25); near(bb.maxY, 9); near(bb.minY, -0.25);
  const drill = lib.loadLayerFile("hole.grb", Buffer.from(ctx.f(prims, new Set(["T"]), "t", true, { x: 0, y: 0 })));
  assert.strictEqual(drill.type, "drill");
  const db = lib.itemsBBox(drill.parsed.items);
  near(db.minX, 4.6); near(db.maxY, 5.4);
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok   " + name); }
    catch (e) { fail++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); }
  }
  console.log(tests.length - fail + "/" + tests.length + " passed");
  process.exit(fail ? 1 : 0);
})();
