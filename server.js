// TakeOff — single-file server (iPad-friendly: no folders needed).
// Everything (pricing, prompt, engine, web server) is in this one file.
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { pdf } from "pdf-to-img";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const MAX_LONG_EDGE = 1560;

/* ---------------- UK MATERIAL LIBRARY (edit rates to your own prices) ---------------- */
const LIBRARY = [
  { key:"block_100", trade:"Substructure", name:"Concrete block 100mm (7.3N)", unit:"block", rate:0.85, waste:0.05, calcHint:"10 blocks per m² of wall" },
  { key:"block_140_10n", trade:"Substructure", name:"Blockwork 140mm 10N (below DPC)", unit:"block", rate:1.30, waste:0.05, calcHint:"10 blocks per m² of wall" },
  { key:"eng_brick", trade:"Substructure", name:"Engineering brick, Class B", unit:"brick", rate:0.60, waste:0.05, calcHint:"60 bricks per m² of half-brick leaf" },
  { key:"dpc_100", trade:"Substructure", name:"DPC 100mm x 30m roll", unit:"roll", rate:10.0, waste:0, calcHint:"wall run (linear m) ÷ 30" },
  { key:"dpm", trade:"Substructure", name:"DPM 1200g (4x25m roll)", unit:"roll", rate:42.0, waste:0, calcHint:"floor area m² ÷ ~100" },
  { key:"trench_conc", trade:"Substructure", name:"Trench-fill concrete (foundations)", unit:"m³", rate:120.0, waste:0.05, calcHint:"trench length × width × depth; engineer's design" },
  { key:"facing_brick", trade:"External envelope", name:"Facing brick (103mm outer leaf)", unit:"brick", rate:0.50, waste:0.05, calcHint:"60 bricks per m², net of openings" },
  { key:"frame_ties", trade:"External envelope", name:"Timber-frame brick ties (box 250)", unit:"box", rate:85.0, waste:0.05, calcHint:"~4 ties per m² ÷ 250" },
  { key:"celotex_pl", trade:"External envelope", name:"Insulated plasterboard Celotex PL4025", unit:"board", rate:30.0, waste:0.05, calcHint:"wall area m² ÷ 2.88" },
  { key:"cavity_batt", trade:"External envelope", name:"Cavity/frame insulation batt 100mm", unit:"m²", rate:8.0, waste:0.05, calcHint:"wall area m²" },
  { key:"cement", trade:"External envelope", name:"Cement (25kg bag)", unit:"bag", rate:8.0, waste:0, calcHint:"~0.5 bag per m² masonry" },
  { key:"build_sand", trade:"External envelope", name:"Building sand (tonne)", unit:"tonne", rate:32.0, waste:0, calcHint:"~0.5 tonne per 1000 bricks" },
  { key:"roof_tile", trade:"Roof", name:"Concrete roof tiles", unit:"m²", rate:13.0, waste:0.05, calcHint:"plan area × ~1.25 pitch factor" },
  { key:"batten_membr", trade:"Roof", name:"Battens + breather membrane", unit:"m²", rate:3.5, waste:0.05, calcHint:"same as roof covering area" },
  { key:"plasterboard", trade:"Internal & finishes", name:"Plasterboard 12.5mm (2.4x1.2)", unit:"sheet", rate:6.5, waste:0.10, calcHint:"wall+ceiling area m² ÷ 2.88" },
  { key:"skim", trade:"Internal & finishes", name:"Multi-finish plaster (25kg)", unit:"bag", rate:10.0, waste:0, calcHint:"boarded area m² ÷ ~10" },
  { key:"cls_stud", trade:"Internal & finishes", name:"CLS studwork 89x38 (per lm)", unit:"lm", rate:1.10, waste:0.05, calcHint:"partition wall area m² × ~4.5 lm" },
  { key:"floor_deck", trade:"Internal & finishes", name:"Chipboard flooring 22mm T&G", unit:"board", rate:22.0, waste:0.05, calcHint:"floor area m² ÷ 1.44" },
  { key:"wall_tile", trade:"Bathroom / tiling", name:"Ceramic wall tiles", unit:"m²", rate:25.0, waste:0.10, calcHint:"tiled wall area m²" },
  { key:"floor_tile", trade:"Bathroom / tiling", name:"Porcelain floor tiles", unit:"m²", rate:45.0, waste:0.10, calcHint:"tiled floor area m²" },
  { key:"tile_adh", trade:"Bathroom / tiling", name:"Tile adhesive (20kg)", unit:"bag", rate:16.0, waste:0, calcHint:"tiled area m² ÷ ~5" },
  { key:"grout", trade:"Bathroom / tiling", name:"Grout (5kg)", unit:"tub", rate:11.0, waste:0, calcHint:"tiled area m² ÷ ~10" },
  { key:"backer", trade:"Bathroom / tiling", name:"Tile backer board 12mm", unit:"board", rate:11.0, waste:0.05, calcHint:"wet wall area m² ÷ 0.72" },
  { key:"silicone", trade:"Bathroom / tiling", name:"Silicone sealant", unit:"tube", rate:6.0, waste:0, calcHint:"perimeter lm ÷ ~8" },
];
const BY_KEY = Object.fromEntries(LIBRARY.map((m) => [m.key, m]));

