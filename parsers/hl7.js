/**
 * Extraction HL7 v2.x → contexte structuré
 * Segments supportés : MSH EVN PID PV1 DG1 OBX AL1 NTE ORC RXE RXO RXA ZBE ZFS ZPM
 * Identifiants FR : IPP, IEP, NIP, NIR (ASIP-SANTE)
 * Standard IHE France PAM (ZBE-4 : A=Admission M=Mutation S=Sortie T=Transfert)
 */

function parseRaw(raw) {
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .split("\n").map(l => l.trim()).filter(l => l.length >= 3);

  let F = "|", C = "^", R = "~", E = "\\", S = "&";
  const mshLine = lines.find(l => l.startsWith("MSH"));
  if (mshLine) {
    F = mshLine[3] || "|";
    C = mshLine[4] || "^";
    R = mshLine[5] || "~";
    E = mshLine[6] || "\\";
    S = mshLine[7] || "&";
  }

  const map = {};
  for (const line of lines) {
    const name = line.substring(0, 3);
    const fields = name === "MSH"
      ? ["MSH", F, ...line.substring(4).split(F)]
      : line.split(F);
    (map[name] = map[name] || []).push(fields);
  }
  return { map, F, C, R };
}

const get = (seg, i) => seg?.[i] ?? null;

function comp(val, i, sep = "^") {
  if (!val) return null;
  return val.split(sep)[i] ?? null;
}

function reps(val, sep = "~") {
  return val ? val.split(sep) : [];
}

function date(val) {
  if (!val) return null;
  const s = String(val).replace(/\D/g, "");
  if (s.length < 8) return null;
  const d = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (s.length >= 12) return `${d}T${s.slice(8, 10)}:${s.slice(10, 12)}:00`;
  return d;
}

const GENDER = { M: "male", F: "female", U: "unknown", O: "other" };
const VISIT_TYPE = { I: "inpatient", O: "outpatient", E: "emergency", R: "recurring", N: "newborn", P: "preadmit" };
const ALLERGY_TYPE = { DA: "drug", FA: "food", MA: "misc", EA: "environmental" };
const SEVERITY = { MI: "mild", MO: "moderate", SV: "severe" };
const ZBE_TYPE = { A: "admission", M: "transfer-in", S: "discharge", T: "transfer-out", N: "new-born", DC: "day-case" };

function parseIDs(raw, C, R) {
  return reps(raw, R).map(rep => {
    const p = rep.split(C);
    return { value: p[0] || null, facility: p[2] || null, domain: p[3] || null, type: p[4] || null };
  }).filter(i => i.value);
}

function practitioner(field, C) {
  if (!field) return null;
  const p = field.split(C);
  return [p[2], p[1], p[0]].filter(Boolean).join(" ") || null;
}

