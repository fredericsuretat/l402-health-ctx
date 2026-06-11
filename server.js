/**
 * l402-health-ctx — Healthcare Context Extraction API, pay-per-call in sats via L402.
 *
 * Entrée  : CDA r2 (XML) · HL7 v2.x (texte) · FHIR R4 (JSON ou XML) · PDF (binaire)
 * Sortie  : { patient, encounters, medications, diagnoses, alerts, timeline }
 *
 * Endpoints gratuits : /, /health, /stats, /.well-known/l402.json
 * Endpoint payant    : POST /api/v1/extract
 *
 * Config (variables d'environnement) :
 *   LIGHTNING_ADDRESS  → mode managé (0.3% de frais ShinyDapps)
 *   ALBY_TOKEN         → mode direct Alby (0% de frais)
 *   PRICE_SATS         → prix par requête (défaut: 10)
 *   PORT               → défaut: 3403
 *   DASHBOARD_TOKEN    → active /dashboard (optionnel)
 *   NWC_URL            → Nostr Wallet Connect lecture solde (optionnel)
 */

import express from "express";
import multer from "multer";
import { l402, ManagedProvider, AlbyProvider } from "l402-kit";
import { extractHL7 } from "./parsers/hl7.js";
import { extractCDA } from "./parsers/cda.js";
import { extractFHIR } from "./parsers/fhir.js";
import { extractPDF } from "./parsers/pdf.js";

const PORT = Number(process.env.PORT || 3403);
const PRICE_SATS = Number(process.env.PRICE_SATS || 10);

function buildProvider() {
  if (process.env.ALBY_TOKEN) {
    console.log("[lightning] AlbyProvider (mode direct)");
    return new AlbyProvider(process.env.ALBY_TOKEN);
  }
  if (process.env.LIGHTNING_ADDRESS) {
    console.log(`[lightning] ManagedProvider → ${process.env.LIGHTNING_ADDRESS}`);
    return new ManagedProvider(process.env.LIGHTNING_ADDRESS);
  }
  console.error("ERREUR: définir LIGHTNING_ADDRESS ou ALBY_TOKEN (voir .env.example)");
  process.exit(1);
}

const lightning = buildProvider();
const paywall = l402({ priceSats: PRICE_SATS, lightning });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const app = express();
app.disable("x-powered-by");

const stats = {
  started: new Date().toISOString(),
  paid_requests: 0,
  sats_earned: 0,
  by_format: { hl7: 0, cda: 0, fhir: 0, pdf: 0 }
};

// Détection automatique du format depuis Content-Type + contenu
function detectFormat(contentType, body) {
  const ct = (contentType || "").toLowerCase().split(";")[0].trim();
  if (ct === "application/pdf") return "pdf";
  if (ct === "application/fhir+json") return "fhir";
  if (ct === "application/fhir+xml") return "fhir-xml";
  if (["text/xml", "application/xml"].includes(ct)) {
    const snippet = (Buffer.isBuffer(body) ? body.slice(0, 1024).toString() : String(body || "")).slice(0, 1024);
    return snippet.includes("ClinicalDocument") ? "cda" : "fhir-xml";
  }
  if (ct === "application/json") return "fhir";
  // HL7 v2 auto-detect (commence toujours par MSH|)
  const head = Buffer.isBuffer(body) ? body.slice(0, 10).toString() : String(body || "").slice(0, 10);
  if (head.startsWith("MSH|")) return "hl7";
  if (["text/plain", "application/hl7-v2", "x-application/hl7-v2+er7"].includes(ct)) return "hl7";
  return null;
}

// Parsing adaptatif : multer pour multipart, raw buffer pour tout le reste
function flexibleBody(req, res, next) {
  const ct = req.get("content-type") || "";
  if (ct.startsWith("multipart/")) return upload.single("file")(req, res, next);
  express.raw({ type: "*/*", limit: "20mb" })(req, res, next);
}

// --- Endpoints gratuits ---

app.get("/", (_req, res) => {
  res.json({
    name: "l402-health-ctx",
    version: "1.0.0",
    description: "Healthcare context extraction (CDA r2 · HL7 v2.x · FHIR R4 · PDF) — pay-per-call in sats via L402.",
    pricing: { unit: "request", price_sats: PRICE_SATS, protocol: "L402" },
    endpoint: "POST /api/v1/extract",
    input_formats: {
      "HL7 v2.x": "Content-Type: text/plain  (auto-détecté si commence par MSH|)",
      "CDA r2 XML": "Content-Type: text/xml  ou  application/xml",
      "FHIR R4 JSON": "Content-Type: application/fhir+json",
      "FHIR R4 XML": "Content-Type: application/fhir+xml",
      PDF: "Content-Type: application/pdf",
      multipart: "field=file  (format auto-détecté depuis MIME type)"
    },
    output_schema: "{ patient, encounters, medications, diagnoses, alerts, timeline }",
    docs: "https://github.com/fredericsuretat/l402-health-ctx#readme"
  });
});

app.get("/health", (_req, res) => res.json({ ok: true, uptime_s: Math.floor(process.uptime()) }));
app.get("/stats", (_req, res) => res.json(stats));

