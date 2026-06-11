/**
 * Extraction heuristique depuis documents médicaux PDF (FR)
 * Supporte : compte-rendu d'hospitalisation, ordonnance, courrier médical,
 *            CR opératoire, lettre de liaison, bilan biologique
 *
 * Stratégie : extraction texte brut via pdf-parse + patterns regex FR
 * Limites : qualité dépend du PDF (texte natif vs scan OCR)
 */

// Import spécifique pour éviter le bug "test/version.txt" de pdf-parse en ESM
import pdfParse from "pdf-parse/lib/pdf-parse.js";

// --- Patterns ---
const RE_DATE_FR = /\b(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})\b/g;
const RE_DATE_FR1 = /\b(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})\b/;
const RE_NIR = /\b([12]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2})\b/;
const RE_CIM10 = /\b([A-Z]\d{2}(?:\.\d{0,2})?)\b/g;
const RE_DOSE = /\b(\d+(?:[,.]\d+)?)\s*(mg|mcg|µg|μg|g\b|ml|UI|cp\.?|gél\.?|comprimés?|ampoules?|patch|sachet)/gi;
const RE_ALLERGY = /(?:allergi[eé][^\n:]*?[:\s]+|intolérance\s+(?:à\s+|au?\s+|aux?\s+))([^\n,.;]{3,80})/gi;
const RE_STAY = /(?:séjour|hospitalisation|admission)\s+du\s+(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{4})\s+au\s+(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{4})/i;
const RE_SERVICE = /(?:service\s*:?|unité\s+(?:de\s+soins\s*:?)?|uf\s*:?)\s*([^\n,;]{3,60})/i;
const RE_DOCTOR = /(?:dr\.?\s+|docteur\s+|pr\.?\s+|professeur\s+|médecin\s*:?\s*)([A-ZÀÂÉÈÊËÎÏÔÛÙÜÇ][a-zA-ZÀ-ÿ\-]+(?:\s+[A-ZÀÂÉÈÊËÎÏÔÛÙÜÇ][a-zA-ZÀ-ÿ\-]+)?)/;

// Sections médicament types ordonnance FR
const MED_SECTION_RE = /(?:TRAITEMENT(?:S)?(?:\s+EN\s+COURS|\s+À\s+LA\s+SORTIE|\s+DE\s+SORTIE)?|ORDONNANCE(?:\s+DE\s+SORTIE)?|MÉDICAMENTS?\s*:?|PRESCRIPTIONS?\s*:?|THÉRAPEUTIQUES?\s*:?)[^\n]*\n((?:[^\n]+\n?){1,40})/i;

function toISO(d, m, y) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function firstDateISO(text) {
  const m = RE_DATE_FR1.exec(text);
  return m ? toISO(m[1], m[2], m[3]) : null;
}

function allDates(text) {
  const dates = [];
  let m;
  RE_DATE_FR.lastIndex = 0;
  while ((m = RE_DATE_FR.exec(text)) !== null) {
    dates.push(toISO(m[1], m[2], m[3]));
  }
  return [...new Set(dates)].sort();
}

function extractAfter(text, patterns) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[1]?.trim() || null;
  }
  return null;
}

