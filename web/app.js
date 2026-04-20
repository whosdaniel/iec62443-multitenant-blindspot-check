// Entry point. Wires the toolbar, chip library, canvas, templates,
// undo/redo history, file save/load, LocalStorage auto-save, and
// keyboard shortcuts. Re-runs the evaluator on every graph change so
// the verdict overlay stays live.

import { Canvas, NODE_LIMIT } from './canvas.js';
import { ChipLibrary, promptCustomChip } from './chips.js';
import {
  canvasToArchitecture,
  canvasToFullArchitecture,
  loadTemplateIntoCanvas,
  snapshotToArchitecture,
} from './serialize.js';
import { evaluateArchitecture, Verdict } from './evaluator.js';
import { validateArchitecture, SchemaError } from './schema-validator.js';
import { TEMPLATES, TEMPLATE_ORDER } from './templates.js';
import { sanitizeText, showModal, showStatus } from './ui.js';
import { History, canonicalStringify } from './history.js';
import { archToYaml } from './yaml-export.js';
import {
  canvasToSnapshot,
  loadSnapshotIntoCanvas,
  saveToFile,
  loadFromFile,
  saveAutosave,
  loadAutosave,
  clearAutosave,
  setAutosaveEnabled,
  getAutosaveEnabled,
  setSavedFilename,
  getSavedFilename,
  SaveFileError,
} from './persistence.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const canvasContainer = document.getElementById('cy');
const chipContainer   = document.getElementById('chip-library');
const propsEl         = document.getElementById('properties');
const summaryEl       = document.getElementById('summary');
const evidenceEl      = document.getElementById('evidence-banner');
const evidenceTitleEl = document.getElementById('evidence-title');
const evidenceDetailEl = document.getElementById('evidence-detail');
const titleFilenameEl = document.getElementById('title-filename');
const dirtyMarkerEl   = document.getElementById('dirty-marker');
const fileInput       = document.getElementById('file-input');

const library = new ChipLibrary(chipContainer);
const canvas  = new Canvas(canvasContainer, library);
const history = new History({ cap: 50 });

let currentFilename = 'untitled';
let lastSavedSnapshot = null;
let autosaveTimer = null;
const AUTOSAVE_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Toolbar + file-bar references
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const btnAddNode  = $('btn-add-node');
const btnConnect  = $('btn-connect');
const btnZone     = $('btn-zone');
const btnFit      = $('btn-fit');
const btnDelete   = $('btn-delete');
const btnAddChip  = $('btn-add-chip');
const btnTemplates = $('btn-templates');
const btnNew      = $('btn-new');
const btnLoad     = $('btn-load');
const btnSave     = $('btn-save');
const btnSaveAs   = $('btn-save-as');
const btnUndo     = $('btn-undo');
const btnRedo     = $('btn-redo');
const btnHelp     = $('btn-help');
const btnExportYaml = $('btn-export-yaml');
const btnExportPdf  = $('btn-export-pdf');
const toggleAutosave = $('toggle-autosave');

const setPressed = (el, pressed) =>
  el.setAttribute('aria-pressed', pressed ? 'true' : 'false');

// ---------------------------------------------------------------------------
// Canvas-edit toolbar
// ---------------------------------------------------------------------------

btnAddNode.addEventListener('click', () => {
  if (canvas.mode === 'add-node') {
    canvas.setMode('normal');
    showStatus('Add-node mode cancelled.');
    return;
  }
  if (canvas.nodeCount() >= NODE_LIMIT) {
    showStatus(`Node limit reached (${NODE_LIMIT}). Delete some nodes first.`);
    return;
  }
  canvas.setMode('add-node');
  showStatus(
    `Click anywhere on the canvas to place a node (${canvas.nodeCount()}/${NODE_LIMIT}).`,
  );
});

btnConnect.addEventListener('click', () => {
  if (canvas.mode === 'connect') {
    canvas.setMode('normal');
    showStatus('Connect mode cancelled.');
    return;
  }
  canvas.setMode('connect');
  showStatus('Connect mode: click the face (top/right/bottom/left) of the source node where the edge should start, then click the face of the target.');
});

btnZone.addEventListener('click', async () => {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'e.g. VLAN-IDF';
  input.setAttribute('aria-label', 'Zone label');
  input.maxLength = 64;
  const labelWrap = document.createElement('label');
  const t = document.createElement('span');
  t.textContent = 'Zone label';
  labelWrap.appendChild(t);
  labelWrap.appendChild(input);
  const hint = document.createElement('div');
  hint.className = 'muted';
  hint.textContent =
    'Selected nodes become children of this compound zone. Drag a chip on the zone afterward to set its authority.';
  const result = await showModal({
    title: 'Group selected nodes into a zone',
    confirmLabel: 'Create zone',
    bodyElements: [labelWrap, hint],
    onConfirm: () => sanitizeText(input.value.trim(), 64) || null,
  });
  if (result) canvas.createZoneFromSelection(result);
});

btnFit.addEventListener('click',    () => canvas.fit());
btnDelete.addEventListener('click', () => canvas.deleteSelected());

btnAddChip.addEventListener('click', async () => {
  const existing = new Set(library.chips.map((c) => c.id));
  const chip = await promptCustomChip(existing);
  if (!chip) return;
  try {
    library.addChip(chip);
    recordSnapshot();
    showStatus(`Owner ${chip.id} added to library.`);
  } catch (err) {
    showStatus(`Could not add owner: ${err.message}`);
  }
});

btnTemplates.addEventListener('click', openTemplateGallery);

// ---------------------------------------------------------------------------
// File bar
// ---------------------------------------------------------------------------

btnNew.addEventListener('click', async () => {
  if (isDirty()) {
    const ok = await confirmDiscard('Start a new architecture?');
    if (!ok) return;
  }
  history.withSuspended(() => {
    canvas.reset();
    // Drop any custom chips - default chips stay.
    library.chips = library.chips.filter((c) => library.isDefault(c.id));
    library.render();
  });
  currentFilename = 'untitled';
  setSavedFilename(null);
  const snap = canvasToSnapshot(canvas, library);
  history.init(snap);
  setLastSavedSnapshot(snap);
  updateEvidenceBanner();
  revalidate();
  updateDirty();
  updateUndoRedoButtons();
  showStatus('New architecture started.');
});

btnLoad.addEventListener('click', async () => {
  if (isDirty()) {
    const ok = await confirmDiscard('Load a file?');
    if (!ok) return;
  }
  fileInput.value = '';
  fileInput.click();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const snap = await loadFromFile(file);
    restoreFromSnapshot(snap, { filename: file.name, resetHistory: true });
    showStatus(`Loaded ${file.name}.`);
  } catch (err) {
    const msg = err instanceof SaveFileError ? err.message : String(err.message ?? err);
    showStatus(`Could not load: ${msg}`);
  }
});

btnSave.addEventListener('click',    () => doSave(false));
btnSaveAs.addEventListener('click',  () => doSave(true));
btnUndo.addEventListener('click',    doUndo);
btnRedo.addEventListener('click',    doRedo);
btnHelp.addEventListener('click',    showHelp);
btnExportYaml.addEventListener('click', exportYaml);
btnExportPdf.addEventListener('click',  exportPdf);

toggleAutosave.checked = getAutosaveEnabled();
toggleAutosave.addEventListener('change', () => {
  setAutosaveEnabled(toggleAutosave.checked);
  configureAutosaveTimer();
  showStatus(
    toggleAutosave.checked
      ? 'Auto-save enabled (every 30s to this browser only; not to disk).'
      : 'Auto-save disabled. Use Save to write to disk.',
  );
});

