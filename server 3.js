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
  { key:"drain_110", trade:"Drainage", name:"Underground drainage pipe 110mm (per lm)", unit:"lm", rate:5.0, waste:0.05, calcHint:"length of 110mm drain run in linear m" },
  { key:"drain_150", trade:"Drainage", name:"Underground drainage pipe 150mm (per lm)", unit:"lm", rate:8.0, waste:0.05, calcHint:"length of 150mm drain run in linear m" },
  { key:"bend_110", trade:"Drainage", name:"Drainage bend 110mm", unit:"each", rate:3.5, waste:0.05, calcHint:"1 per bend on the 110mm runs" },
  { key:"bend_150", trade:"Drainage", name:"Drainage bend 150mm", unit:"each", rate:8.0, waste:0.05, calcHint:"1 per bend on the 150mm runs" },
  { key:"junction_110", trade:"Drainage", name:"Drainage junction / branch 110mm", unit:"each", rate:5.0, waste:0.05, calcHint:"1 per junction on the 110mm runs" },
  { key:"junction_150", trade:"Drainage", name:"Drainage junction / branch 150mm", unit:"each", rate:12.0, waste:0.05, calcHint:"1 per junction on the 150mm runs" },
  { key:"coupler_110", trade:"Drainage", name:"Drainage coupler / slip union 110mm", unit:"each", rate:2.5, waste:0.05, calcHint:"joints/unions on 110mm runs" },
  { key:"coupler_150", trade:"Drainage", name:"Drainage coupler / slip union 150mm", unit:"each", rate:6.0, waste:0.05, calcHint:"joints/unions on 150mm runs" },
  { key:"manhole_110", trade:"Drainage", name:"Inspection chamber / manhole (110mm system)", unit:"each", rate:90.0, waste:0, calcHint:"1 per IC/manhole on the 110mm system" },
  { key:"manhole_150", trade:"Drainage", name:"Inspection chamber / manhole (150mm system)", unit:"each", rate:130.0, waste:0, calcHint:"1 per IC/manhole on the 150mm system" },
  { key:"manhole_cover", trade:"Drainage", name:"Manhole cover & frame", unit:"each", rate:45.0, waste:0, calcHint:"1 per manhole / IC" },
  { key:"pump_chamber", trade:"Drainage", name:"Foul water pump chamber (packaged)", unit:"each", rate:2000.0, waste:0, calcHint:"1 per pump chamber shown — specialist supply" },
  { key:"drain_bedding", trade:"Drainage", name:"Pea shingle bedding & surround to drains", unit:"tonne", rate:38.0, waste:0.05, calcHint:"~0.3 tonne per lm of drain trench" },
  { key:"beam_block_floor", trade:"Substructure", name:"Beam & block floor system (e.g. Future Foundations)", unit:"m²", rate:45.0, waste:0, calcHint:"ground/first floor area m² — specialist supply" },
  { key:"upvc_window", trade:"Windows & doors", name:"uPVC window (supply)", unit:"each", rate:350.0, waste:0, calcHint:"1 per window on the schedule / elevations" },
  { key:"upvc_door", trade:"Windows & doors", name:"uPVC / composite external door (supply)", unit:"each", rate:550.0, waste:0, calcHint:"1 per external door" },
  { key:"hardcore", trade:"Substructure", name:"Hardcore / Type 1 MOT sub-base", unit:"tonne", rate:35.0, waste:0.05, calcHint:"~2 tonne per m³ of sub-base" },
  { key:"sand_blinding", trade:"Substructure", name:"Sand blinding to sub-base", unit:"tonne", rate:32.0, waste:0.05, calcHint:"thin layer over hardcore" },
  { key:"mesh_a142", trade:"Substructure", name:"Reinforcement mesh A142 (sheet)", unit:"sheet", rate:22.0, waste:0.10, calcHint:"floor slab, ~1 sheet per 8 m² incl laps" },
  { key:"radon_membrane", trade:"Substructure", name:"Radon / gas membrane", unit:"m²", rate:3.5, waste:0.10, calcHint:"ground floor area + laps" },
  { key:"floor_pir", trade:"Substructure", name:"Floor insulation PIR 100mm", unit:"m²", rate:22.0, waste:0.05, calcHint:"ground floor area" },
  { key:"air_brick", trade:"Substructure", name:"Air brick / telescopic underfloor vent", unit:"each", rate:8.0, waste:0.05, calcHint:"~1 per 2m of external wall (beam & block)" },
  { key:"lintel_steel", trade:"External envelope", name:"Steel lintel (cavity, per lm)", unit:"lm", rate:45.0, waste:0.05, calcHint:"opening width + 300mm bearing each end" },
  { key:"lintel_conc", trade:"External envelope", name:"Concrete lintel (per lm)", unit:"lm", rate:12.0, waste:0.05, calcHint:"internal / blockwork openings" },
  { key:"cavity_closer", trade:"External envelope", name:"Cavity closer (per lm)", unit:"lm", rate:4.0, waste:0.05, calcHint:"around window/door reveals" },
  { key:"cavity_tray", trade:"External envelope", name:"Cavity tray (per lm)", unit:"lm", rate:9.0, waste:0.05, calcHint:"over openings / at abutments" },
  { key:"weep_vent", trade:"External envelope", name:"Weep vents", unit:"each", rate:0.5, waste:0.05, calcHint:"~1 per 450mm over cavity trays" },
  { key:"stone_head", trade:"External envelope", name:"Stone head (reconstituted)", unit:"each", rate:45.0, waste:0, calcHint:"1 per window/door head" },
  { key:"stone_cill", trade:"External envelope", name:"Stone cill (reconstituted)", unit:"each", rate:40.0, waste:0, calcHint:"1 per window" },
  { key:"bed_reinf", trade:"External envelope", name:"Bed-joint reinforcement (per lm)", unit:"lm", rate:1.5, waste:0.05, calcHint:"as specified" },
  { key:"ff_joists", trade:"Superstructure", name:"First-floor joists (per m²)", unit:"m²", rate:30.0, waste:0, calcHint:"first floor area — engineered/solid joists" },
  { key:"wall_plate", trade:"Superstructure", name:"Wall plate (treated, per lm)", unit:"lm", rate:3.5, waste:0.10, calcHint:"perimeter at eaves" },
  { key:"straps", trade:"Superstructure", name:"Restraint / holding-down straps", unit:"each", rate:2.5, waste:0.05, calcHint:"~1 per 2m at gables/eaves" },
  { key:"joist_hanger", trade:"Superstructure", name:"Joist hanger", unit:"each", rate:2.0, waste:0.05, calcHint:"1 per joist end" },
  { key:"roof_structure", trade:"Roof", name:"Roof trusses / cut timber (per m²)", unit:"m²", rate:35.0, waste:0, calcHint:"roof plan area — specialist design" },
  { key:"ridge_tile", trade:"Roof", name:"Ridge tiles (per lm)", unit:"lm", rate:12.0, waste:0.05, calcHint:"ridge length" },
  { key:"hip_tile", trade:"Roof", name:"Hip tiles (per lm)", unit:"lm", rate:13.0, waste:0.05, calcHint:"hip length" },
  { key:"dry_ridge", trade:"Roof", name:"Dry ridge / verge kit (per lm)", unit:"lm", rate:14.0, waste:0.05, calcHint:"ridge + verge length" },
  { key:"valley", trade:"Roof", name:"Valley (per lm)", unit:"lm", rate:18.0, waste:0.05, calcHint:"valley length" },
  { key:"lead_flash", trade:"Roof", name:"Lead flashing (per lm)", unit:"lm", rate:25.0, waste:0.05, calcHint:"abutments, chimneys" },
  { key:"fascia", trade:"Roof", name:"Fascia board (per lm)", unit:"lm", rate:9.0, waste:0.05, calcHint:"eaves + verge length" },
  { key:"soffit", trade:"Roof", name:"Soffit board (per lm)", unit:"lm", rate:8.0, waste:0.05, calcHint:"eaves length" },
  { key:"bargeboard", trade:"Roof", name:"Bargeboard (per lm)", unit:"lm", rate:11.0, waste:0.05, calcHint:"verge / gable length" },
  { key:"gutter", trade:"Roof", name:"Guttering (per lm)", unit:"lm", rate:6.0, waste:0.05, calcHint:"eaves length" },
  { key:"downpipe", trade:"Roof", name:"Downpipe (per lm)", unit:"lm", rate:7.0, waste:0.05, calcHint:"downpipe runs" },
  { key:"loft_insul", trade:"Insulation", name:"Loft / roof insulation (per m²)", unit:"m²", rate:7.0, waste:0.05, calcHint:"roof/ceiling area at spec depth" },
  { key:"acoustic_insul", trade:"Insulation", name:"Acoustic insulation to walls/floors (per m²)", unit:"m²", rate:6.0, waste:0.05, calcHint:"internal walls/floors as specified" },
  { key:"screed", trade:"Internal & finishes", name:"Floor screed (per m²)", unit:"m²", rate:16.0, waste:0.05, calcHint:"floor area, ~65mm" },
  { key:"skirting", trade:"Internal & finishes", name:"Skirting (per lm)", unit:"lm", rate:3.5, waste:0.10, calcHint:"room perimeters" },
  { key:"architrave", trade:"Internal & finishes", name:"Architrave (per lm)", unit:"lm", rate:2.8, waste:0.10, calcHint:"~5 lm per door" },
  { key:"int_door", trade:"Internal & finishes", name:"Internal door + lining + ironmongery", unit:"each", rate:110.0, waste:0, calcHint:"1 per doorway" },
  { key:"staircase", trade:"Internal & finishes", name:"Staircase (timber)", unit:"each", rate:2200.0, waste:0, calcHint:"1 per stair flight — specialist" },
  { key:"angle_bead", trade:"Internal & finishes", name:"Plaster angle bead (per lm)", unit:"lm", rate:1.2, waste:0.05, calcHint:"external corners" },
  { key:"scrim", trade:"Internal & finishes", name:"Scrim tape (90m roll)", unit:"roll", rate:3.0, waste:0, calcHint:"board joints" },
  { key:"jointing", trade:"Internal & finishes", name:"Jointing compound (tub)", unit:"tub", rate:13.0, waste:0, calcHint:"board joints / prep" },
  { key:"loft_hatch", trade:"Internal & finishes", name:"Loft hatch", unit:"each", rate:35.0, waste:0, calcHint:"1 per loft access" },
  { key:"wc", trade:"Sanitaryware", name:"WC (close-coupled)", unit:"each", rate:120.0, waste:0, calcHint:"1 per WC" },
  { key:"basin", trade:"Sanitaryware", name:"Wash basin & pedestal/vanity", unit:"each", rate:90.0, waste:0, calcHint:"1 per basin" },
  { key:"bath", trade:"Sanitaryware", name:"Bath (acrylic)", unit:"each", rate:180.0, waste:0, calcHint:"1 per bathroom" },
  { key:"shower_enc", trade:"Sanitaryware", name:"Shower tray & enclosure", unit:"each", rate:250.0, waste:0, calcHint:"1 per shower" },
  { key:"shower_valve", trade:"Sanitaryware", name:"Shower valve / mixer", unit:"each", rate:120.0, waste:0, calcHint:"1 per shower" },
  { key:"taps", trade:"Sanitaryware", name:"Taps (basin/bath set)", unit:"set", rate:70.0, waste:0, calcHint:"1 set per basin/bath" },
  { key:"svp", trade:"Above-ground drainage", name:"Soil & vent pipe 110mm (per lm)", unit:"lm", rate:8.0, waste:0.05, calcHint:"vertical soil stacks + vent" },
  { key:"waste_pipe", trade:"Above-ground drainage", name:"Waste pipe 32/40mm (per lm)", unit:"lm", rate:2.5, waste:0.05, calcHint:"basin/bath/sink wastes" },
  { key:"kitchen", trade:"Kitchen", name:"Kitchen units & worktops (provisional)", unit:"item", rate:6000.0, waste:0, calcHint:"provisional sum — client choice" },
  { key:"fixings", trade:"Fixings & sundries", name:"Fixings & fasteners allowance", unit:"item", rate:250.0, waste:0, calcHint:"general build allowance" },
  { key:"foam", trade:"Fixings & sundries", name:"Expanding foam (can)", unit:"can", rate:6.0, waste:0, calcHint:"gap filling" },
  { key:"plasticiser", trade:"Fixings & sundries", name:"Mortar plasticiser (5L)", unit:"tub", rate:7.0, waste:0, calcHint:"mortar additive" },
];
const BY_KEY = Object.fromEntries(LIBRARY.map((m) => [m.key, m]));
const LIB_KEYS = LIBRARY.map((m) => m.key);
const BY_NAME = Object.fromEntries(LIBRARY.map((m) => [m.name.toLowerCase().trim(), m]));