function capitalize(s) {
  if (!s) return s;
  return s.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

function buildTimeline(ctx) {
  const ev = [];
  for (const e of ctx.encounters || []) {
    if (e.start) ev.push({ date: e.start, type: "encounter", label: "Hospitalisation", ref: e.ward });
    if (e.end) ev.push({ date: e.end, type: "encounter_end", label: "Sortie", ref: e.ward });
  }
  for (const d of ctx.diagnoses || []) {
    if (d.date) ev.push({ date: d.date, type: "diagnosis", label: d.code, ref: d.code });
  }
  return ev.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

export async function extractPDF(buffer) {
  let text = "";
  try {
    const data = await pdfParse(buffer);
    text = data.text || "";
  } catch {
    return empty();
  }
  if (!text.trim()) return empty();

  // Normalisation : effacer les césures, normaliser les espaces
  const t = text.replace(/-\n([a-z])/g, "$1").replace(/\n{3,}/g, "\n\n");

  // --- Patient ---
  const familyName = extractAfter(t, [
    /\bNOM\s+(?:DE\s+NAISSANCE\s*)?[:\-]?\s*([A-ZÀÂÉÈÊËÎÏÔÛÙÜÇ][A-ZÀÂÉÈÊËÎÏÔÛÙÜÇ\s\-]{1,30}?)(?=\s*\n|\s{2,}|\s*PRÉNOM)/,
    /\bPATIENT(?:E)?\s*[:\-]?\s*([A-ZÀÂÉÈÊËÎÏÔÛÙÜÇ][A-Za-zÀ-ÿ\s\-]{1,30}?)(?=\s*\n|\s{2,})/,
    /\bMme?\.?\s+([A-ZÀÂÉÈÊËÎÏÔÛÙÜÇ][A-Za-zÀ-ÿ\-]+)/
  ]);
  const givenName = extractAfter(t, [
    /\bPRÉNOM\s*[:\-]?\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-]{1,30}?)(?=\s*\n|\s{2,})/i,
    /\bPRENOM\s*[:\-]?\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\-]{1,30}?)(?=\s*\n|\s{2,})/i
  ]);
  const bdText = extractAfter(t, [
    /\bNÉ\(?E?\)?\s+LE\s*[:\-]?\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{4})/i,
    /\bDATE\s+(?:DE\s+)?NAISS(?:ANCE)?\s*[:\-]?\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{4})/i,
    /\bD\.?D\.?N\.?\s*[:\-]?\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{4})/i
  ]);
  const nirM = RE_NIR.exec(t);
  const isMale = /\b(M\.|Mr\.?|masculin|sexe\s*:\s*M)\b/i.test(t);
  const isFemale = /\b(Mme\.?|madame|féminin|féminin|sexe\s*:\s*F)\b/i.test(t);

  const patient = (familyName || givenName || bdText) ? {
    id: null,
    family_name: familyName ? capitalize(familyName) : null,
    given_name: givenName ? capitalize(givenName) : null,
    birth_date: bdText ? firstDateISO(bdText) : null,
    gender: isMale ? "male" : isFemale ? "female" : null,
    nir: nirM ? nirM[1].replace(/\s/g, "") : null,
    address: null
  } : null;

  // --- Encounters ---
  const encounters = [];
  const stayM = RE_STAY.exec(t);
  if (stayM) {
    encounters.push({
      id: null,
      type: "inpatient",
      start: firstDateISO(stayM[1]),
      end: firstDateISO(stayM[2]),
      ward: extractAfter(t, [RE_SERVICE]) || null,
      practitioner: extractAfter(t, [RE_DOCTOR]) || null
    });
  }

  // --- Diagnoses (codes CIM-10 dans le texte) ---
  const diagDates = allDates(t);
  const refDate = diagDates[0] || null;
  const diagCodes = new Set();
  RE_CIM10.lastIndex = 0;
  let cimM;
  while ((cimM = RE_CIM10.exec(t)) !== null) {
    // Filtrer les faux positifs (ex: numéros de chambre B12, codes postaux...)
    const code = cimM[1];
    if (/^[A-TV-Z]/.test(code) && code.length >= 3) diagCodes.add(code);
  }
  const diagnoses = [...diagCodes].map(code => ({
    code,
    display: null,
    type: "diagnosis",
    date: refDate
  }));

  // --- Medications ---
  const medications = [];
  const medSection = MED_SECTION_RE.exec(t);
  if (medSection) {
    const lines = medSection[1].split("\n")
      .map(l => l.trim())
      .filter(l => l.length > 3 && (RE_DOSE.test(l) || /\b(cp|gél|comprimé|injection|solution|sirop|patch|IV|IM|SC|PO)\b/i.test(l)));
    RE_DOSE.lastIndex = 0;

    for (const line of lines.slice(0, 20)) {
      RE_DOSE.lastIndex = 0;
      const doseM = RE_DOSE.exec(line);
      const nameRaw = line.split(/\s+\d/)[0].trim().slice(0, 80);
      if (nameRaw.length >= 3) {
        medications.push({
          name: nameRaw,
          code: null,
          dose: doseM ? `${doseM[1]} ${doseM[2]}` : null,
          route: /\b(IV|intraveineu|injection)\b/i.test(line) ? "IV"
            : /\b(IM|intramusculaire)\b/i.test(line) ? "IM"
            : /\b(SC|sous.cutan)\b/i.test(line) ? "SC"
            : /\b(PO|oral|comprimé|gélule|per os)\b/i.test(line) ? "oral"
            : null,
          frequency: /\b(\d+)\s*(?:fois|x)\s*(?:par\s+)?j(?:our)?\b/i.exec(line)?.[0] || null,
          start: null,
          end: null,
          status: "active"
        });
      }
    }
  }

  // --- Alerts / Allergies ---
  const alerts = [];
  RE_ALLERGY.lastIndex = 0;
  let allergyM;
  while ((allergyM = RE_ALLERGY.exec(t)) !== null) {
    const substance = allergyM[1].trim().replace(/[.,;]+$/, "");
    if (substance.length >= 3) {
      alerts.push({ type: "allergy", substance, reaction: null, severity: null });
    }
  }

  return {
    patient,
    encounters,
    medications,
    diagnoses,
    alerts,
    timeline: buildTimeline({ encounters, diagnoses })
  };
}

function empty() {
  return { patient: null, encounters: [], medications: [], diagnoses: [], alerts: [], timeline: [] };
}
