/**
 * Extraction CDA r2 (Clinical Document Architecture) → contexte structuré
 * Référentiel : CI-SIS ANS (e-santé.gouv.fr), volet Structuration Minimale v1.16
 * Documents supportés : CRH, CRO, LDL, OMS, CR Imagerie, DM, VAC
 *
 * Sections par code LOINC :
 *   10160-0  Traitements en cours / Historique médicamenteux
 *   10183-2  Médicaments à la sortie
 *   11450-4  Liste des problèmes / Diagnostics actifs
 *   29548-5  Diagnostic principal
 *   48765-2  Allergies et réactions indésirables
 *   46240-8  Hospitalisations antérieures
 *   47519-4  Antécédents médicaux
 *   57827-8  Résumé de sortie / Compte-rendu d'hospitalisation
 */

import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (name) => ["component", "entry", "entryRelationship", "id", "templateId",
    "telecom", "name", "addr", "participant", "performer", "author"].includes(name),
  trimValues: true
});

const LOINC_MEDS = new Set(["10160-0", "10183-2", "57827-8", "57828-6", "18776-5"]);
const LOINC_DIAG = new Set(["11450-4", "29548-5", "29762-2", "46240-8", "47519-4"]);
const LOINC_ALLERGY = new Set(["48765-2", "48764-5"]);

const a = (node, name) => node?.[`@${name}`] ?? null;