function buildTimeline(ctx) {
  const ev = [];
  for (const e of ctx.encounters || []) {
    if (e.start) ev.push({ date: e.start, type: "encounter", label: [e.type, e.ward].filter(Boolean).join(" — "), ref: e.id });
    if (e.end) ev.push({ date: e.end, type: "encounter_end", label: `Fin séjour ${e.ward || ""}`.trim(), ref: e.id });
  }
  for (const m of ctx.medications || []) {
    if (m.start) ev.push({ date: m.start, type: "medication_start", label: m.name || m.code, ref: m.code });
  }
  for (const d of ctx.diagnoses || []) {
    if (d.date) ev.push({ date: d.date, type: "diagnosis", label: [d.code, d.display].filter(Boolean).join(" "), ref: d.code });
  }
  return ev.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

export function extractHL7(raw) {
  const { map, C, R } = parseRaw(raw);

  // --- Patient (PID) ---
  const pid = map.PID?.[0];
  let patient = null;
  if (pid) {
    const ids = parseIDs(get(pid, 3), C, R);
    const ipp = ids.find(i => i.type === "IPP" || i.domain?.includes("IPP"))?.value
      || ids.find(i => i.type === "PI" || i.type === "MR")?.value
      || ids[0]?.value || null;
    const NIR_CODES = ["NIR", "SS", "NIP"];
    const nir = ids.find(i =>
      NIR_CODES.includes(i.type || "") || NIR_CODES.includes(i.domain || "")
      || NIR_CODES.includes(i.facility || "") || (i.domain || "").includes("ASIP")
    )?.value || null;

    const nameField = get(pid, 5) || "";
    const nm = nameField.split(C);
    const addr = (get(pid, 11) || "").split(C);

    patient = {
      id: ipp,
      family_name: nm[0] || null,
      given_name: nm[1] || null,
      birth_date: date(get(pid, 7)),
      gender: GENDER[get(pid, 8)] || get(pid, 8) || null,
      nir,
      address: [addr[0], addr[2], addr[4]].filter(Boolean).join(", ") || null
    };
  }

  // --- Encounters (PV1) ---
  const encounters = (map.PV1 || []).map(seg => {
    const loc = (get(seg, 3) || "").split(C);
    const iep = parseIDs(get(seg, 19) || get(seg, 5) || "", C, R)[0]?.value || null;
    return {
      id: iep,
      type: VISIT_TYPE[get(seg, 2)] || get(seg, 2) || null,
      start: date(get(seg, 44)),
      end: date(get(seg, 45)),
      ward: loc[2] || loc[1] || loc[0] || null,
      practitioner: practitioner(get(seg, 7), C) || practitioner(get(seg, 8), C)
    };
  }).filter(e => e.id || e.start || e.type);

  // IHE France PAM — mouvements ZBE (plus précis que PV1 pour les hôpitaux FR)
  for (const seg of map.ZBE || []) {
    const mvtType = ZBE_TYPE[get(seg, 4)] || get(seg, 4);
    const start = date(get(seg, 2));
    const end = date(get(seg, 3));
    const ward = (get(seg, 9) || "").split(C)[2] || null;
    const id = (get(seg, 1) || "").split(C)[0] || null;
    if (mvtType || start) {
      encounters.push({ id, type: mvtType, start, end, ward, practitioner: null, source: "ZBE" });
    }
  }

  // --- Diagnoses (DG1) ---
  const diagnoses = (map.DG1 || []).map(seg => {
    const cf = (get(seg, 3) || "").split(C);
    return {
      code: cf[0] || null,
      display: cf[1] || get(seg, 4) || null,
      type: get(seg, 6) === "A" ? "principal" : get(seg, 6) === "B" ? "associated" : "diagnosis",
      date: date(get(seg, 5))
    };
  }).filter(d => d.code);

  // --- Medications (RXE, RXO, RXA par ordre de préférence) ---
  const medications = [];
  const seen = new Set();
  for (const [name, doseFld, medFld, routeFld, unitFld] of [
    ["RXE", 3, 2, 6, 4],
    ["RXO", 2, 1, 9, 3],
    ["RXA", 6, 5, 12, 7]
  ]) {
    for (const seg of map[name] || []) {
      const medField = get(seg, medFld) || "";
      const mc = medField.split(C);
      const medCode = mc[0], medName = mc[1] || mc[0];
      if (!medCode || seen.has(medCode)) continue;
      seen.add(medCode);
      const dose = get(seg, doseFld);
      const unit = get(seg, unitFld);
      const route = (get(seg, routeFld) || "").split(C)[1] || (get(seg, routeFld) || "").split(C)[0] || null;
      medications.push({
        name: medName,
        code: medCode,
        dose: dose ? `${dose}${unit ? " " + unit : ""}`.trim() : null,
        route,
        frequency: name !== "RXA" ? comp(get(seg, name === "RXE" ? 5 : name === "RXO" ? 6 : null), 0, C) : null,
        start: date(name === "RXA" ? get(seg, 3) : null),
        end: null,
        status: "active"
      });
    }
  }

  // --- Alerts / Allergies (AL1) ---
  const alerts = (map.AL1 || []).map(seg => {
    const sf = (get(seg, 3) || "").split(C);
    return {
      type: ALLERGY_TYPE[get(seg, 2)] || "allergy",
      substance: sf[1] || sf[0] || null,
      reaction: get(seg, 5) || null,
      severity: SEVERITY[get(seg, 4)] || null
    };
  }).filter(a => a.substance);

  return { patient, encounters, medications, diagnoses, alerts, timeline: buildTimeline({ encounters, medications, diagnoses, alerts }) };
}
