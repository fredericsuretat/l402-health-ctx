/**
 * Extraction FHIR R4 → contexte structuré
 * Supporte : Bundle · Patient · Encounter · MedicationRequest · MedicationStatement
 *            MedicationAdministration · Condition · AllergyIntolerance · Composition
 * Identifiants FR : type MR (IPP), type SS (NIR/numéro sécu)
 */

import { XMLParser } from "fast-xml-parser";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (name) => ["entry", "identifier", "name", "address", "telecom",
    "coding", "category", "participant", "location", "reaction",
    "dosageInstruction", "dosage", "note", "performer"].includes(name),
  trimValues: true
});

function buildTimeline(ctx) {
  const ev = [];
  for (const e of ctx.encounters || []) {
    if (e.start) ev.push({ date: e.start, type: "encounter", label: e.type || "Encounter", ref: e.id });
    if (e.end) ev.push({ date: e.end, type: "encounter_end", label: "End of encounter", ref: e.id });
  }
  for (const m of ctx.medications || []) {
    if (m.start) ev.push({ date: m.start, type: "medication_start", label: m.name || m.code, ref: m.code });
    if (m.end) ev.push({ date: m.end, type: "medication_end", label: m.name || m.code, ref: m.code });
  }
  for (const d of ctx.diagnoses || []) {
    if (d.date) ev.push({ date: d.date, type: "diagnosis", label: [d.code, d.display].filter(Boolean).join(" "), ref: d.code });
  }
  return ev.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

function empty() {
  return { patient: null, encounters: [], medications: [], diagnoses: [], alerts: [], timeline: [] };
}

// --- Mappers individuels ---

function mapPatient(r) {
  const ids = r.identifier || [];
  const ipp = ids.find(i => i.type?.coding?.[0]?.code === "MR" || i.type?.text === "IPP")?.value
    || ids.find(i => i.type?.coding?.[0]?.code === "PI")?.value
    || r.id || null;
  const nir = ids.find(i =>
    i.type?.coding?.[0]?.code === "SS"
    || (i.system || "").includes("assurance-maladie")
    || (i.system || "").includes("securite-sociale")
  )?.value || null;

  const nameObj = r.name?.[0] || {};
  const family = Array.isArray(nameObj.family) ? nameObj.family.join(" ") : nameObj.family || null;
  const given = Array.isArray(nameObj.given) ? nameObj.given.join(" ") : nameObj.given || null;

  const addr = r.address?.[0];
  const addrStr = addr ? [...(addr.line || []), addr.postalCode, addr.city].filter(Boolean).join(", ") : null;

  return {
    id: ipp,
    family_name: family,
    given_name: given,
    birth_date: r.birthDate || null,
    gender: r.gender || null,
    nir,
    address: addrStr
  };
}

function mapEncounter(r) {
  const typeDisplay = r.class?.display || r.class?.code
    || r.type?.[0]?.coding?.[0]?.display || r.type?.[0]?.text || null;
  const attending = r.participant?.find(p =>
    p.type?.[0]?.coding?.[0]?.code === "ATND" || p.type?.[0]?.coding?.[0]?.code === "PART"
  );
  const loc = r.location?.[0]?.location?.display || r.serviceProvider?.display || null;
  return {
    id: r.id || null,
    type: typeDisplay,
    start: r.period?.start || r.actualPeriod?.start || null,
    end: r.period?.end || r.actualPeriod?.end || null,
    ward: loc,
    practitioner: attending?.individual?.display || null
  };
}

function resolveMedConcept(r) {
  // FHIR R4 vs R4B field name differences
  const concept = r.medicationCodeableConcept
    || r.medication?.concept
    || r.medication?.reference;  // ref → on ne peut pas résoudre sans bundle context
  if (!concept) return { name: null, code: null };
  if (typeof concept === "string") return { name: concept, code: null }; // reference URL
  return {
    name: concept.text || concept.coding?.[0]?.display || null,
    code: concept.coding?.[0]?.code || null
  };
}

function mapMedication(r) {
  const { name, code } = resolveMedConcept(r);
  if (!name && !code) return null;

  const dosage = r.dosageInstruction?.[0] || r.dosage?.[0] || {};
  const doseQty = dosage.doseAndRate?.[0]?.doseQuantity;
  const timing = dosage.timing?.repeat;

  let frequency = null;
  if (timing?.frequency && timing?.period && timing?.periodUnit) {
    frequency = `${timing.frequency}x/${timing.period}${timing.periodUnit}`;
  } else if (dosage.text) {
    frequency = dosage.text;
  }

  return {
    name,
    code,
    dose: doseQty ? `${doseQty.value} ${doseQty.unit || ""}`.trim() : null,
    route: dosage.route?.coding?.[0]?.display || dosage.route?.text || null,
    frequency,
    start: r.effectivePeriod?.start || r.effectiveDateTime || r.authoredOn || r.dateAsserted || null,
    end: r.effectivePeriod?.end || null,
    status: r.status || "active"
  };
}

function mapCondition(r) {
  const coding = r.code?.coding?.[0] || {};
  if (!coding.code && !r.code?.text) return null;
  return {
    code: coding.code || null,
    display: coding.display || r.code?.text || null,
    type: r.category?.[0]?.coding?.[0]?.code || "diagnosis",
    date: r.recordedDate || r.onsetDateTime || r.onsetPeriod?.start || null
  };
}

function mapAllergy(r) {
  const coding = r.code?.coding?.[0] || {};
  const substance = coding.display || r.code?.text || null;
  if (!substance) return null;
  const reaction = r.reaction?.[0];
  const manifestation = reaction?.manifestation?.[0]?.coding?.[0]
    || reaction?.manifestation?.[0]?.concept?.coding?.[0];
  return {
    type: r.type || "allergy",
    substance,
    reaction: manifestation?.display || reaction?.description || null,
    severity: reaction?.severity || r.criticality || null
  };
}

// --- Extraction Bundle ---

function extractBundle(bundle) {
  const resources = (bundle.entry || []).map(e => e.resource).filter(Boolean);

  const pat = resources.find(r => r.resourceType === "Patient");
  const encounters = resources.filter(r => r.resourceType === "Encounter").map(mapEncounter);
  const medications = resources
    .filter(r => ["MedicationRequest", "MedicationStatement", "MedicationAdministration"].includes(r.resourceType))
    .map(mapMedication).filter(Boolean);
  const diagnoses = resources.filter(r => r.resourceType === "Condition").map(mapCondition).filter(Boolean);
  const alerts = resources.filter(r => r.resourceType === "AllergyIntolerance").map(mapAllergy).filter(Boolean);
  const patient = pat ? mapPatient(pat) : null;

  return { patient, encounters, medications, diagnoses, alerts, timeline: buildTimeline({ encounters, medications, diagnoses, alerts }) };
}

// --- Entry point ---

export function extractFHIR(input, mode = "json") {
  let resource;
  try {
    if (mode === "xml") {
      const parsed = xmlParser.parse(typeof input === "string" ? input : input.toString());
      resource = Object.values(parsed).find(v => v && typeof v === "object");
    } else {
      resource = typeof input === "string" ? JSON.parse(input) : input;
    }
  } catch {
    return empty();
  }

  if (!resource) return empty();

  if (resource.resourceType === "Bundle") return extractBundle(resource);

  // Ressource isolée
  const ctx = empty();
  switch (resource.resourceType) {
    case "Patient":
      ctx.patient = mapPatient(resource); break;
    case "Encounter":
      ctx.encounters = [mapEncounter(resource)]; break;
    case "MedicationRequest":
    case "MedicationStatement":
    case "MedicationAdministration":
      ctx.medications = [mapMedication(resource)].filter(Boolean); break;
    case "Condition":
      ctx.diagnoses = [mapCondition(resource)].filter(Boolean); break;
    case "AllergyIntolerance":
      ctx.alerts = [mapAllergy(resource)].filter(Boolean); break;
    case "Composition":
      // Résumé sans les ressources complètes → on extrait ce qu'on peut du sujet
      ctx.patient = resource.subject ? { id: resource.subject.reference || null, family_name: null, given_name: null, birth_date: null, gender: null, nir: null, address: null } : null;
      break;
  }
  ctx.timeline = buildTimeline(ctx);
  return ctx;
}