app.get("/.well-known/l402.json", (_req, res) => {
  res.json({
    version: "1.0",
    protocol: "L402",
    payment: { network: "lightning", min_sats: PRICE_SATS },
    services: [{
      path: "/api/v1/extract",
      method: "POST",
      price_sats: PRICE_SATS,
      description: "Extract structured clinical context (patient, encounters, medications, diagnoses, alerts, timeline) from CDA r2, HL7 v2.x, FHIR R4, or PDF documents.",
      content_types: ["text/plain", "text/xml", "application/xml", "application/fhir+json", "application/fhir+xml", "application/pdf", "multipart/form-data"],
      query_params: { format: "Override auto-detection: hl7 | cda | fhir | fhir-xml | pdf" },
      returns: "{ patient, encounters, medications, diagnoses, alerts, timeline }"
    }]
  });
});

// --- Endpoint payant ---

app.post("/api/v1/extract", flexibleBody, paywall, async (req, res) => {
  let rawBody, contentType;

  if (req.file) {
    rawBody = req.file.buffer;
    contentType = req.file.mimetype || "";
  } else {
    rawBody = req.body;
    contentType = req.get("content-type") || "";
  }

  const fmt = ((req.query.format || "") + "").toLowerCase().trim()
    || detectFormat(contentType, rawBody);

  if (!fmt) {
    return res.status(400).json({
      error: "Format non détecté",
      hint: "Définir Content-Type (text/plain=HL7, text/xml=CDA, application/fhir+json=FHIR, application/pdf=PDF) ou ajouter ?format=hl7|cda|fhir|fhir-xml|pdf"
    });
  }

  let result;
  try {
    const str = () => Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody ?? "");
    switch (fmt) {
      case "hl7":      result = extractHL7(str()); break;
      case "cda":      result = extractCDA(str()); break;
      case "fhir":     result = extractFHIR(str(), "json"); break;
      case "fhir-xml": result = extractFHIR(str(), "xml"); break;
      case "pdf":      result = await extractPDF(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)); break;
      default:
        return res.status(400).json({
          error: `Format non supporté: ${fmt}`,
          supported: ["hl7", "cda", "fhir", "fhir-xml", "pdf"]
        });
    }
  } catch (e) {
    console.error(`[parse-error] format=${fmt}`, e.message);
    return res.status(422).json({ error: "Erreur de parsing", detail: e.message, format: fmt });
  }

  stats.paid_requests++;
  stats.sats_earned += PRICE_SATS;
  const fmtKey = fmt.split("-")[0];
  stats.by_format[fmtKey] = (stats.by_format[fmtKey] || 0) + 1;

  res.json({ format: fmt, extracted_at: new Date().toISOString(), ...result });
});

// --- Dashboard wallet (optionnel, token requis) ---
app.get("/dashboard", async (req, res) => {
  if (!process.env.DASHBOARD_TOKEN || req.query.token !== process.env.DASHBOARD_TOKEN) {
    return res.status(404).json({ error: "not found" });
  }
  if (!process.env.NWC_URL) {
    return res.status(503).json({ error: "NWC_URL not configured" });
  }
  try {
    const { NWCClient } = await import("@getalby/sdk");
    const nwc = new NWCClient({ nostrWalletConnectUrl: process.env.NWC_URL });
    const balance = await nwc.getBalance();
    const txs = await nwc.listTransactions({ limit: 15, type: "incoming" });
    nwc.close();
    const sats = Math.floor(balance.balance / 1000);
    const rows = (txs.transactions || []).map(t => {
      const d = new Date((t.settled_at || t.created_at) * 1000).toLocaleString("fr-FR");
      return `<tr><td>${d}</td><td style="text-align:right">+${Math.floor(t.amount / 1000)} sats</td><td>${(t.description || "").slice(0, 60)}</td></tr>`;
    }).join("");
    res.send(`<!doctype html><html lang="fr"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>⚡ l402-health-ctx — wallet</title>
<style>
 body{font-family:system-ui;background:#0d1117;color:#e6edf3;max-width:700px;margin:2rem auto;padding:0 1rem}
 h1{font-size:1.2rem} .bal{font-size:2.4rem;color:#f7931a;font-weight:700}
 table{width:100%;border-collapse:collapse;margin-top:1rem;font-size:.9rem}
 td{padding:.45rem .3rem;border-bottom:1px solid #21262d}
 .meta{color:#8b949e;font-size:.85rem}
</style>
<h1>⚡ Wallet l402-health-ctx</h1>
<div class="bal">${sats.toLocaleString("fr-FR")} sats</div>
<div class="meta">Session : ${stats.paid_requests} req payées · ${stats.sats_earned} sats · formats: ${JSON.stringify(stats.by_format)}</div>
<h2 style="font-size:1rem;margin-top:1.5rem">Derniers paiements</h2>
<table>${rows || "<tr><td>Aucun paiement pour l'instant</td></tr>"}</table>
</html>`);
  } catch (e) {
    console.error("[dashboard]", e.message);
    res.status(502).json({ error: "wallet connection failed" });
  }
});

app.use((err, _req, res, _next) => {
  console.error("[error]", err.message || err);
  res.status(502).json({ error: "lightning provider unavailable", retry: true });
});

app.listen(PORT, () => {
  console.log(`⚡ l402-health-ctx on :${PORT} — ${PRICE_SATS} sats/req`);
});