function costLines(lines) {
  return lines.map((l) => {
    const lib = BY_KEY[l.libraryKey];
    const rate = lib ? lib.rate : (typeof l.unitRate === "number" ? l.unitRate : 0);
    const waste = lib ? lib.waste : (l.waste ?? 0);
    const qty = Number(l.quantity) || 0;
    return {
      trade: l.trade || (lib ? lib.trade : "Other"),
      libraryKey: l.libraryKey || "OTHER",
      name: l.name || (lib ? lib.name : l.description) || "Unnamed item",
      basis: l.basis || "", quantity: qty, unit: l.unit || (lib ? lib.unit : ""),
      waste, rate, lineTotal: qty * (1 + waste) * rate,
      confidence: l.confidence || "medium",
      needsPrice: !lib && !(typeof l.unitRate === "number"),
      sourceSheet: l.sourceSheet || "",
    };
  });
}
function totals(costed) {
  const net = costed.reduce((s, l) => s + l.lineTotal, 0);
  return { net, vat: net * 0.2, gross: net * 1.2 };
}

/* ---------------- PROMPT ---------------- */
const libraryTable = LIBRARY.map((m) => `- ${m.key} | ${m.name} | unit: ${m.unit} | rule: ${m.calcHint}`).join("\n");
const SYSTEM_PROMPT = "You are an expert UK construction estimator / quantity surveyor. You read architectural drawings and produce a DRAFT material take-off for a human to confirm. You are careful and conservative, you state how each quantity was derived, and you never invent dimensions you cannot see — if you must assume, you say so and lower the confidence.";
function buildUserPrompt(sheetNames) {
  return `I am sending ${sheetNames.length} drawing sheet image(s): ${sheetNames.join(", ")}.

STEP 1 — Read the drawings: find the SCALE from each title block; read overall dimensions and grid lines; identify wall build-ups / construction notes; read window/door schedules and count openings; estimate room/wall/roof/floor areas.

STEP 2 — Produce take-off lines. Map each to ONE library item where possible (use the exact libraryKey) and apply its rule:
${libraryTable}

If something needed is NOT in the library, include it with "libraryKey":"OTHER", a clear "name", best "quantity"/"unit", and if possible a "unitRate" in GBP ex-VAT.

RULES: quantities are numbers only; give "basis" (how derived, citing the sheet); "confidence" is high/medium/low; note assumptions and anything needing floor plans in meta.missingInfo; specialist packages (timber frame kit, beam & block, trusses, windows) can be OTHER lines at low confidence.

Return STRICT JSON ONLY, no prose, no code fences:
{"meta":{"project":"","detectedScale":"","buildingType":"","assumptions":[],"missingInfo":[]},
 "lines":[{"libraryKey":"facing_brick","name":"Facing brick","quantity":15600,"unit":"brick","basis":"...","confidence":"medium","sourceSheet":"113"}]}`;
}
function parseModelJson(text) {
  let t = (text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("No JSON object found in model reply");
  return JSON.parse(t.slice(s, e + 1));
}

/* ---------------- ENGINE ---------------- */
async function pdfBuffersToImages(files) {
  const images = [];
  for (const file of files) {
    const doc = await pdf(file.buffer, { scale: 2.0 });
    for await (const pageBuffer of doc) {
      const png = await sharp(pageBuffer).resize({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE, fit: "inside", withoutEnlargement: true }).png().toBuffer();
      images.push({ name: file.originalname, b64: png.toString("base64") });
      break; // first page of each PDF
    }
  }
  return images;
}
async function extractTakeoff(images) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const content = [{ type: "text", text: buildUserPrompt(images.map((i) => i.name)) }];
  for (const img of images) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: img.b64 } });
 const msg = await client.messages.create({
    model: MODEL, max_tokens: 8000, system: SYSTEM_PROMPT,
    tools: [{ name: "submit_takeoff", description: "Return the material take-off as structured data.",
      input_schema: { type: "object", properties: { meta: { type: "object" }, lines: { type: "array", items: { type: "object" } } }, required: ["lines"] } }],
    tool_choice: { type: "tool", name: "submit_takeoff" },
    messages: [{ role: "user", content }],
  });
  const tu = msg.content.find((b) => b.type === "tool_use");
  const parsed = tu ? tu.input : {};
  return { meta: parsed.meta || {}, lines: Array.isArray(parsed.lines) ? parsed.lines : [] };
}
async function runTakeoff(files) {
  const images = await pdfBuffersToImages(files);
  const { meta, lines } = await extractTakeoff(images);
  const costed = costLines(lines);
  return { meta, sheets: images.map((i) => i.name), lines: costed, totals: totals(costed) };
}

/* ---------------- WEB SERVER ---------------- */
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// Optional shared-password gate (set ACCESS_PASSWORD in the host to enable).
app.use((req, res, next) => {
  const pw = process.env.ACCESS_PASSWORD;
  if (!pw) return next();
  const [, b64] = (req.headers.authorization || "").split(" ");
  const [, pass] = Buffer.from(b64 || "", "base64").toString().split(":");
  if (pass === pw) return next();
  res.set("WWW-Authenticate", 'Basic realm="TakeOff"').status(401).send("Authentication required");
});

app.get("/", (_req, res) => res.type("html").send(fs.readFileSync(path.join(__dirname, "index.html"), "utf8")));
app.get("/api/library", (_req, res) => res.json(LIBRARY));
app.post("/api/takeoff", upload.array("drawings", 12), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No drawings uploaded." });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set." });
    res.json(await runTakeoff(req.files));
  } catch (err) { console.error(err); res.status(500).json({ error: err.message || "Take-off failed." }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("TakeOff running on port " + PORT));