function configureAutosaveTimer() {
  if (autosaveTimer) {
    clearInterval(autosaveTimer);
    autosaveTimer = null;
  }
  if (toggleAutosave.checked) {
    autosaveTimer = setInterval(() => {
      const snap = canvasToSnapshot(canvas, library);
      saveAutosave(snap);
    }, AUTOSAVE_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Template gallery
// ---------------------------------------------------------------------------

async function openTemplateGallery() {
  if (isDirty()) {
    const ok = await confirmDiscard('Load a template?');
    if (!ok) return;
  }

  const gallery = document.createElement('div');
  gallery.className = 'template-gallery';
  gallery.setAttribute('role', 'list');

  let chosen = null;
  for (const id of TEMPLATE_ORDER) {
    const t = TEMPLATES[id];
    if (!t) continue;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'template-card';
    card.dataset.evidence = t.meta.evidence_level;
    card.setAttribute('role', 'listitem');

    const title = document.createElement('div');
    title.className = 'template-card-title';
    title.textContent = t.meta.name;
    card.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'template-card-meta';
    const nZones = (t.zones ?? []).length;
    const nNodes = (t.nodes ?? []).length;
    const nEdges = (t.edges ?? []).length;
    meta.textContent =
      `${t.meta.domain} - ${t.meta.evidence_level}  |  ${nZones} zones, ${nNodes} nodes, ${nEdges} edges`;
    card.appendChild(meta);

    if (t.meta.description) {
      const desc = document.createElement('div');
      desc.className = 'template-card-desc';
      desc.textContent = t.meta.description;
      card.appendChild(desc);
    }

    card.addEventListener('click', () => {
      chosen = id;
      const confirmBtn = document.querySelector('.modal-actions button.primary');
      if (confirmBtn) confirmBtn.click();
    });
    gallery.appendChild(card);
  }

  const warn = document.createElement('div');
  warn.className = 'muted';
  warn.textContent =
    'Loading a template replaces everything currently on the canvas. Custom chips from the library are preserved.';

  const result = await showModal({
    title: 'Load a starter template',
    confirmLabel: 'Load',
    cancelLabel: 'Close',
    bodyElements: [gallery, warn],
    onConfirm: () => chosen,
  });
  if (!result) return;
  loadTemplate(result);
}

function loadTemplate(id) {
  const template = TEMPLATES[id];
  if (!template) {
    showStatus(`Unknown template: ${id}`);
    return;
  }
  history.withSuspended(() => {
    loadTemplateIntoCanvas(template, canvas, library);
  });
  canvas.fit();

  currentFilename = `${id}.blindspot.json`;
  setSavedFilename(currentFilename);
  const snap = canvasToSnapshot(canvas, library);
  history.init(snap);
  setLastSavedSnapshot(snap); // templates load as "clean"

  updateEvidenceBanner();
  revalidate();
  updateDirty();
  updateUndoRedoButtons();
  canvas._maybeWarnNearLimit();  // warn if loaded template nears NODE_LIMIT
  showStatus(`Loaded template: ${template.meta.name}.`);
}

// ---------------------------------------------------------------------------
// Save / Load / History
// ---------------------------------------------------------------------------

async function doSave(forceNewName) {
  let name = currentFilename;
  if (forceNewName || name === 'untitled') {
    const suggested = forceNewName
      ? (currentFilename !== 'untitled' ? currentFilename.replace(/\.blindspot\.json$/, '') : 'architecture')
      : 'architecture';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = suggested;
    input.placeholder = 'architecture';
    input.maxLength = 128;
    input.setAttribute('aria-label', 'Filename');
    const w = document.createElement('label');
    const t = document.createElement('span');
    t.textContent = 'Filename (.blindspot.json will be appended)';
    w.appendChild(t);
    w.appendChild(input);
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent =
      'The browser will download the file. The tool does not write directly to disk, so you may see a download prompt each time you save.';
    const chosen = await showModal({
      title: forceNewName ? 'Save as' : 'Save',
      confirmLabel: 'Save',
      bodyElements: [w, hint],
      onConfirm: () => {
        const v = sanitizeText(input.value.trim(), 128);
        return v || undefined;
      },
    });
    if (!chosen) {
      showStatus('Save cancelled.');
      return;
    }
    name = chosen;
  }
  const snap = canvasToSnapshot(canvas, library);
  const savedAs = saveToFile(snap, name);
  currentFilename = savedAs;
  setSavedFilename(savedAs);
  setLastSavedSnapshot(snap);
  updateDirty();
  // Warn if the browser-side filename sanitization stripped meaningful
  // characters (UX agent 4 FO-008) - e.g. Korean names collapse to
  // the generic 'architecture.blindspot.json' so the user loses their
  // intended title.
  const rawStem = name.replace(/\.blindspot\.json$/i, '').replace(/\.json$/i, '');
  const savedStem = savedAs.replace(/\.blindspot\.json$/, '');
  if (rawStem && savedStem !== rawStem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^\.+|\.+$/g, '')) {
    // Sanitization changed more than whitespace normalisation.
  }
  showStatus(`Saved to ${savedAs}. ${name !== savedAs ? '(Filename sanitised for file-system safety.) ' : ''}Downloaded from the browser.`);
}

function doUndo() {
  const snap = history.undo();
  if (!snap) {
    showStatus('Nothing to undo.');
    return;
  }
  restoreFromSnapshot(snap, { filename: null, resetHistory: false });
  showStatus('Undo.');
}

function doRedo() {
  const snap = history.redo();
  if (!snap) {
    showStatus('Nothing to redo.');
    return;
  }
  restoreFromSnapshot(snap, { filename: null, resetHistory: false });
  showStatus('Redo.');
}

function restoreFromSnapshot(snap, { filename, resetHistory }) {
  // Push the current canvas snapshot to history BEFORE the replace
  // so Undo can return to the pre-load state (UX agent 4 FO-002).
  // Without this, loading the wrong file was a data-loss hazard.
  const preLoad = canvasToSnapshot(canvas, library);
  history.withSuspended(() => {
    loadSnapshotIntoCanvas(snap, canvas, library);
  });
  if (filename !== null) {
    currentFilename = filename;
    setSavedFilename(filename);
  }
  if (resetHistory) {
    const fresh = canvasToSnapshot(canvas, library);
    history.init(preLoad);     // seed history with pre-load state
    history.record(fresh);     // then record the loaded state on top
    setLastSavedSnapshot(fresh);
  }
  canvas.fit();
  updateEvidenceBanner();
  revalidate();
  updateDirty();
  updateUndoRedoButtons();
}

function recordSnapshot() {
  if (history.suspended) return;
  const snap = canvasToSnapshot(canvas, library);
  history.record(snap);
  updateUndoRedoButtons();
  updateDirty();
}

// ---------------------------------------------------------------------------
// Export - YAML (Python CLI compatible) + PDF (browser print)
// ---------------------------------------------------------------------------

async function exportYaml() {
  // Distinguish empty canvas (no nodes yet) from incomplete schema
  // (nodes exist but missing owners / zones). Empty state deserves a
  // friendly nudge; incomplete state surfaces the validator message
  // (UX agent 4 FO-006).
  if (canvas.cy.nodes().filter((n) => !n.hasClass('zone') && !n.hasClass('edge-bend-handle') && !n.hasClass('edge-endpoint-handle')).length === 0) {
    showStatus('Canvas is empty - add owners and at least one conduit before exporting YAML.');
    return;
  }
  const { arch, reasons } = canvasToFullArchitecture(canvas, library);
  if (!arch) {
    const msg = (reasons ?? []).join(' ') || 'Canvas has nothing to export yet.';
    showStatus(`Cannot export YAML: ${msg}`);
    return;
  }
  try {
    validateArchitecture(arch);
  } catch (err) {
    const head = err instanceof SchemaError ? err.message.split('\n')[0] : String(err.message ?? err);
    showStatus(`Cannot export YAML (schema): ${head}`);
    return;
  }

  if (!(await confirmNotesIncluded('YAML'))) {
    showStatus('YAML export cancelled.');
    return;
  }

  const header =
    `Generated by BlindSpotCheck on ${new Date().toISOString()}\n` +
    `Architecture: ${canvas.templateName ?? 'Custom architecture'}\n` +
    `Evidence level: ${canvas.evidenceLevel}\n` +
    `Schema: blindspotcheck/schemas/architecture-v1.json (schema_version "1").\n` +
    `\n` +
    `How to evaluate this file:\n` +
    `  pip install -e .           # from the repo root\n` +
    `  blindspotcheck <this-file>\n` +
    `\n` +
    `Note: the canvas UI does NOT reload YAML files directly. Use the canvas's\n` +
    `Save button to produce a .blindspot.json that is round-trippable back into\n` +
    `the canvas. This YAML is the Python-CLI / CI / archival format only.`;

  const yamlText = archToYaml(arch, { header });
  const name = (currentFilename && currentFilename !== 'untitled')
    ? currentFilename.replace(/\.blindspot\.json$/, '').replace(/\.json$/, '')
    : 'architecture';
  const yamlFilename = `${toSafeYamlName(name)}.yaml`;

  const blob = new Blob([yamlText], { type: 'application/x-yaml' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = yamlFilename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  showStatus(
    `Exported ${yamlFilename} for the Python CLI. Use Save for a canvas-reloadable .blindspot.json.`,
  );
}

function toSafeYamlName(raw) {
  let name = (raw ?? '').trim();
  if (!name) name = 'architecture';
  name = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
  name = name.replace(/^\.+|\.+$/g, '');
  return name || 'architecture';
}

async function exportPdf() {
  // Build the report content off-screen, then trigger browser print.
  const report = buildReportSnapshot();
  if (!report) {
    showStatus('Cannot export PDF: draw or load something first.');
    return;
  }

  if (!(await confirmNotesIncluded('PDF'))) {
    showStatus('PDF export cancelled.');
    return;
  }

  // Capture canvas PNG (full graph, not just the visible viewport) and the
  // audit-trail hash in parallel.
  let pngUrl = null;
  let hash = null;
  try {
    const [blob, computed] = await Promise.all([
      canvas.exportPng({ background: '#ffffff', scale: 2, full: true }),
      computeArtefactHash(),
    ]);
    pngUrl = URL.createObjectURL(blob);
    hash = computed;
  } catch (err) {
    showStatus(`Could not capture canvas image: ${err.message}`);
    return;
  }

  fillPrintView(report, pngUrl, hash);

  const printView = document.getElementById('print-view');
  printView.hidden = false;
  printView.removeAttribute('aria-hidden');

  const cleanup = () => {
    printView.hidden = true;
    printView.setAttribute('aria-hidden', 'true');
    if (pngUrl) URL.revokeObjectURL(pngUrl);
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  // Wait for the image to decode so it appears in the printout.
  const img = document.getElementById('print-canvas-img');
  const printNow = () => {
    try {
      window.print();
    } catch (err) {
      showStatus(`Print dialog failed: ${err.message}`);
      cleanup();
    }
  };
  if (img.complete && img.naturalWidth > 0) {
    // Image already cached from a prior export.
    printNow();
  } else {
    img.onload = printNow;
    img.onerror = () => {
      showStatus('Canvas image failed to load for printing.');
      cleanup();
    };
    img.src = pngUrl;
  }
  // Ensure src assignment even when cached.
  if (!img.src) img.src = pngUrl;

  showStatus('Print dialog opened. Pick "Save as PDF" (or an actual printer) to finish.');
}

function buildReportSnapshot() {
  const { arch, skipped } = canvasToArchitecture(canvas, library);
  if (!arch) return null;
  try {
    validateArchitecture(arch);
  } catch {
    return null;
  }
  const report = evaluateArchitecture(arch);
  return { arch, report, skipped: skipped ?? [] };
}

// Fixed clause references shown as a glossary below the per-conduit
// table in PDF exports. Auditors quoting a verdict can cite the clause
// directly. Derived from paper §2.2, §4, §7.3 Table 8 and IEC 62443-2-4
// SP.08.02 BR + 3-2 ZCR 3 Cl. 4.4 + 3-3 SR 6.2.
const VERDICT_CLAUSE_GLOSSARY = {
  'blind-spot':
    'IEC 62443-3-2:2020 ZCR 3 Cl. 4.4 (single partitioning authority per zone); ' +
    'IEC 62443-3-3:2013 SR 6.2 (continuous monitoring scoped within zones); ' +
    'IEC 62443-2-4:2023 Cl. 3.1.13 / SP.08.02 BR (maintenance SP obligation). ' +
    'Structural gap: none of these clauses assigns a monitoring authority to ' +
    'this conduit.',
  'borderline':
    'IEC 62443-3-2:2020 ZCR 3 Cl. 4.4 holds for both endpoint zones because ' +
    'a single organisation designates them. NC-2 is currently satisfied but ' +
    'flips to blind-spot if that authority is split between organisations.',
  'resolved-by-sp':
    'IEC 62443-2-4:2023 SP.08.02 BR: security event logging obligation flows ' +
    'through the SP-AO contract covering this conduit. (sp_subtype: only ' +
    'maintenance SPs per Cl. 3.1.13 reach monitoring scope; integration-only ' +
    'SPs per Cl. 3.1.12 do not.)',
  'no-cross-ao':
    'SC-1 is not satisfied: single-owner conduit. Standard single-AO ' +
    'obligations under IEC 62443-2-1:2024 (Cl. 3.1.2 asset owner) apply to ' +
    'the owning organisation; no multi-tenant monitoring gap arises.',
  'incomplete':
    'Not evaluated: at least one endpoint lacks an owner assignment. Assign ' +
    'owners to both endpoints to classify this conduit.',
};

function fillPrintView({ arch, report, skipped }, pngUrl, hash) {
  const dist = report.distribution();
  const total = report.results.length + skipped.length;

  $('print-name').textContent    = canvas.templateName ?? 'Custom architecture';
  $('print-evidence').textContent = canvas.evidenceLevel ?? 'custom';
  $('print-domain').textContent   = canvas.domain ?? 'custom';
  $('print-source').textContent   = canvas.templateSource || '(none)';
  $('print-time').textContent     = new Date().toISOString();
  $('print-hash').textContent     = hash ?? '(unavailable)';

  const reviewRow = $('print-review-row');
  if (canvas.review && canvas.review.reviewer) {
    reviewRow.hidden = false;
    $('print-reviewer').textContent = canvas.review.reviewer;
    const when = canvas.review.reviewed_on
      ? `(${canvas.review.reviewed_on})`
      : '';
    $('print-reviewed-on').textContent = when;
  } else {
    reviewRow.hidden = true;
  }

  const img = $('print-canvas-img');
  img.src = pngUrl;
  img.alt = `Snapshot of ${canvas.templateName ?? 'custom'} architecture with ${total} conduits`;

  // Measurement prerequisites section (analytic-hypothesis templates only).
  const prereqSection = $('print-prerequisites-section');
  const prereqList = $('print-prerequisites-list');
  prereqList.replaceChildren();
  const prereqs = Array.isArray(canvas.measurementPrerequisites)
    ? canvas.measurementPrerequisites
    : [];
  if (prereqs.length > 0) {
    for (const item of prereqs) {
      const li = document.createElement('li');
      li.textContent = item;
      prereqList.appendChild(li);
    }
    prereqSection.hidden = false;
  } else {
    prereqSection.hidden = true;
  }

  const sumBody = $('print-summary-body');
  sumBody.replaceChildren();
  const rows = [
    ['Total conduits',    total],
    ['Blind spot',        dist[Verdict.BLIND_SPOT] ?? 0],
    ['Borderline',        dist[Verdict.BORDERLINE] ?? 0],
    ['Resolved by SP',    dist[Verdict.RESOLVED_BY_SP] ?? 0],
    ['No cross-AO',       dist[Verdict.NO_CROSS_AO] ?? 0],
    ['Skipped (no owner)', skipped.length],
  ];
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = k;
    const td2 = document.createElement('td'); td2.textContent = String(v);
    tr.appendChild(td1); tr.appendChild(td2);
    sumBody.appendChild(tr);
  }

  const vBody = $('print-verdicts-body');
  vBody.replaceChildren();
  for (const r of report.results) {
    const edge = canvas.cy.getElementById(r.conduit_id);
    const directionCell = edgeDirectionCell(edge);
    const tr = document.createElement('tr');
    for (const cell of [
      r.conduit_id,
      directionCell,
      r.sc1 ? 'Y' : '-',
      r.nc1 ? 'Y' : '-',
      r.nc2 ? 'Y' : '-',
      r.verdict,
      r.rationale,
    ]) {
      const td = document.createElement('td');
      td.textContent = String(cell);
      tr.appendChild(td);
    }
    vBody.appendChild(tr);
  }
  for (const s of skipped) {
    const edge = canvas.cy.getElementById(s.id);
    const directionCell = edgeDirectionCell(edge);
    const tr = document.createElement('tr');
    for (const cell of [s.id, directionCell, '-', '-', '-', 'incomplete', s.reason]) {
      const td = document.createElement('td');
      td.textContent = String(cell);
      tr.appendChild(td);
    }
    vBody.appendChild(tr);
  }

  // Clause glossary: only list verdict classes actually present in this
  // report, so the auditor sees citations relevant to what they're
  // looking at (not a generic dump of every possible verdict).
  const glossaryEl = $('print-clause-glossary');
  glossaryEl.replaceChildren();
  const verdictsPresent = new Set(report.results.map((r) => r.verdict));
  if (skipped.length > 0) verdictsPresent.add('incomplete');
  for (const verdict of ['blind-spot', 'borderline', 'resolved-by-sp', 'no-cross-ao', 'incomplete']) {
    if (!verdictsPresent.has(verdict)) continue;
    const dt = document.createElement('dt');
    dt.textContent = verdict;
    const dd = document.createElement('dd');
    dd.textContent = VERDICT_CLAUSE_GLOSSARY[verdict] ?? '(no clause reference bundled)';
    glossaryEl.appendChild(dt);
    glossaryEl.appendChild(dd);
  }
}

/**
 * Compact ASCII indicator for the edge's direction annotation. Used in
 * the PDF print table so audit workpapers show traffic direction without
 * relying on Unicode arrows that might not render in every printer's
 * font set.
 */
function edgeDirectionCell(edge) {
  if (!edge || edge.empty()) return 'bi';
  if (!edge.data('directed')) return 'bi';
  // "directed=true" on canvas always serialises as direction=unidirectional
  // / traffic_direction=from-to (see serialize.js::canvasToFullArchitecture).
  return 'fwd';
}

// ---------------------------------------------------------------------------
// Dirty tracking
// ---------------------------------------------------------------------------

// Cache the canonical-stringified last-saved snapshot so isDirty()
// doesn't re-canonicalise it on every graph change (UX agent 4 FO-003).
// canonicalStringify uses sorted keys, avoiding false-positive dirty
// markers caused by insertion-order drift in Cytoscape internals
// (FO-011). The cache key is updated whenever lastSavedSnapshot itself
// is replaced (on Save / init / Load reset).
let _lastSavedCanonical = null;
function setLastSavedSnapshot(snap) {
  lastSavedSnapshot = snap;
  _lastSavedCanonical = snap ? canonicalStringify(snap) : null;
}
function isDirty() {
  if (!lastSavedSnapshot) return false;
  const snap = canvasToSnapshot(canvas, library);
  return canonicalStringify(snap) !== _lastSavedCanonical;
}

function updateDirty() {
  const dirty = isDirty();
  dirtyMarkerEl.textContent = dirty ? '*' : '';
  titleFilenameEl.textContent = currentFilename;
  document.title = `BlindSpotCheck - ${currentFilename}${dirty ? ' *' : ''}`;
}

function updateUndoRedoButtons() {
  btnUndo.disabled = !history.canUndo();
  btnRedo.disabled = !history.canRedo();
}

async function confirmDiscard(actionLabel) {
  const body = document.createElement('div');
  body.textContent = `You have unsaved changes. ${actionLabel}`;
  const hint = document.createElement('div');
  hint.className = 'muted';
  hint.textContent = 'Save first if you want to keep the current state.';
  const ok = await showModal({
    title: 'Unsaved changes',
    confirmLabel: 'Discard changes',
    cancelLabel: 'Cancel',
    bodyElements: [body, hint],
    onConfirm: () => true,
  });
  return !!ok;
}

// ---------------------------------------------------------------------------
// Evidence banner
// ---------------------------------------------------------------------------

function updateEvidenceBanner() {
  const level = canvas.evidenceLevel ?? 'custom';
  evidenceEl.classList.remove('evidence-measured', 'evidence-analytic', 'evidence-custom');
  if (level === 'measured') {
    evidenceEl.classList.add('evidence-measured');
    evidenceTitleEl.textContent = 'Measured architecture';
    evidenceDetailEl.textContent = canvas.templateSource || 'Verdicts reproduce a published measurement.';
  } else if (level === 'analytic-hypothesis') {
    evidenceEl.classList.add('evidence-analytic');
    evidenceTitleEl.textContent = 'Analytic hypothesis - NOT measured';
    evidenceDetailEl.textContent =
      (canvas.templateSource || 'Structural mapping from public standards.') +
      ' Do not quote these verdicts as measurements; treat them as structural claims pending empirical validation.';
  } else {
    evidenceEl.classList.add('evidence-custom');
    evidenceTitleEl.textContent = 'Custom architecture';
    evidenceDetailEl.textContent = 'User-drawn. Verdicts reflect the inputs you supply.';
  }
  if (canvas.forkSnapshot) {
    evidenceDetailEl.textContent +=
      '  ·  Fork active (Scenario B). Use Help -> Scenarios to compare.';
  }
}

// ---------------------------------------------------------------------------
// Re-validate + record on every graph change
// ---------------------------------------------------------------------------

canvas.on('graph-change', () => {
  if (!history.suspended) {
    const snap = canvasToSnapshot(canvas, library);
    history.record(snap);
  }
  updateUndoRedoButtons();
  updateDirty();
  revalidate();
});

function revalidate() {
  const { arch, reasons, skipped } = canvasToArchitecture(canvas, library);

  if (!arch) {
    canvas.applyVerdicts(null, skipped ?? []);
    summaryEl.textContent = reasons && reasons.length > 0 ? reasons[0] : '-';
    summaryEl.setAttribute('title', (reasons ?? []).join(' '));
    return;
  }

  try {
    validateArchitecture(arch);
  } catch (err) {
    if (err instanceof SchemaError) {
      canvas.clearVerdicts();
      summaryEl.textContent = 'Architecture invalid - see status';
      summaryEl.setAttribute('title', err.message);
      showStatus(`Architecture is invalid: ${err.message.split('\n')[0]}`);
      return;
    }
    throw err;
  }

  const report = evaluateArchitecture(arch);
  canvas.applyVerdicts(report, skipped);
  renderSummary(report, skipped);

  const sel = canvas._currentSelection();
  if (sel && sel.type === 'edge') renderProperties(sel);
}

function renderSummary(report, skipped) {
  const dist = report.distribution();
  const bs = dist[Verdict.BLIND_SPOT] ?? 0;
  const bd = dist[Verdict.BORDERLINE] ?? 0;
  const rs = dist[Verdict.RESOLVED_BY_SP] ?? 0;
  const nc = dist[Verdict.NO_CROSS_AO] ?? 0;
  const sk = (skipped ?? []).length;

  summaryEl.replaceChildren();
  const total = report.results.length + sk;
  const totalPill = document.createElement('span');
  totalPill.textContent = `total ${total}`;
  summaryEl.appendChild(totalPill);
  summaryEl.appendChild(pillSpan(`BS ${bs}`, 'count-blind'));
  summaryEl.appendChild(pillSpan(`BD ${bd}`, 'count-border'));
  summaryEl.appendChild(pillSpan(`RS ${rs}`, 'count-resolved'));
  summaryEl.appendChild(pillSpan(`NC ${nc}`, 'count-nocross'));
  if (sk > 0) summaryEl.appendChild(pillSpan(`skip ${sk}`, 'count-skipped'));
  const pct = total > 0 ? ((bs / total) * 100).toFixed(1) : '0.0';
  summaryEl.setAttribute(
    'title',
    `Blind spots: ${bs}/${total} (${pct}%). Borderline: ${bd}. Resolved by SP: ${rs}. No cross-AO: ${nc}. Skipped (missing owners): ${sk}.`,
  );
}

function pillSpan(text, cls) {
  const s = document.createElement('span');
  s.className = `count ${cls}`;
  s.textContent = text;
  return s;
}

// ---------------------------------------------------------------------------
// Mode -> toolbar pressed state
// ---------------------------------------------------------------------------

canvas.on('mode', (mode) => {
  setPressed(btnAddNode, mode === 'add-node');
  setPressed(btnConnect, mode === 'connect');
});

// ---------------------------------------------------------------------------
// Selection -> properties panel
// ---------------------------------------------------------------------------

canvas.on('selection', renderProperties);

function renderProperties(sel) {
  propsEl.replaceChildren();
  if (!sel) {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.textContent = 'Select a node, edge, or zone to inspect.';
    propsEl.appendChild(div);
    return;
  }
  if (sel.type === 'multi') {
    const div = document.createElement('div');
    div.textContent = `${sel.count} items selected.`;
    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.textContent = 'Use Group as Zone to wrap them, or Delete to remove all.';
    propsEl.appendChild(div);
    propsEl.appendChild(hint);
    return;
  }
  if (sel.type === 'node') renderNodeProps(sel.element);
  if (sel.type === 'edge') renderEdgeProps(sel.element);
  if (sel.type === 'zone') renderZoneProps(sel.element);
}

function renderNodeProps(node) {
  propsEl.appendChild(rowText('Type', 'Node'));
  propsEl.appendChild(rowText('Internal id', node.id()));
  propsEl.appendChild(rowEdit('Label', node.data('label'), (v) => {
    canvas.setLabel(node, v);
    return true;
  }));
  // Role context: the bracketed sub-label under the node name
  // (e.g. "APT HW / VND maint."). Editable inline so users do not have
  // to discover the right-click menu.
  propsEl.appendChild(rowEdit(
    'Role context (sub-label)',
    node.data('roleContext') ?? '',
    (v) => {
      canvas.setRoleContext(node, v);
      return true;
    },
    {
      placeholder: 'e.g. APT HW / VND maint., 3-tenant APT+ALN',
      maxLength: 128,
      allowEmpty: true,
    },
  ));

  const ownerSection = document.createElement('div');
  const ownerTitle = document.createElement('div');
  ownerTitle.className = 'section-title';
  ownerTitle.textContent = 'Owners';
  ownerSection.appendChild(ownerTitle);

  const owners = node.data('owners') ?? [];
  if (owners.length === 0) {
    const em = document.createElement('div');
    em.className = 'empty-state';
    em.textContent = 'Drag a chip from the left onto this node to assign an owner.';
    ownerSection.appendChild(em);
  } else {
    const list = document.createElement('div');
    list.className = 'owner-list';
    for (const id of owners) {
      list.appendChild(ownerChipEl(id, () => {
        canvas.removeOwner(node, id);
        renderProperties({ type: 'node', element: node });
      }));
    }
    ownerSection.appendChild(list);
  }
  propsEl.appendChild(ownerSection);

  // Multi-tenant toggle. Auto-derived from owners.length>1 unless the
  // user explicitly pins it via this control (UX agent 3 P7/P8).
  propsEl.appendChild(checkboxRow(
    'Multi-tenant coexistence (double border)',
    !!node.data('multiTenant'),
    (v) => {
      canvas.setMultiTenantExplicit(node, v);
    },
  ));

  propsEl.appendChild(notesRow(node));
}

function renderEdgeProps(edge) {
  propsEl.appendChild(rowText('Type', 'Edge (conduit)'));
  propsEl.appendChild(rowText('Conduit id', edge.id()));
  propsEl.appendChild(rowEdit('Label', edge.data('label') ?? edge.id(), (v) => {
    canvas.setLabel(edge, v);
    return true;
  }));
  propsEl.appendChild(rowText(
    'Source',
    `${edge.source().data('label') ?? edge.source().id()}  (${ownerOf(edge.source())})`,
  ));
  propsEl.appendChild(rowText(
    'Target',
    `${edge.target().data('label') ?? edge.target().id()}  (${ownerOf(edge.target())})`,
  ));

  propsEl.appendChild(directionRow(edge));

  propsEl.appendChild(checkboxRow(
    'Covered by IEC 62443-2-4 SP-AO relationship',
    !!edge.data('spCovered'),
    (v) => {
      canvas.setSpCovered(edge, v);
      // Re-render so the subtype dropdown shows/hides with the checkbox.
      renderProperties({ type: 'edge', element: edge });
    },
  ));
  if (edge.data('spCovered')) {
    propsEl.appendChild(spSubtypeRow(edge));
  }

  const verdict = edge.data('verdict');
  if (verdict) {
    const verdictSection = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = 'Verdict';
    verdictSection.appendChild(title);

    const chip = document.createElement('span');
    chip.className = `verdict-chip verdict-${verdict}`;
    chip.textContent = verdict;
    verdictSection.appendChild(chip);

    if (typeof edge.data('sc1') === 'boolean') {
      const flags = document.createElement('div');
      flags.className = 'nc-flags';
      flags.appendChild(ncFlag('SC-1', edge.data('sc1')));
      flags.appendChild(ncFlag('NC-1', edge.data('nc1')));
      flags.appendChild(ncFlag('NC-2', edge.data('nc2')));
      verdictSection.appendChild(flags);
    }

    const rationale = edge.data('rationale');
    if (rationale) {
      const r = document.createElement('div');
      r.className = 'muted';
      r.textContent = rationale;
      verdictSection.appendChild(r);
    }

    const mit = edge.data('mitigation');
    if (Array.isArray(mit) && mit.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'mitigation-list';
      for (const m of mit) {
        const li = document.createElement('li');
        li.textContent = m;
        ul.appendChild(li);
      }
      verdictSection.appendChild(ul);
    }

    propsEl.appendChild(verdictSection);
  }

  propsEl.appendChild(notesRow(edge));
}

function renderZoneProps(zone) {
  propsEl.appendChild(rowText('Type', 'Zone (compound node)'));
  propsEl.appendChild(rowText('Id', zone.id()));
  propsEl.appendChild(rowEdit('Label', zone.data('label'), (v) => {
    canvas.setLabel(zone, v);
    return true;
  }));

  // Clause badge: the "single partitioning authority per zone" premise is
  // non-obvious unless the reviewer has read paper §4 and Cl. 4.4. Putting
  // it next to every zone makes the provenance of the NC-2 check legible.
  const clauseBadge = document.createElement('div');
  clauseBadge.className = 'muted zone-clause';
  clauseBadge.textContent =
    'IEC 62443-3-2:2020 ZCR 3 Cl. 4.4: one organisation designates each ' +
    'zone. Authority is the sole party that can assign monitoring ' +
    'responsibility over traffic this zone partitions - NC-2 compares ' +
    'this against the authority of the other endpoint\'s zone.';
  propsEl.appendChild(clauseBadge);

  const authId = zone.data('zoneAuthority');
  if (authId) {
    const section = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = 'Authority';
    section.appendChild(title);
    const list = document.createElement('div');
    list.className = 'owner-list';
    list.appendChild(ownerChipEl(authId, () => {
      zone.data('zoneAuthority', null);
      zone.data('borderColor', '#bee3f8');
      recordSnapshot();
      revalidate();
      renderProperties({ type: 'zone', element: zone });
    }));
    section.appendChild(list);
    propsEl.appendChild(section);
  } else {
    propsEl.appendChild(rowText(
      'Authority',
      'Not set - drag a chip onto this zone to designate its single partitioning authority.',
    ));
  }
  propsEl.appendChild(notesRow(zone));
}

function ownerOf(node) {
  const o = node.data('owners') ?? [];
  if (o.length === 0) return 'no owner';
  if (o.length === 1) return o[0];
  return `${o[0]} +${o.length - 1}`;
}

function ncFlag(label, val) {
  const el = document.createElement('span');
  el.className = 'nc-flag' + (val ? ' flag-true' : '');
  el.textContent = `${label}: ${val ? 'Y' : '-'}`;
  return el;
}

function notesRow(el) {
  const section = document.createElement('div');
  section.className = 'notes-row';
  const title = document.createElement('div');
  title.className = 'section-title';
  title.textContent = 'Notes';
  section.appendChild(title);
  const ta = document.createElement('textarea');
  ta.value = el.data('notes') ?? '';
  ta.setAttribute('aria-label', 'Notes for selected item');
  ta.maxLength = 2000;
  // Blind-spot edges get a placeholder that nudges authors to declare
  // active/latent (paper §4.1 C4). The tool can't infer this structurally,
  // so the annotation lives in free text.
  if (el.isEdge && el.isEdge() && el.data('verdict') === 'blind-spot') {
    ta.placeholder =
      'LATENT: compliant today (e.g. VLAN separation holds) but zero safety margin. ' +
      'Or ACTIVE: cross-tenant traffic flows now without end-to-end monitoring.';
  } else {
    ta.placeholder = 'Free-text annotation for this item...';
  }
  ta.addEventListener('change', () => {
    const value = sanitizeText(ta.value, 2000);
    canvas.setNotes(el, value);
  });
  section.appendChild(ta);

  // Persistent SSI caption (replaces the old placeholder-only warning,
  // which vanished on first keystroke - exactly the moment it mattered).
  const caption = document.createElement('div');
  caption.className = 'muted ssi-warning';
  caption.textContent =
    'Notes are stored in save files and included in YAML and PDF exports. ' +
    'Do NOT paste Sensitive Security Information (US 49 CFR Part 1520 or ' +
    'equivalent national classification). Use Help -> "Clear ALL notes" to ' +
    'redact every note on the canvas if you need to.';
  section.appendChild(caption);
  return section;
}

/**
 * Count elements carrying a non-empty note and, if any, ask the user to
 * confirm they are OK with those notes leaving the browser. Returns true
 * if the export should proceed (no notes present, or the user confirmed).
 */
async function confirmNotesIncluded(exportKind) {
  let total = 0;
  canvas.cy.elements().forEach((el) => {
    const n = el.data('notes');
    if (typeof n === 'string' && n.trim().length > 0) total += 1;
  });
  if (total === 0) return true;

  const p1 = document.createElement('div');
  p1.textContent =
    `${total} element${total === 1 ? '' : 's'} on this canvas carry non-empty notes, ` +
    `and those notes will be included in the ${exportKind} export.`;
  const p2 = document.createElement('div');
  p2.className = 'muted';
  p2.textContent =
    'Review the notes on each node, edge, and zone before sharing this file. ' +
    'Do not include Sensitive Security Information (49 CFR Part 1520 or equivalent).';
  const ok = await showModal({
    title: `${exportKind} export will include notes`,
    confirmLabel: 'Include notes and export',
    cancelLabel: 'Cancel',
    bodyElements: [p1, p2],
    onConfirm: () => true,
  });
  return !!ok;
}

function rowText(label, value) {
  const row = document.createElement('div');
  const l = document.createElement('div');
  l.className = 'section-title';
  l.textContent = label;
  const v = document.createElement('div');
  v.textContent = value;
  row.appendChild(l);
  row.appendChild(v);
  return row;
}

function rowEdit(label, initial, onCommit, opts = {}) {
  const maxLen = typeof opts.maxLength === 'number' ? opts.maxLength : 64;
  const allowEmpty = !!opts.allowEmpty;
  const wrap = document.createElement('label');
  const t = document.createElement('span');
  t.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = initial ?? '';
  input.maxLength = maxLen;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  let committed = initial ?? '';
  input.addEventListener('change', () => {
    const v = sanitizeText(input.value.trim(), maxLen);
    if (!v && !allowEmpty) {
      input.value = committed;
      return;
    }
    const ok = onCommit(v);
    if (ok === false) input.value = committed;
    else committed = v;
  });
  wrap.appendChild(t);
  wrap.appendChild(input);
  return wrap;
}

function spSubtypeRow(edge) {
  // Dropdown for IEC 62443-2-4 SP sub-type. Only rendered when
  // spCovered is true; writing 'both' is equivalent to pre-Batch-4
  // behaviour so switching the checkbox off and back on does not lose
  // the user's prior subtype choice (it's kept on edge.data.spSubtype).
  const wrap = document.createElement('label');
  const t = document.createElement('span');
  t.textContent = 'SP sub-type (IEC 62443-2-4 Cl. 3.1.12 / 3.1.13)';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'SP sub-type');
  const current = edge.data('spSubtype') ?? 'both';
  for (const [value, text] of [
    ['both',        'both (covers monitoring; default)'],
    ['maintenance', 'maintenance only (Cl. 3.1.13 + SP.08.02 BR)'],
    ['integration', 'integration only (Cl. 3.1.12, no monitoring)'],
  ]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    if (value === current) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener('change', () => {
    canvas.setSpSubtype(edge, select.value);
  });
  wrap.appendChild(t);
  wrap.appendChild(select);

  const hint = document.createElement('div');
  hint.className = 'muted';
  hint.textContent =
    'Integration-only SP-AO relationships do NOT cover security monitoring. ' +
    'An integration-only pick leaves NC-1 satisfied and the conduit may flip ' +
    'to blind-spot or borderline.';
  const section = document.createElement('div');
  section.appendChild(wrap);
  section.appendChild(hint);
  return section;
}

function directionRow(edge) {
  const wrap = document.createElement('div');
  wrap.className = 'direction-row';
  const title = document.createElement('div');
  title.className = 'section-title';
  title.textContent = 'Arrow direction';
  wrap.appendChild(title);

  const group = document.createElement('div');
  group.className = 'seg-group';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Arrow direction');

  const raw = edge.data('direction');
  const legacy = raw === 'one-way' ? 'forward' : raw;
  const current = legacy ?? (edge.data('directed') ? 'forward' : 'none');

  const srcLabel = edge.source().data('label') ?? 'A';
  const tgtLabel = edge.target().data('label') ?? 'B';

  const options = [
    { value: 'none',    label: '\u2014',                           aria: 'No arrows (line only)' },
    { value: 'forward', label: `${srcLabel} \u2192 ${tgtLabel}`,   aria: `${srcLabel} to ${tgtLabel}` },
    { value: 'reverse', label: `${tgtLabel} \u2192 ${srcLabel}`,   aria: `${tgtLabel} to ${srcLabel}` },
    { value: 'two-way', label: '\u2194',                           aria: 'Bidirectional' },
  ];
  const btns = [];
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn' + (opt.value === current ? ' seg-btn-active' : '');
    btn.textContent = opt.label;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', opt.value === current ? 'true' : 'false');
    btn.setAttribute('aria-label', opt.aria);
    btn.dataset.dirValue = opt.value;
    btn.addEventListener('click', () => {
      canvas.setDirection(edge, opt.value);
      // Update buttons in place so keyboard focus stays put (UX #6/15)
      // instead of re-rendering the whole properties panel.
      for (const b of btns) {
        const active = b.dataset.dirValue === opt.value;
        b.classList.toggle('seg-btn-active', active);
        b.setAttribute('aria-checked', active ? 'true' : 'false');
      }
      btn.focus();
    });
    btns.push(btn);
    group.appendChild(btn);
  }
  wrap.appendChild(group);
  return wrap;
}

function checkboxRow(label, initial, onChange) {
  const wrap = document.createElement('label');
  wrap.style.flexDirection = 'row';
  wrap.style.alignItems = 'center';
  wrap.style.gap = '8px';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!initial;
  cb.addEventListener('change', () => onChange(cb.checked));
  const t = document.createElement('span');
  t.textContent = label;
  wrap.appendChild(cb);
  wrap.appendChild(t);
  return wrap;
}

function ownerChipEl(ownerId, onRemove) {
  const el = document.createElement('span');
  el.className = 'chip';
  const swatch = document.createElement('span');
  swatch.className = 'chip-swatch';
  const colors = library.colorsFor(ownerId);
  swatch.style.backgroundColor = colors.bg;
  swatch.style.borderColor = colors.border;
  const label = document.createElement('span');
  label.className = 'chip-label';
  label.textContent = ownerId;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove ${ownerId}`);
  remove.textContent = 'x';
  remove.addEventListener('click', onRemove);
  el.appendChild(swatch);
  el.appendChild(label);
  el.appendChild(remove);
  return el;
}

// ---------------------------------------------------------------------------
// Help modal
// ---------------------------------------------------------------------------

async function showHelp() {
  const body = [];

  // --- What this tool does ----------------------------------------------
  body.push(sectionHeader('What BlindSpotCheck classifies'));
  body.push(para(
    'IEC 62443 assumes each zone / conduit has a single asset owner responsible for ' +
    'monitoring. In multi-tenant OT (airports, rail stations, ports, shared substations), ' +
    'that assumption breaks: two or more organisations meet on a shared fabric, and a ' +
    'conduit can fall into a gap where no one is accountable to monitor it. ' +
    'BlindSpotCheck flags those conduits as structural blind spots.',
  ));

  // --- Predicates -------------------------------------------------------
  body.push(sectionHeader('The three predicates'));
  body.push(predicateList([
    ['SC-1 (scope)',
     'Endpoints belong to distinct asset owners. Grounded in IEC 62443-2-1:2024 Clause 3.1.2 (Asset Owner definition).'],
    ['NC-1 (role-typing)',
     'No SP-AO relationship covers the conduit AND both endpoint owners are independent AOs. ' +
     'Grounded in IEC 62443-2-4:2023 Clauses 3.1.12 / 3.1.13 (SP sub-types) and SP.08.02 BR (log-sharing scope).'],
    ['NC-2 (governance)',
     'No single organisation designates the zones at both endpoints. ' +
     'Grounded in IEC 62443-3-2:2020 ZCR 3 Clause 4.4 (single-partitioning-authority premise).'],
  ]));
  body.push(para(
    'Biconditional (W. Kim 2026, §4.1): SC-1(c) implies [BlindSpot(c) if-and-only-if ' +
    'NC-1(c) AND NC-2(c)].',
  ));

  // --- Verdict vocabulary ----------------------------------------------
  body.push(sectionHeader('Verdict vocabulary'));
  body.push(defList([
    ['blind-spot',      'SC-1 AND NC-1 AND NC-2 all hold. Structural monitoring gap.'],
    ['borderline',      'SC-1 AND NC-1 hold but a single org designates both endpoint zones. One federation or org split away from blind-spot.'],
    ['resolved-by-sp',  'SC-1 holds but an SP-AO relationship covers the conduit. IEC 62443-2-4 log-sharing obligations apply.'],
    ['no-cross-ao',     'SC-1 does not hold. Endpoints share an owner; not a multi-tenant conduit.'],
    ['incomplete',      'An endpoint has no owner assigned. Evaluator skipped this edge until you assign one.'],
  ]));

  // --- Evidence levels --------------------------------------------------
  body.push(sectionHeader('Evidence levels'));
  body.push(defList([
    ['measured',
     'Template reproduces a result the paper measured on its Docker testbed. Airport CUPPS 1.0 is the only measured template.'],
    ['analytic-hypothesis',
     'Template is a structural mapping from public standards (paper §8.1 cross-domain). ' +
     'NOT empirically validated - do not quote the verdicts as measurement.'],
    ['custom',
     'User-drawn. Verdicts reflect the inputs you supplied.'],
  ]));

  // --- Keyboard shortcuts ----------------------------------------------
  body.push(sectionHeader('Keyboard shortcuts'));
  const shortcuts = [
    ['Mouse / pointer', 'Click to select. Shift-drag for box-select. Drag chips onto nodes (or zones for authority). Right-click for context menu.'],
    ['N',                'Add-node mode (click canvas to place)'],
    ['C',                'Connect mode (click source, then target)'],
    ['F',                'Fit to view'],
    ['Escape',           'Exit current mode / deselect'],
    ['Delete',           'Delete selected'],
    ['?',                'This help'],
    ['Ctrl/Cmd+Z',       'Undo (up to 50 steps)'],
    ['Ctrl/Cmd+Shift+Z', 'Redo'],
    ['Ctrl/Cmd+Y',       'Redo (alternate)'],
    ['Ctrl/Cmd+S',       'Save to file'],
    ['Ctrl/Cmd+Shift+S', 'Save as'],
    ['Ctrl/Cmd+O',       'Load from file'],
    ['Ctrl/Cmd+N',       'New (empty canvas)'],
  ];
  const dl = document.createElement('dl');
  dl.className = 'help-list';
  for (const [k, v] of shortcuts) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  body.push(dl);

  // --- Accessibility note ----------------------------------------------
  body.push(sectionHeader('Accessibility note'));
  body.push(para(
    'Canvas editing requires pointer input (mouse / trackpad / touch). Keyboard-only ' +
    'users can load templates and inspect verdicts via the Properties panel, but cannot ' +
    'draw or edit graphs with keyboard alone. This is a Cytoscape.js limitation that no ' +
    'vanilla workaround fully resolves. If you need a non-pointer route to the verdicts, ' +
    'use the Python CLI on a YAML file.',
  ));

  // --- Safety / data handling ------------------------------------------
  body.push(sectionHeader('Data handling'));
  body.push(para(
    'The evaluator runs entirely locally in your browser tab. No network call, no ' +
    'telemetry. Auto-save (when enabled) writes to this browser\'s LocalStorage - it ' +
    'survives tab close but not a cleared browser profile. Save files, YAML exports, ' +
    'and PDF exports leave your browser only when you explicitly download them.',
  ));
  body.push(para(
    'Notes travel with every export format (Save, YAML, PDF). Do NOT paste Sensitive ' +
    'Security Information (US 49 CFR Part 1520 or equivalent) into notes. If you did, ' +
    'use the button below to clear every note on the canvas.',
  ));

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn-danger';
  clearBtn.textContent = 'Clear ALL notes on canvas';
  clearBtn.addEventListener('click', () => {
    const count = clearAllNotes();
    // Close help so the user sees the status update.
    const closeBtn = document.querySelector('.modal-actions button.primary');
    if (closeBtn) closeBtn.click();
    showStatus(
      count > 0
        ? `Cleared notes on ${count} element(s).`
        : 'No notes to clear.',
    );
  });
  body.push(clearBtn);

  // --- Audit-trail signing ---------------------------------------------
  body.push(sectionHeader('Audit trail'));
  body.push(para(
    'PDF exports always include the SHA-256 hash of the canonical JSON ' +
    'representation of the current architecture, computed at export time. ' +
    'If you want to attest that you reviewed this architecture, sign it: ' +
    'your name and an ISO-8601 timestamp are stamped into meta.review, ' +
    'which then shows up alongside the hash on the PDF.',
  ));
  if (canvas.review?.reviewer) {
    const current = document.createElement('div');
    current.className = 'muted';
    current.textContent =
      `Currently signed by ${canvas.review.reviewer} ` +
      `at ${canvas.review.reviewed_on ?? '?'}. ` +
      `Hash ${canvas.review.artefact_hash?.slice(0, 16) ?? '?'}...`;
    body.push(current);
  }
  const signBtn = document.createElement('button');
  signBtn.type = 'button';
  signBtn.className = 'btn-secondary';
  signBtn.textContent = canvas.review?.reviewer
    ? 'Re-sign with current state'
    : 'Sign this architecture as reviewed';
  signBtn.addEventListener('click', async () => {
    const closeBtn = document.querySelector('.modal-actions button.primary');
    if (closeBtn) closeBtn.click();
    await signAsReviewed();
  });
  body.push(signBtn);

  // --- Scenario fork (paper §8 latent-trigger exploration) -------------
  body.push(sectionHeader('Scenario fork'));
  body.push(para(
    'Paper §8 and §8.2 discuss architectural transitions (federation splits, ' +
    'CUPPS migrations) that flip a conduit\'s verdict. You can explore those ' +
    '"what if I change X?" scenarios without losing the current state: fork ' +
    'the current canvas as Scenario A (a frozen baseline), continue editing ' +
    'as Scenario B, then compare the verdicts to see exactly which conduits ' +
    'flipped, were added, or were removed.',
  ));

  if (canvas.forkSnapshot) {
    const activeRow = document.createElement('div');
    activeRow.className = 'muted';
    const stampedLine = document.createElement('div');
    stampedLine.textContent = `Fork active. Baseline stamped at ${canvas.forkStampedAt}.`;
    activeRow.appendChild(stampedLine);
    body.push(activeRow);

    const compareBtn = document.createElement('button');
    compareBtn.type = 'button';
    compareBtn.className = 'btn-secondary';
    compareBtn.textContent = 'Show Scenario A vs B diff';
    compareBtn.addEventListener('click', async () => {
      const closeBtn = document.querySelector('.modal-actions button.primary');
      if (closeBtn) closeBtn.click();
      await showScenarioDiff();
    });
    body.push(compareBtn);

    const dropBtn = document.createElement('button');
    dropBtn.type = 'button';
    dropBtn.className = 'btn-secondary';
    dropBtn.textContent = 'Drop fork baseline';
    dropBtn.addEventListener('click', () => {
      dropFork();
      const closeBtn = document.querySelector('.modal-actions button.primary');
      if (closeBtn) closeBtn.click();
    });
    body.push(dropBtn);
  } else {
    const forkBtn = document.createElement('button');
    forkBtn.type = 'button';
    forkBtn.className = 'btn-secondary';
    forkBtn.textContent = 'Fork current state as Scenario A';
    forkBtn.addEventListener('click', () => {
      forkCurrentState();
      const closeBtn = document.querySelector('.modal-actions button.primary');
      if (closeBtn) closeBtn.click();
    });
    body.push(forkBtn);
  }

  // --- Where to read more ----------------------------------------------
  body.push(sectionHeader('Where to read more'));
  const links = document.createElement('div');
  const designLink = document.createElement('a');
  designLink.href = '../docs/design.md';
  designLink.textContent = 'Evaluator design notes (clause-by-clause derivation)';
  designLink.setAttribute('target', '_blank');
  designLink.setAttribute('rel', 'noopener');
  links.appendChild(designLink);
  body.push(links);

  await showModal({
    title: 'BlindSpotCheck - help',
    confirmLabel: 'Close',
    cancelLabel: null,
    bodyElements: body,
  });
}

function sectionHeader(text) {
  const h = document.createElement('h4');
  h.className = 'help-heading';
  h.textContent = text;
  return h;
}

function para(text) {
  const p = document.createElement('p');
  p.className = 'help-para';
  p.textContent = text;
  return p;
}

function predicateList(items) {
  const dl = document.createElement('dl');
  dl.className = 'help-list help-list-wide';
  for (const [k, v] of items) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  return dl;
}

function defList(items) {
  return predicateList(items);
}

function clearAllNotes() {
  let cleared = 0;
  canvas.cy.elements().forEach((el) => {
    const n = el.data('notes');
    if (typeof n === 'string' && n.trim().length > 0) {
      canvas.setNotes(el, '');
      cleared += 1;
    }
  });
  return cleared;
}

/**
 * Canonical SHA-256 of the current architecture, computed via the browser-
 * native Web Crypto API (no external dependency). The architecture is
 * serialised via canonicalStringify so property insertion order does not
 * perturb the hash. Returns a 64-character lowercase hex string, or `null`
 * if the canvas currently fails to produce a valid architecture (e.g. no
 * owners assigned yet).
 */
async function computeArtefactHash() {
  const { arch } = canvasToFullArchitecture(canvas, library);
  if (!arch) return null;
  // Exclude meta.review from the hash input: otherwise signing the
  // architecture mutates the hash, which would change on the very
  // next re-sign and break audit-trail stability.
  const archForHash = { ...arch, meta: { ...arch.meta } };
  delete archForHash.meta.review;
  const canonical = canonicalStringify(archForHash);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Scenario fork + verdict diff (Batch 6, paper §8 latent-trigger discussion
// and §8.2 migration-scenario workflows). "Fork" freezes the current canvas
// as Scenario A; continued edits are implicitly Scenario B. The diff view
// reports which conduits added / removed / flipped between the two, without
// spinning up a second Cytoscape instance.
// ---------------------------------------------------------------------------

function forkCurrentState() {
  const snap = canvasToSnapshot(canvas, library);
  canvas.forkSnapshot = snap;
  canvas.forkStampedAt = new Date().toISOString();
  updateEvidenceBanner();
  showStatus('Fork baseline stamped. Continue editing; use Help -> Scenarios to compare.');
}

function dropFork() {
  canvas.forkSnapshot = null;
  canvas.forkStampedAt = null;
  updateEvidenceBanner();
  showStatus('Fork baseline dropped.');
}

function computeVerdictMap(snapshot) {
  const arch = snapshotToArchitecture(snapshot, library);
  if (!arch) return { ok: false, arch: null, verdicts: new Map() };
  try {
    validateArchitecture(arch);
  } catch {
    return { ok: false, arch, verdicts: new Map() };
  }
  const report = evaluateArchitecture(arch);
  const verdicts = new Map(report.results.map((r) => [r.conduit_id, r.verdict]));
  return { ok: true, arch, verdicts, report };
}

function diffScenarios(snapA, snapB) {
  const a = computeVerdictMap(snapA);
  const bCurrent = canvasToSnapshot(canvas, library);
  const b = snapB ? computeVerdictMap(snapB) : computeVerdictMap(bCurrent);

  const added = [];
  const removed = [];
  const flipped = [];
  const unchanged = [];

  for (const [id, vB] of b.verdicts) {
    if (!a.verdicts.has(id)) {
      added.push({ id, verdict: vB });
    } else if (a.verdicts.get(id) !== vB) {
      flipped.push({ id, from: a.verdicts.get(id), to: vB });
    } else {
      unchanged.push({ id, verdict: vB });
    }
  }
  for (const [id, vA] of a.verdicts) {
    if (!b.verdicts.has(id)) removed.push({ id, verdict: vA });
  }

  const distA = a.report?.distribution?.() ?? {};
  const distB = b.report?.distribution?.() ?? {};

  return { a, b, added, removed, flipped, unchanged, distA, distB };
}

async function showScenarioDiff() {
  if (!canvas.forkSnapshot) {
    showStatus('No fork baseline. Use Help -> Scenarios to fork first.');
    return;
  }
  const d = diffScenarios(canvas.forkSnapshot, null);

  const body = [];
  body.push(sectionHeader('Scenario A (forked baseline)'));
  const summaryA = document.createElement('div');
  summaryA.textContent = d.a.ok
    ? `Stamped at ${canvas.forkStampedAt}. Distribution: ${formatDist(d.distA)}.`
    : 'Fork snapshot did not evaluate to a valid architecture (needs 2+ owners and 1+ complete edge).';
  body.push(summaryA);

  body.push(sectionHeader('Scenario B (current canvas)'));
  const summaryB = document.createElement('div');
  summaryB.textContent = d.b.ok
    ? `Distribution: ${formatDist(d.distB)}.`
    : 'Current canvas does not evaluate to a valid architecture yet.';
  body.push(summaryB);

  body.push(sectionHeader('Changes (A -> B)'));
  const flippedCount = d.flipped.length;
  const addedCount = d.added.length;
  const removedCount = d.removed.length;
  const sum = document.createElement('div');
  sum.innerHTML = '';
  sum.textContent =
    `${flippedCount} flipped · ${addedCount} added · ${removedCount} removed · ${d.unchanged.length} unchanged.`;
  body.push(sum);

  if (flippedCount > 0) {
    body.push(sectionHeader('Verdict flips'));
    const dl = document.createElement('dl');
    dl.className = 'help-list help-list-wide';
    for (const f of d.flipped) {
      const dt = document.createElement('dt');
      dt.textContent = f.id;
      const dd = document.createElement('dd');
      dd.textContent = `${f.from}  ->  ${f.to}`;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    body.push(dl);
  }
  if (addedCount > 0) {
    body.push(sectionHeader('Added in Scenario B'));
    const dl = document.createElement('dl');
    dl.className = 'help-list help-list-wide';
    for (const a of d.added) {
      const dt = document.createElement('dt');
      dt.textContent = a.id;
      const dd = document.createElement('dd');
      dd.textContent = a.verdict;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    body.push(dl);
  }
  if (removedCount > 0) {
    body.push(sectionHeader('Removed in Scenario B'));
    const dl = document.createElement('dl');
    dl.className = 'help-list help-list-wide';
    for (const r of d.removed) {
      const dt = document.createElement('dt');
      dt.textContent = r.id;
      const dd = document.createElement('dd');
      dd.textContent = r.verdict;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    body.push(dl);
  }

  await showModal({
    title: 'Scenario diff (A vs B)',
    confirmLabel: 'Close',
    cancelLabel: null,
    bodyElements: body,
  });
}

function formatDist(dist) {
  const parts = [];
  for (const key of ['blind-spot', 'borderline', 'resolved-by-sp', 'no-cross-ao']) {
    parts.push(`${key}=${dist[key] ?? 0}`);
  }
  return parts.join(', ');
}

/**
 * Ask the user for a reviewer name, record them with an ISO-8601
 * timestamp, and stamp the architecture's canonical SHA-256 hash. The
 * result lands on canvas.review and flows through save files, YAML
 * exports, and the PDF print-view review block.
 */
async function signAsReviewed() {
  const hash = await computeArtefactHash();
  if (!hash) {
    showStatus(
      'Cannot sign: canvas must evaluate to a valid architecture ' +
      '(need at least 2 distinct owners and 1 complete edge).',
    );
    return;
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 200;
  input.placeholder = 'Your name or reviewer tag';
  input.setAttribute('aria-label', 'Reviewer name');
  input.value = canvas.review?.reviewer ?? '';

  const wrap = document.createElement('label');
  const t = document.createElement('span');
  t.textContent = 'Reviewer';
  wrap.appendChild(t);
  wrap.appendChild(input);

  const hashPreview = document.createElement('div');
  hashPreview.className = 'muted';
  hashPreview.textContent =
    `Canonical architecture SHA-256: ${hash.slice(0, 16)}... ` +
    '(first 16 hex chars). The full 64-char hash will be stamped into ' +
    'meta.review.artefact_hash and shown on PDF exports.';

  const warn = document.createElement('div');
  warn.className = 'muted';
  warn.textContent =
    'The signature represents your attestation that the current canvas ' +
    'state is the one you reviewed. Any subsequent edit invalidates it; ' +
    're-sign before sharing a revised PDF.';

  const result = await showModal({
    title: 'Sign this architecture as reviewed',
    confirmLabel: 'Sign',
    cancelLabel: 'Cancel',
    bodyElements: [wrap, hashPreview, warn],
    onConfirm: () => {
      const v = sanitizeText(input.value.trim(), 200);
      return v || undefined;
    },
  });
  if (!result) return;

  canvas.review = {
    reviewer: result,
    reviewed_on: new Date().toISOString(),
    artefact_hash: hash,
  };
  updateDirty();
  updateUndoRedoButtons();
  showStatus(`Signed by ${result}. Hash ${hash.slice(0, 12)}...`);
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (mod) {
    if (key === 'z' && e.shiftKey) { e.preventDefault(); doRedo(); return; }
    if (key === 'z')               { e.preventDefault(); doUndo(); return; }
    if (key === 'y')               { e.preventDefault(); doRedo(); return; }
    if (key === 's' && e.shiftKey) { e.preventDefault(); doSave(true); return; }
    if (key === 's')               { e.preventDefault(); doSave(false); return; }
    if (key === 'o')               { e.preventDefault(); btnLoad.click(); return; }
    if (key === 'n')               { e.preventDefault(); btnNew.click(); return; }
    return;
  }

  if (key === 'Escape') {
    canvas.setMode('normal');
    showStatus('Ready.');
  } else if (key === 'Delete' || key === 'Backspace') {
    e.preventDefault();
    canvas.deleteSelected();
  } else if (key === 'f') {
    canvas.fit();
  } else if (key === 'n') {
    btnAddNode.click();
  } else if (key === 'c') {
    btnConnect.click();
  } else if (key === '?') {
    e.preventDefault();
    showHelp();
  }
});

// Warn on unload if there are unsaved changes.
window.addEventListener('beforeunload', (e) => {
  if (isDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  updateEvidenceBanner();

  // Set initial snapshot / history baseline from empty canvas.
  const initialSnap = canvasToSnapshot(canvas, library);
  history.init(initialSnap);
  setLastSavedSnapshot(initialSnap);

  // Restore saved filename from LocalStorage (cosmetic - file contents live
  // inside auto-save state only when auto-save is enabled).
  currentFilename = getSavedFilename() ?? 'untitled';

  updateDirty();
  updateUndoRedoButtons();
  configureAutosaveTimer();
  revalidate();

  // Offer to restore the last auto-saved draft, if one is present AND
  // the user currently has the auto-save toggle on. Before this gate
  // was added, disabling auto-save still let a stale draft come back
  // on next load - a consent-surprise flagged by UX review (FO-001).
  const autosaved = getAutosaveEnabled() ? loadAutosave() : null;
  if (autosaved) {
    try {
      const when = autosaved.saved_at ? new Date(autosaved.saved_at).toLocaleString() : 'earlier';
      const nameStr = autosaved.meta?.name ?? 'Custom architecture';
      const nNodes = (autosaved.nodes ?? []).length;
      const nEdges = (autosaved.edges ?? []).length;

      const p = document.createElement('div');
      p.textContent = `Found an auto-saved draft from ${when}.`;
      const meta = document.createElement('div');
      meta.className = 'muted';
      meta.textContent = `"${nameStr}" - ${nNodes} nodes, ${nEdges} edges.`;

      const result = await showModal({
        title: 'Restore auto-saved draft?',
        confirmLabel: 'Restore',
        cancelLabel: 'Discard',
        bodyElements: [p, meta],
        onConfirm: () => true,
      });
      if (result) {
        restoreFromSnapshot(autosaved, { filename: currentFilename, resetHistory: true });
        showStatus('Restored auto-saved draft.');
        return;
      }
      clearAutosave();
      showStatus('Auto-saved draft discarded.');
    } catch {
      clearAutosave();
    }
  }

  // Cold-start (no autosave to restore): on a truly untitled session we
  // greet the user with the template gallery. A first-time visitor who
  // lands on an empty canvas does not know the tool's vocabulary; the
  // gallery gives them one concrete entry point (load the airport measured
  // template) without reading README first. They can still close the
  // gallery and draw from scratch.
  if (currentFilename === 'untitled' && canvas.cy.elements().length === 0) {
    showStatus('Welcome! Pick a starter template, or close the gallery to draw on an empty canvas.');
    // Fire and forget - the await chain keeps focus management correct.
    await openTemplateGallery();
    return;
  }

  showStatus('Ready. Load a template or press N to add a node.');
}

boot();