function cdaDate(val) {
  if (!val) return null;
  const s = String(val).replace(/\D/g, "");
  if (s.length < 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function cdaName(nameNode) {
  if (!nameNode) return { family: null, given: null };
  const n = Array.isArray(nameNode) ? nameNode[0] : nameNode;
  if (typeof n === "string") return { family: n, given: null };
  return {
    family: Array.isArray(n.family) ? n.family[0] : n.family || null,
    given: Array.isArray(n.given) ? n.given.join(" ") : n.given || null
  };
}

function firstId(ids, domain) {
  if (!ids) return null;
  const arr = Array.isArray(ids) ? ids : [ids];
  if (domain) {
    const hit = arr.find(i => (a(i, "root") || "").includes(domain) || (a(i, "extension") || "").startsWith(domain));
    if (hit) return a(hit, "extension");
  }
  return a(arr[0], "extension") || a(arr[0], "root") || null;
}

function extractEntries(section) {
  if (!section) return [];
  const entries = section.entry;
  if (!entries) return [];
  return Array.isArray(entries) ? entries : [entries];
}

function extractMeds(section) {
  return extractEntries(section).flatMap(entry => {
    const sa = entry.substanceAdministration || entry.act?.entryRelationship?.find?.(er => er.substanceAdministration)?.substanceAdministration;
    if (!sa) return [];
    const mat = sa.consumable?.manufacturedProduct?.manufacturedMaterial;
    const codeNode = mat?.code;
    const name = a(codeNode, "displayName") || (typeof mat?.name === "string" ? mat.name : null);
    const code = a(codeNode, "code") || null;
    if (!name && !code) return [];
    const dq = sa.doseQuantity;
    const rCode = sa.routeCode;
    const eff = sa.effectiveTime;
    const effArr = Array.isArray(eff) ? eff : [eff];
    const period = effArr.find(e => e?.low || e?.high);
    return [{
      name,
      code,
      dose: a(dq, "value") ? `${a(dq, "value")} ${a(dq, "unit") || ""}`.trim() : null,
      route: a(rCode, "displayName") || a(rCode, "code") || null,
      frequency: null,
      start: cdaDate(a(period?.low || effArr[0], "value")),
      end: cdaDate(a(period?.high, "value")),
      status: a(sa, "moodCode") === "INT" ? "planned" : "active"
    }];
  }).filter(m => m.name || m.code);
}

function extractDiags(section) {
  return extractEntries(section).flatMap(entry => {
    const obs = entry.observation
      || entry.act?.entryRelationship?.find?.(er => er.observation)?.observation;
    if (!obs) return [];
    const val = obs.value || {};
    const code = a(val, "code") || a(obs.code, "code") || null;
    const display = a(val, "displayName") || a(obs.code, "displayName") || null;
    if (!code) return [];
    return [{
      code,
      display,
      type: a(obs.code, "code") === "11450-4" ? "principal" : "associated",
      date: cdaDate(a(obs.effectiveTime, "value") || a(obs.effectiveTime?.low, "value"))
    }];
  }).filter(d => d.code);
}

function extractAllergies(section) {
  return extractEntries(section).flatMap(entry => {
    const act = entry.act;
    const rels = act?.entryRelationship;
    const obs = Array.isArray(rels) ? rels.find(r => r.observation)?.observation : rels?.observation;
    if (!obs) return [];
    const participants = obs.participant || [];
    const subst = (Array.isArray(participants) ? participants[0] : participants)
      ?.participantRole?.playingEntity;
    const substance = a(subst?.code, "displayName") || subst?.name || null;
    if (!substance) return [];
    return [{
      type: "allergy",
      substance,
      reaction: a(obs.value, "displayName") || null,
      severity: a(obs.priorityCode, "code") || null
    }];
  }).filter(a => a.substance);
}

function buildTimeline(ctx) {
  const ev = [];
  for (const e of ctx.encounters || []) {
    if (e.start) ev.push({ date: e.start, type: "encounter", label: e.type || "Séjour", ref: e.id });
    if (e.end) ev.push({ date: e.end, type: "encounter_end", label: "Fin séjour", ref: e.id });
  }
  for (const m of ctx.medications || []) {
    if (m.start) ev.push({ date: m.start, type: "medication_start", label: m.name || m.code, ref: m.code });
  }
  for (const d of ctx.diagnoses || []) {
    if (d.date) ev.push({ date: d.date, type: "diagnosis", label: [d.code, d.display].filter(Boolean).join(" "), ref: d.code });
  }
  return ev.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

export function extractCDA(xml) {
  const parsed = xmlParser.parse(xml);
  const root = parsed.ClinicalDocument || Object.values(parsed)[0];
  if (!root) return empty();

  // --- Patient ---
  const patRole = root.recordTarget?.patientRole;
  let patient = null;
  if (patRole) {
    const ids = Array.isArray(patRole.id) ? patRole.id : [patRole.id];
    const ipp = firstId(ids) || null;
    const pat = patRole.patient || {};
    const name = cdaName(pat.name);
    const addr = patRole.addr;
    const addrNode = Array.isArray(addr) ? addr[0] : addr;

    patient = {
      id: ipp,
      family_name: name.family,
      given_name: name.given,
      birth_date: cdaDate(a(pat.birthTime, "value")),
      gender: a(pat.administrativeGenderCode, "code") || null,
      nir: null,
      address: addrNode ? [addrNode.streetAddressLine, addrNode.postalCode, addrNode.city].filter(Boolean).join(", ") : null
    };
  }

  // --- Encounter (encompassingEncounter) ---
  const encounters = [];
  const ee = root.componentOf?.encompassingEncounter;
  if (ee) {
    const ids = Array.isArray(ee.id) ? ee.id : [ee.id];
    const iep = firstId(ids);
    const eff = ee.effectiveTime;
    encounters.push({
      id: iep,
      type: a(ee.code, "displayName") || a(ee.code, "code") || null,
      start: cdaDate(a(eff?.low, "value")),
      end: cdaDate(a(eff?.high, "value")),
      ward: a(ee.location?.healthCareFacility?.code, "displayName") || null,
      practitioner: null
    });
    // Praticien responsable
    const resp = ee.responsibleParty?.assignedEntity;
    if (resp) {
      const rn = cdaName(resp.assignedPerson?.name);
      encounters[0].practitioner = [rn.given, rn.family].filter(Boolean).join(" ") || null;
    }
  }

  // --- Sections structurées ---
  const medications = [], diagnoses = [], alerts = [];
  const body = root.component?.structuredBody;
  if (body) {
    const components = Array.isArray(body.component) ? body.component : [body.component];
    for (const comp of components) {
      const section = comp?.section;
      if (!section) continue;
      const code = a(section.code, "code") || "";
      if (LOINC_MEDS.has(code)) medications.push(...extractMeds(section));
      else if (LOINC_DIAG.has(code)) diagnoses.push(...extractDiags(section));
      else if (LOINC_ALLERGY.has(code)) alerts.push(...extractAllergies(section));
      // Sections imbriquées (CDA avec sous-sections)
      const subComponents = Array.isArray(section.component) ? section.component : [];
      for (const sub of subComponents) {
        const subSection = sub?.section;
        if (!subSection) continue;
        const subCode = a(subSection.code, "code") || "";
        if (LOINC_MEDS.has(subCode)) medications.push(...extractMeds(subSection));
        else if (LOINC_DIAG.has(subCode)) diagnoses.push(...extractDiags(subSection));
        else if (LOINC_ALLERGY.has(subCode)) alerts.push(...extractAllergies(subSection));
      }
    }
  }

  return { patient, encounters, medications, diagnoses, alerts, timeline: buildTimeline({ encounters, medications, diagnoses, alerts }) };
}

function empty() {
  return { patient: null, encounters: [], medications: [], diagnoses: [], alerts: [], timeline: [] };
}