function costLines(lines) {
  return lines.map((l) => {
    const lib = BY_KEY[l.libraryKey] || BY_NAME[(l.name || "").toLowerCase().trim()];
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

RULES: quantities are numbers only; give a SHORT "basis" (a few words + sheet ref, not a paragraph); "confidence" is high/medium/low; note assumptions and anything needing floor plans in meta.missingInfo; specialist packages (timber frame kit, beam & block, trusses, windows) can be OTHER lines at low confidence.

Return STRICT JSON ONLY, no prose, no code fences:
{"meta":{"project":"","detectedScale":"","buildingType":"","assumptions":[],"missingInfo":[]},
 "lines":[{"libraryKey":"facing_brick","name":"Facing brick","quantity":15600,"unit":"brick","basis":"...","confidence":"medium","sourceSheet":"113"}]}`;
}
function parseModelJson(text) {
  let t = (text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("The AI couldn't produce a readable take-off this time — please try again (or try fewer / clearer sheets).");
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
  // Force structured output via a tool call — reliable, and supported by current models.
  const msg = await client.messages.create({
    model: MODEL, max_tokens: 16000, system: SYSTEM_PROMPT,
    tools: [{ name: "submit_takeoff", description: "Return the material take-off as structured data. For every line, libraryKey MUST be one of the allowed price-list codes (or 'OTHER' only if nothing fits).",
      input_schema: { type: "object", properties: {
        meta: { type: "object", properties: { project:{type:"string"}, detectedScale:{type:"string"}, buildingType:{type:"string"}, assumptions:{type:"array",items:{type:"string"}}, missingInfo:{type:"array",items:{type:"string"}} } },
        lines: { type: "array", items: { type: "object", properties: {
          libraryKey: { type: "string", enum: LIB_KEYS.concat("OTHER") },
          name: { type: "string" }, quantity: { type: "number" }, unit: { type: "string" },
          basis: { type: "string" }, confidence: { type: "string", enum: ["high","medium","low"] },
          sourceSheet: { type: "string" }, unitRate: { type: "number" }
        }, required: ["libraryKey","name","quantity"] } }
      }, required: ["lines"] } }],
    tool_choice: { type: "tool", name: "submit_takeoff" },
    messages: [{ role: "user", content }],
  });
  const tu = msg.content.find((b) => b.type === "tool_use");
  const parsed = tu ? tu.input : {};
  const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
  console.log(`[takeoff] stop=${msg.stop_reason} out_tokens=${msg.usage && msg.usage.output_tokens} lines=${lines.length}`);
  return { meta: parsed.meta || {}, lines };
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
