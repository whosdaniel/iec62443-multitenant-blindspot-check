// Cytoscape-backed canvas: node/edge/zone CRUD, mode machine, chip-drop
// handler, right-click context menu.
//
// Stage C scope: drawing only. Verdict overlay + per-change evaluator
// wiring is added in Stage D. This module exposes an 'on' event emitter
// so Stage D can subscribe to graph-change events without editing this
// file.
//
// Cytoscape.js is loaded via a <script src="vendor/cytoscape.min.js">
// tag in index.html and exposed as window.cytoscape (UMD build).

import { sanitizeText, showContextMenu, showStatus } from './ui.js';
import { applyOwnerColors, MAX_BANDS } from './owner-colors.js';

export { applyOwnerColors, MAX_BANDS };

// eslint-disable-next-line no-undef
const cytoscape = globalThis.cytoscape;
if (!cytoscape) {
  throw new Error(
    'cytoscape global not found - check <script src="vendor/cytoscape.min.js"> tag in index.html',
  );
}

export const NODE_LIMIT = 500;
export const NODE_WARN = 450;


let _nodeCounter = 0;
let _edgeCounter = 0;
let _zoneCounter = 0;

// Map a click position on a node to one of the four cardinal faces.
// Compares the offset dx/dy (relative to node centre, normalised by
// half-width / half-height) and picks whichever axis has the larger
// magnitude, then sign picks the side. Diagonal clicks prefer the
// stronger axis - clicking the top-left corner resolves as "top" if
// the vertical offset dominates, "left" otherwise.
export function faceFromTap(node, clickPos) {
  const pos = node.position();
  const w = node.width() || 100;
  const h = node.height() || 100;
  const dx = (clickPos.x - pos.x) / (w / 2);
  const dy = (clickPos.y - pos.y) / (h / 2);
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? 'right' : 'left';
  }
  return dy > 0 ? 'bottom' : 'top';
}

// Cytoscape source-endpoint / target-endpoint offsets in percent that
// correspond to each face. Origin is the node centre; x is right-
// positive, y is down-positive.
const FACE_ENDPOINT = Object.freeze({
  top:    '0% -50%',
  bottom: '0% 50%',
  left:   '-50% 0%',
  right:  '50% 0%',
});

// Project point p onto the line from a to b. Returns {t, d} where t is
// the 0..1 position along the line (can be <0 or >1 if p is past an
// endpoint) and d is the signed perpendicular distance in pixels.
// d uses Cytoscape's unbundled-bezier control-point-distances sign
// convention: POSITIVE d means the curve passes to the RIGHT of the
// a->b direction on screen. For a southbound edge (y grows down),
// positive d therefore corresponds to WEST (negative X).
//
// Empirically verified with Fig 2 CD-01: controlPointDistances=[-160]
// renders a curve bulging EAST across Airport IT's right side; the
// paper-intended western bulge therefore needs POSITIVE d. Dragging
// the bend handle eastward (p.x > midpoint) now writes a positive d
// so the curve follows the cursor, not flees from it (UX agent 2 #2).
function projectPointOnLine(a, b, p) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { t: 0, d: 0 };
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const len = Math.sqrt(len2);
  // Right-perpendicular unit vector in screen space (y grows down):
  //   (dy, -dx) / len. d = (p - a) . rightPerp.
  const d = ((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
  return { t, d };
}

// Resolve the actual endpoint attachment position in model coords.
// Priority: explicit sourceEndpoint/targetEndpoint (stored as "X% Y%"
// string) > sourceFace/targetFace (4 cardinals) > node centre.
function computeEndpointAnchor(edge, role) {
  const node = role === 'source' ? edge.source() : edge.target();
  const centre = node.position();
  const w = node.width() || 100;
  const h = node.height() || 100;
  const raw = role === 'source' ? edge.data('sourceEndpoint') : edge.data('targetEndpoint');
  if (typeof raw === 'string') {
    const m = raw.match(/^\s*(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%\s*$/);
    if (m) {
      return {
        x: centre.x + (parseFloat(m[1]) / 50) * (w / 2),
        y: centre.y + (parseFloat(m[2]) / 50) * (h / 2),
      };
    }
  }
  const face = role === 'source' ? edge.data('sourceFace') : edge.data('targetFace');
  switch (face) {
    case 'top':    return { x: centre.x,         y: centre.y - h / 2 };
    case 'bottom': return { x: centre.x,         y: centre.y + h / 2 };
    case 'left':   return { x: centre.x - w / 2, y: centre.y         };
    case 'right':  return { x: centre.x + w / 2, y: centre.y         };
    default:       return { x: centre.x, y: centre.y };
  }
}

// Given a handle position near a node, project onto the node's
// bounding-box boundary and return the (x, y) percentage in
// Cytoscape's source-endpoint / target-endpoint coord space (-50..50
// of half-width / half-height, origin at node centre).
function computeEndpointPercent(node, handlePos) {
  const centre = node.position();
  const w = node.width() || 100;
  const h = node.height() || 100;
  const halfW = w / 2;
  const halfH = h / 2;
  const dx = handlePos.x - centre.x;
  const dy = handlePos.y - centre.y;
  const pxPct = (dx / halfW) * 50;
  const pyPct = (dy / halfH) * 50;
  // Project onto the boundary: scale so the dominant axis hits +/- 50.
  const mag = Math.max(Math.abs(pxPct), Math.abs(pyPct));
  if (mag <= 0) return { x: 0, y: -50 }; // degenerate - park at top
  const scale = 50 / mag;
  return {
    x: Math.round(pxPct * scale * 10) / 10,  // 1 decimal
    y: Math.round(pyPct * scale * 10) / 10,
  };
}

// Inverse of computeEndpointPercent: given a (pct.x, pct.y) in
// Cytoscape's endpoint coord space, resolve absolute canvas position.
function percentToAbsolute(node, pct) {
  const centre = node.position();
  const w = node.width() || 100;
  const h = node.height() || 100;
  return {
    x: centre.x + (pct.x / 50) * (w / 2),
    y: centre.y + (pct.y / 50) * (h / 2),
  };
}

// Given an edge, compute where the bend handle should be placed: at
// the existing bend if the edge already has one, or at the straight-
// line midpoint otherwise. Uses the resolved endpoint anchors (not
// the raw node centres) so bends stay visually centred on the line
// Cytoscape actually draws.
function computeBendAnchor(edge) {
  const a = computeEndpointAnchor(edge, 'source');
  const b = computeEndpointAnchor(edge, 'target');
  // Single-bezier control point. For multi-control-point templates,
  // we anchor the handle to the middle control point so a single
  // drag still adjusts the curve predictably.
  const cpd = edge.data('controlPointDistances');
  const cpw = edge.data('controlPointWeights');
  if (Array.isArray(cpd) && Array.isArray(cpw) && cpd.length > 0) {
    const mid = Math.floor(cpd.length / 2);
    return { midPoint: anchorFrom(a, b, cpw[mid], cpd[mid]) };
  }
  return { midPoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

function anchorFrom(a, b, t, d) {
  const baseX = a.x + (b.x - a.x) * t;
  const baseY = a.y + (b.y - a.y) * t;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx =  dy / len;
  const ny = -dx / len;
  // For a quadratic bezier with one control point P1, the curve at
  // t=0.5 passes through (P0+P2)/2 + (P1 - (P0+P2)/2)/2 - i.e. halfway
  // between the line midpoint and P1. We want the handle to sit ON
  // the visible curve, not on the invisible control point. Halving
  // d here places the handle at the curve peak; the drag handler
  // doubles the projected distance when writing back, so the round
  // trip is consistent.
  return { x: baseX + nx * (d / 2), y: baseY + ny * (d / 2) };
}

function nextNodeId() {
  _nodeCounter += 1;
  return `node-${String(_nodeCounter).padStart(3, '0')}`;
}
function nextEdgeId() {
  _edgeCounter += 1;
  return `CD-${String(_edgeCounter).padStart(3, '0')}`;
}
function nextZoneId() {
  _zoneCounter += 1;
  return `zone-${String(_zoneCounter).padStart(3, '0')}`;
}

// Segments curve style (Danny's pick: straight orthogonal, reads best
// for OT-network diagrams). Bezier alternative left as future toggle.
const STYLE = [
  {
    selector: 'node',
    style: {
      'background-color': 'data(bgColor)',
      'border-color': 'data(borderColor)',
      'border-width': 2,
      // displayLabel bundles the asset name plus an optional role-context
      // sub-line (paper Fig 2 style: "[VND oper. / APT HW]"). Computed
      // via updateDisplayLabel() whenever label or roleContext changes so
      // the edit/undo paths stay in sync.
      'label': 'data(displayLabel)',
      'color': '#1a202c',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 6,
      'font-size': 12,
      'font-family': 'system-ui, -apple-system, sans-serif',
      'width': 100,
      'height': 100,
      'shape': 'round-rectangle',
      'text-wrap': 'wrap',
      'text-max-width': 200,
      'line-height': 1.25,
      'font-weight': 500,
      // Node labels render WITHOUT a white halo. Cytoscape draws all
      // node/edge labels AFTER every body in a single late pass, so
      // z-index cannot push labels below edges. A halo would only
      // enlarge the label's visual footprint and block more of the
      // edges that pass behind it. Keeping text bare minimises the
      // occlusion area to just the glyph strokes themselves.
      'text-outline-opacity': 0,
      'z-index': 5,
    },
  },
  // Multi-owner fill (linear-gradient stripes). Gated on the
  // gradientColors data field so it only applies to regular nodes
  // that went through applyOwnerColors(); zones and bend/endpoint
  // handle nodes keep their own solid backgrounds without triggering
  // Cytoscape "no mapping" warnings.
  {
    selector: 'node[gradientColors]',
    style: {
      'background-fill': 'linear-gradient',
      'background-gradient-direction': 'to-right',
      'background-gradient-stop-colors':    'data(gradientColors)',
      'background-gradient-stop-positions': 'data(gradientStops)',
    },
  },
  {
    // Multi-tenant visual warning: double border signals that multiple
    // independent AO sessions or contexts coexist on this asset (paper
    // Fig 2 "double-border" legend entry, Purdue-style). The pie-chart
    // already tells the reader *which* tenants; the border just flags
    // the coexistence at a glance. Uses width 6 so a concurrent
    // has-notes border (width 3) cannot hide the double-border signal
    // (UX agent 3 P1).
    selector: 'node[?multiTenant]',
    style: {
      'border-width': 6,
      'border-style': 'double',
    },
  },
  {
    selector: 'node.zone',
    style: {
      'background-color': '#ebf8ff',
      'background-opacity': 0.35,
      'border-color': 'data(borderColor)',
      'border-width': 1.5,
      'border-style': 'dashed',
      'shape': 'round-rectangle',
      'label': 'data(label)',
      'text-valign': 'top',
      'text-halign': 'center',
      'text-margin-y': -22,
      'color': '#4a5568',
      'font-weight': 500,
      'font-size': 11,
      'text-outline-color': '#ffffff',
      'text-outline-width': 2,
      'text-outline-opacity': 1,
      'padding': '30px',
      'compound-sizing-wrt-labels': 'include',
      'z-index': 1,
    },
  },
  // Zone without authority: a distinct dotted grey so the user sees
  // "authority pending" rather than mis-reading it as a blue-palette
  // authority (UX agent 3 P4).
  {
    selector: 'node.zone[!zoneAuthority]',
    style: {
      'border-color': '#a0aec0',
      'border-style': 'dotted',
      'background-color': '#f7fafc',
    },
  },
  {
    // Selected regular node: preserve multi-tenant double border. We
    // layer the blue signal via overlay + border-color only, leaving
    // border-style unchanged so a 3-tenant CUPPS Workstation still
    // reads as multi-tenant when selected (UX H1).
    selector: 'node:selected',
    style: {
      'border-color': '#3182ce',
      'overlay-color': '#3182ce',
      'overlay-opacity': 0.08,
    },
  },
  {
    selector: 'node.zone:selected',
    style: {
      'border-color': '#3182ce',
    },
  },
  {
    selector: 'edge',
    style: {
      // All edges use unbundled-bezier. Without control points it
      // renders as a straight line; with control points it renders as
      // a smooth curve. One curve model everywhere means endpoint
      // drag, bend drag, and templates all use the same coord system
      // so there are no mode-transition glitches (the segments style
      // used to lose fidelity when endpoints moved - UX feedback).
      'curve-style': 'straight',
      'width': 2,
      'line-color': '#718096',
      'target-arrow-shape': 'none',
      'label': 'data(label)',
      'color': '#2d3748',
      'font-size': 10,
      'text-outline-color': '#ffffff',
      'text-outline-width': 2,
      'text-outline-opacity': 1,
      'text-rotation': 'autorotate',
      // Edges render ABOVE non-endpoint nodes. Without this, a line
      // that passes near or through a node (e.g. CD-01 from VND Cloud
      // BHS down through Airport IT to DMZ) gets hidden behind the
      // intermediate node's background. z=10 on edges + z=5 on nodes
      // + z=1 on zones keeps the stack legible.
      'z-index': 10,
      // Hold the arrow head a few pixels off the node boundary so the
      // triangle is not hidden inside a heavy border (multi-tenant
      // double border is 6px). Without this gap, the arrow on CD-06
      // at CUPPS Workstation was clipped into the border and looked
      // like the edge had no direction indicator at all.
      'source-distance-from-node': 4,
      'target-distance-from-node': 4,
    },
  },
  // Direction is a 4-state enum on each edge:
  //   'none'    : no arrows
  //   'forward' : target arrow only (source -> target)
  //   'reverse' : source arrow only (target -> source)
  //   'two-way' : arrows on both endpoints
  //
  // Legacy save files carrying `directed: true` or direction='one-way'
  // are normalised to 'forward' at load time (serialize.js), so these
  // selectors only need to match the new enum values. Mutually
  // exclusive selectors prevent reverse from inheriting target arrows
  // via an over-broad `edge[?directed]` rule.
  {
    selector: 'edge[direction = "forward"], edge[direction = "one-way"]',
    style: {
      'target-arrow-shape': 'triangle',
      'target-arrow-color': '#718096',
      'source-arrow-shape': 'none',
      'arrow-scale': 1.8,
      'target-arrow-fill': 'filled',
    },
  },
  {
    selector: 'edge[direction = "reverse"]',
    style: {
      'target-arrow-shape': 'none',
      'source-arrow-shape': 'triangle',
      'source-arrow-color': '#718096',
      'arrow-scale': 1.8,
      'source-arrow-fill': 'filled',
    },
  },
  {
    selector: 'edge[direction = "two-way"]',
    style: {
      'target-arrow-shape': 'triangle',
      'target-arrow-color': '#718096',
      'source-arrow-shape': 'triangle',
      'source-arrow-color': '#718096',
      'arrow-scale': 1.8,
      'target-arrow-fill': 'filled',
      'source-arrow-fill': 'filled',
    },
  },
  // Bezier curves: both templates and user drag use this one model.
  // Templates can supply one or more control points (perpendicular
  // distance + weight pairs along the source-to-target line) to route
  // around intermediate nodes (paper Fig 2 CD-01 uses a single
  // westward control point). User drag writes a single control point
  // at the handle position. Edges without controlPointDistances fall
  // back to the straight 'edge' selector above.
  {
    selector: 'edge[controlPointDistances]',
    style: {
      'curve-style':             'unbundled-bezier',
      'control-point-distances': 'data(controlPointDistances)',
      'control-point-weights':   'data(controlPointWeights)',
    },
  },
  // Face-specific endpoints: when the user clicks a specific side of a
  // node during connect mode, the resulting edge carries a data
  // sourceFace / targetFace tag which these rules translate into the
  // pixel/percent anchor that Cytoscape's source-endpoint /
  // target-endpoint styles understand.
  { selector: 'edge[sourceFace = "top"]',    style: { 'source-endpoint': '0% -50%' } },
  { selector: 'edge[sourceFace = "bottom"]', style: { 'source-endpoint': '0% 50%'  } },
  { selector: 'edge[sourceFace = "left"]',   style: { 'source-endpoint': '-50% 0%' } },
  { selector: 'edge[sourceFace = "right"]',  style: { 'source-endpoint': '50% 0%'  } },
  { selector: 'edge[targetFace = "top"]',    style: { 'target-endpoint': '0% -50%' } },
  { selector: 'edge[targetFace = "bottom"]', style: { 'target-endpoint': '0% 50%'  } },
  { selector: 'edge[targetFace = "left"]',   style: { 'target-endpoint': '-50% 0%' } },
  { selector: 'edge[targetFace = "right"]',  style: { 'target-endpoint': '50% 0%'  } },
  {
    selector: 'edge:selected',
    style: {
      'line-color': '#3182ce',
      'target-arrow-color': '#3182ce',
      'width': 3,
    },
  },
  {
    selector: '.connect-source',
    style: {
      'border-color': '#dd6b20',
      'border-width': 4,
      'overlay-color': '#dd6b20',
      'overlay-opacity': 0.12,
    },
  },
  {
    // Small blue grabbable dot that appears at the bend point of the
    // currently-selected edge. Dragging it curves the edge.
    selector: 'node.edge-bend-handle',
    style: {
      'shape': 'ellipse',
      'width': 14,
      'height': 14,
      'background-color': '#3182ce',
      'background-fill': 'solid',
      'border-color': '#ffffff',
      'border-width': 2,
      'label': '',
      'events': 'yes',
      'z-index': 50,
    },
  },
  {
    // Square grabbable nodes at the edge source/target attachment
    // points. Drag to slide the endpoint anywhere along the attached
    // node's boundary (not just the four cardinal faces).
    selector: 'node.edge-endpoint-handle',
    style: {
      'shape': 'rectangle',
      'width': 12,
      'height': 12,
      'background-color': '#ed8936',
      'background-fill': 'solid',
      'border-color': '#ffffff',
      'border-width': 2,
      'label': '',
      'events': 'yes',
      'z-index': 51,
    },
  },

  // --- Verdict overlay (added in Stage D) -------------------------------
  // Each class pairs a colour with a line-style so the distinction is
  // still legible to colour-blind users.
  // Verdict styles. Line width AND arrow-scale are unified across
  // all verdict classes so every arrowhead renders at the same
  // visual size. Differentiation is carried by colour + line-style
  // (solid / dashed / long-dash / dotted). The earlier inverse-scale
  // math (arrow-scale = target / lineWidth) did not reliably produce
  // equal arrows because Cytoscape's arrow rendering couples to the
  // edge width in non-linear ways; unifying the width removes that
  // coupling entirely.
  {
    selector: 'edge.verdict-blind-spot',
    style: {
      'line-color': '#c53030',
      'line-style': 'solid',
      'width': 2.5,
      'target-arrow-color': '#c53030',
      'source-arrow-color': '#c53030',
      'arrow-scale': 1.8,
    },
  },
  {
    selector: 'edge.verdict-borderline',
    style: {
      'line-color': '#dd6b20',
      'line-style': 'dashed',
      'width': 2.5,
      'target-arrow-color': '#dd6b20',
      'source-arrow-color': '#dd6b20',
      'arrow-scale': 1.8,
    },
  },
  {
    selector: 'edge.verdict-resolved-by-sp',
    style: {
      'line-color': '#2f855a',
      'line-style': 'dashed',
      'line-dash-pattern': [18, 4],
      'width': 2.5,
      'target-arrow-color': '#2f855a',
      'source-arrow-color': '#2f855a',
      'arrow-scale': 1.8,
    },
  },
  {
    selector: 'edge.verdict-no-cross-ao',
    style: {
      'line-color': '#a0aec0',
      'line-style': 'dotted',
      'width': 2.5,
      'target-arrow-color': '#a0aec0',
      'source-arrow-color': '#a0aec0',
      'arrow-scale': 1.8,
    },
  },
  {
    selector: 'edge.verdict-incomplete',
    style: {
      'line-color': '#cbd5e0',
      'line-style': 'dashed',
      'width': 2.5,
      'target-arrow-color': '#cbd5e0',
      'source-arrow-color': '#cbd5e0',
      'opacity': 0.7,
      'arrow-scale': 1.8,
    },
  },

  // --- Notes indicator (coexists with multi-tenant double border) ----
  // Node-level notes render via an OVERLAY ring (not the border). This
  // way a multi-tenant 3-tenant node with attached notes shows BOTH
  // the double border (multi-tenant coexistence) and the gold glow
  // (has notes) at the same time without one rule fighting the other
  // (UX agent 3 P1).
  {
    selector: 'node.has-notes',
    style: {
      'overlay-color': '#d69e2e',
      'overlay-opacity': 0.18,
      'overlay-padding': 6,
    },
  },
  {
    // Edge has-notes: place the "N" badge well clear of the arrow
    // area (source-text-offset 32) so it never occludes the source
    // or target arrow. At offset 14 the badge overlapped the source
    // arrow triangle and masked the direction indicator.
    selector: 'edge.has-notes',
    style: {
      'source-label': 'N',
      'source-text-offset': 32,
      'font-size': 9,
      'color': '#744210',
      'text-outline-color': '#fefcbf',
      'text-outline-width': 2,
    },
  },
];

export class Canvas {
  constructor(container, library) {
    this.container = container;
    this.library = library;
    this.mode = 'normal';
    this.pendingEdgeSource = null;
    this.pendingEdgeSourceFace = null;
    this.listeners = new Map();

    // Canvas-level metadata written by template loader / user action.
    this.domain = 'custom';
    this.evidenceLevel = 'custom';
    this.templateName = 'Custom architecture';
    this.templateDescription = '';
    this.templateSource = '';
    this.measurementPrerequisites = [];
    // Audit-trail review block. Only populated when the user explicitly
    // signs via the canvas UI. `artefact_hash` is NOT cached here - it
    // is recomputed on every PDF export so it always reflects the
    // current canvas state rather than a stale sign-time snapshot.
    this.review = null;
    // Scenario fork: a frozen snapshot taken by the user as a baseline
    // for "what changes if I do X?" exploration. When non-null, the
    // canvas is implicitly in "Scenario B" mode and the user can
    // request a verdict-diff between the fork (Scenario A) and the
    // current state via the Help modal.
    this.forkSnapshot = null;
    this.forkStampedAt = null;

    this.cy = cytoscape({
      container,
      elements: [],
      style: STYLE,
      minZoom: 0.2,
      maxZoom: 3,
      wheelSensitivity: 0.2,
      boxSelectionEnabled: true,
      autoungrabify: false,
      autounselectify: false,
    });

    this._bindCanvasEvents();
    this._bindChipDrop();
  }

  // ---- Verdict overlay (Stage D) ----
  applyVerdicts(report, skipped) {
    const verdictClasses =
      'verdict-blind-spot verdict-borderline verdict-resolved-by-sp verdict-no-cross-ao verdict-incomplete';
    this.cy.edges().removeClass(verdictClasses);
    if (report) {
      for (const r of report.results) {
        const edge = this.cy.getElementById(r.conduit_id);
        if (edge.empty()) continue;
        edge.addClass(`verdict-${r.verdict}`);
        edge.data('sc1', r.sc1);
        edge.data('nc1', r.nc1);
        edge.data('nc2', r.nc2);
        edge.data('verdict', r.verdict);
        edge.data('rationale', r.rationale);
        edge.data('mitigation', r.mitigation);
      }
    }
    if (Array.isArray(skipped)) {
      for (const s of skipped) {
        const edge = this.cy.getElementById(s.id);
        if (edge.empty()) continue;
        edge.addClass('verdict-incomplete');
        edge.data('verdict', 'incomplete');
        edge.data('rationale', s.reason);
      }
    }
  }

  clearVerdicts() {
    this.cy.edges().removeClass(
      'verdict-blind-spot verdict-borderline verdict-resolved-by-sp verdict-no-cross-ao verdict-incomplete',
    );
    this.cy.edges().forEach((e) => {
      e.removeData('sc1');
      e.removeData('nc1');
      e.removeData('nc2');
      e.removeData('verdict');
      e.removeData('rationale');
      e.removeData('mitigation');
    });
  }

  // ---- Notes (Stage D) ----
  setNotes(el, text) {
    const value = typeof text === 'string' ? text : '';
    el.data('notes', value);
    if (value.trim().length > 0) el.addClass('has-notes');
    else el.removeClass('has-notes');
    this._emit('graph-change', { action: 'notes', id: el.id() });
  }

  setSpCovered(edge, covered) {
    edge.data('spCovered', !!covered);
    this._emit('graph-change', { action: 'sp-covered', id: edge.id() });
  }

  setSpSubtype(edge, subtype) {
    // Valid values: 'integration' | 'maintenance' | 'both'. Default 'both'
    // is implied by the absence of the key; we write it explicitly when
    // the user picks to make the state visible in exports + snapshots.
    const allowed = new Set(['integration', 'maintenance', 'both']);
    const value = allowed.has(subtype) ? subtype : 'both';
    edge.data('spSubtype', value);
    this._emit('graph-change', { action: 'sp-subtype', id: edge.id() });
  }

  setDirected(edge, directed) {
    edge.data('directed', !!directed);
    // Keep the 3-state `direction` in sync so style selectors agree.
    edge.data('direction', directed ? 'one-way' : 'none');
    this._emit('graph-change', { action: 'toggle-dir', id: edge.id() });
  }

  /**
   * Four-state arrow direction:
   *   'none'     : no arrows
   *   'forward'  : target arrow only (source -> target)
   *   'reverse'  : source arrow only (target -> source)
   *   'two-way'  : arrows on both ends (bidirectional)
   *
   * Legacy 'one-way' is accepted as an alias for 'forward' so old
   * save files / templates keep rendering correctly.
   */
  setDirection(edge, direction) {
    const aliased = direction === 'one-way' ? 'forward' : direction;
    const allowed = new Set(['none', 'forward', 'reverse', 'two-way']);
    const value = allowed.has(aliased) ? aliased : 'none';
    edge.data('direction', value);
    edge.data('directed', value !== 'none');
    this._emit('graph-change', { action: 'set-direction', id: edge.id(), direction: value });
  }

  cycleDirection(edge) {
    const legacy = edge.data('direction') === 'one-way' ? 'forward' : edge.data('direction');
    const current = legacy ?? (edge.data('directed') ? 'forward' : 'none');
    const order = ['none', 'forward', 'reverse', 'two-way'];
    const next = order[(order.indexOf(current) + 1) % order.length];
    this.setDirection(edge, next);
  }

  setLabel(el, label) {
    el.data('label', label);
    if (el.isNode() && !el.hasClass('zone')) {
      this._updateDisplayLabel(el);
    }
    this._emit('graph-change', { action: 'rename', id: el.id() });
  }

  // Free-text secondary annotation rendered as a sub-line of the node's
  // on-canvas label. Mirrors the bracketed role/operator tags the paper
  // uses in Fig 2 (e.g. "APT HW / VND maint.", "3-tenant APT+VND+ALN").
  // Display-only; does NOT flow into the architecture YAML.
  setRoleContext(node, text) {
    if (node.hasClass('zone')) return;
    const value = typeof text === 'string' ? text : '';
    node.data('roleContext', value);
    this._updateDisplayLabel(node);
    this._emit('graph-change', { action: 'role-context', id: node.id() });
  }

  // Per-edge overrides that pick which owner of a multi-tenant endpoint
  // is on each end of the conduit. The paper's §4 biconditional
  // classifies conduits per specific (from-owner, to-owner) pair; when a
  // node carries >1 owner (e.g. 3-tenant CUPPS Workstation), the edge
  // must say which tenant's traffic it represents. Falls back to the
  // endpoint's first owner when unset.
  setEndpointOwner(edge, end, owner) {
    if (end !== 'source' && end !== 'target') return;
    const key = end === 'source' ? 'sourceOwner' : 'targetOwner';
    const value = typeof owner === 'string' && owner.length > 0 ? owner : null;
    if (value === null) edge.removeData(key);
    else edge.data(key, value);
    this._emit('graph-change', { action: 'endpoint-owner', id: edge.id(), end });
  }

  // Shows draggable handles for the currently-selected edge(s):
  //   - one bend handle at the midpoint (or current bend), drag to curve
  //   - two endpoint handles at source/target attachment points, drag
  //     along the node boundary to slide the attachment
  // On deselect the handles are removed so they never persist as
  // stray nodes.
  _syncEdgeHandle() {
    const selEdges = this.cy.$('edge:selected');
    const selSet = new Set(selEdges.map((e) => e.id()));
    this.cy.$('node.edge-bend-handle, node.edge-endpoint-handle').forEach((h) => {
      const parent = h.data('parentEdge');
      if (!selSet.has(parent)) h.remove();
    });
    selEdges.forEach((edge) => {
      const bendId = `__bend-${edge.id()}`;
      if (this.cy.getElementById(bendId).empty()) {
        const { midPoint } = computeBendAnchor(edge);
        this.cy.add({
          group: 'nodes',
          data: { id: bendId, parentEdge: edge.id() },
          classes: 'edge-bend-handle',
          position: midPoint,
          grabbable: true,
        });
      }
      const srcId = `__src-${edge.id()}`;
      if (this.cy.getElementById(srcId).empty()) {
        this.cy.add({
          group: 'nodes',
          data: { id: srcId, parentEdge: edge.id(), endpointRole: 'source' },
          classes: 'edge-endpoint-handle',
          position: computeEndpointAnchor(edge, 'source'),
          grabbable: true,
        });
      }
      const tgtId = `__tgt-${edge.id()}`;
      if (this.cy.getElementById(tgtId).empty()) {
        this.cy.add({
          group: 'nodes',
          data: { id: tgtId, parentEdge: edge.id(), endpointRole: 'target' },
          classes: 'edge-endpoint-handle',
          position: computeEndpointAnchor(edge, 'target'),
          grabbable: true,
        });
      }
    });
  }

  _refreshHandlesFor(edge) {
    if (!edge || edge.empty()) return;
    const bendH = this.cy.getElementById(`__bend-${edge.id()}`);
    const srcH  = this.cy.getElementById(`__src-${edge.id()}`);
    const tgtH  = this.cy.getElementById(`__tgt-${edge.id()}`);
    const a = computeEndpointAnchor(edge, 'source');
    const b = computeEndpointAnchor(edge, 'target');
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    if (!bendH.empty()) {
      const { midPoint } = computeBendAnchor(edge);
      bendH.position(midPoint);
      if (dist < 40) {
        bendH.style('z-index', 60);
      } else {
        bendH.style('z-index', 50);
      }
    }
    if (!srcH.empty()) srcH.position(a);
    if (!tgtH.empty()) tgtH.position(b);
  }

  _updateDisplayLabel(node) {
    const base = node.data('label') ?? '';
    const ctx = node.data('roleContext');
    if (ctx && String(ctx).trim().length > 0) {
      node.data('displayLabel', `${base}\n[${ctx}]`);
    } else {
      node.data('displayLabel', base);
    }
  }

  // Wipes the canvas back to an empty state. Used before loading a template.
  reset() {
    this.cy.elements().remove();
    this.domain = 'custom';
    this.evidenceLevel = 'custom';
    this.templateName = 'Custom architecture';
    this.templateDescription = '';
    this.templateSource = '';
    this.measurementPrerequisites = [];
    this.review = null;
    this.forkSnapshot = null;
    this.forkStampedAt = null;
    this.resetCounters();
    this._emit('graph-change', { action: 'reset' });
    this._emit('selection', null);
  }

  // ---- Event emitter ----
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  _emit(event, payload) {
    const set = this.listeners.get(event);
    if (set) for (const fn of set) fn(payload);
  }

  // ---- Mode machine ----
  setMode(mode) {
    this.mode = mode;
    this.container.classList.remove('mode-add-node', 'mode-connect');
    if (mode === 'add-node') this.container.classList.add('mode-add-node');
    if (mode === 'connect') this.container.classList.add('mode-connect');
    this.cy.$('.connect-source').removeClass('connect-source');
    this.pendingEdgeSource = null;
    this.pendingEdgeSourceFace = null;
    this._emit('mode', mode);
  }

  _bindCanvasEvents() {
    // Blank-canvas tap.
    this.cy.on('tap', (evt) => {
      if (evt.target !== this.cy) return;
      if (this.mode === 'add-node') {
        if (this.nodeCount() >= NODE_LIMIT) {
          this.setMode('normal');
          showStatus(`Node limit reached (${NODE_LIMIT}). Delete some nodes first.`);
          return;
        }
        this.addNodeAt(evt.position);
        this.setMode('normal');
        showStatus(`Node added. ${this.nodeCount()}/${NODE_LIMIT} nodes.`);
      } else if (this.mode === 'connect') {
        this.setMode('normal');
        showStatus('Connect cancelled.');
      } else {
        this._emit('selection', null);
      }
    });

    // Node tap.
    this.cy.on('tap', 'node', (evt) => {
      const node = evt.target;
      // Bend / endpoint handles are internal UI nodes; never treat
      // them as graph nodes (would create phantom edges from handle
      // to node in connect mode and pollute save files).
      if (node.hasClass('edge-bend-handle')) return;
      if (node.hasClass('edge-endpoint-handle')) return;
      if (node.hasClass('zone')) return;
      if (this.mode !== 'connect') return;

      // faceFromTap computes which side of the node was clicked so the
      // new edge attaches to that specific face (top/right/bottom/left)
      // via source-endpoint / target-endpoint styles. Matches the UX
      // spec: "click a side of source, click a side of target".
      const face = faceFromTap(node, evt.position);

      if (!this.pendingEdgeSource) {
        this.pendingEdgeSource = node;
        this.pendingEdgeSourceFace = face;
        node.addClass('connect-source');
        showStatus(
          `Source: ${node.data('label')} (${face}). Click the face of the target node.`,
        );
      } else if (this.pendingEdgeSource.id() === node.id()) {
        showStatus('Source and target must differ.');
      } else {
        this.addEdge(
          this.pendingEdgeSource.id(),
          node.id(),
          { sourceFace: this.pendingEdgeSourceFace, targetFace: face },
        );
        this.setMode('normal');
        showStatus('Edge created.');
      }
    });

    // Selection changes. Also show/hide the edge-bend handle so the
    // user can grab the midpoint and drag to curve the line.
    this.cy.on('select unselect', () => {
      this._emit('selection', this._currentSelection());
      this._syncEdgeHandle();
    });

    // Follow the bend handle during drag. Writes a single bezier
    // control-point (perpendicular distance d, weight t along the
    // source->target line) so the edge curves smoothly with an R-like
    // radius. When |d| drops below SNAP_STRAIGHT_PX the control point
    // is cleared and the edge snaps back to a clean straight line.
    const SNAP_STRAIGHT_PX = 12;
    this.cy.on('drag', 'node.edge-bend-handle', (evt) => {
      const handle = evt.target;
      const edgeId = handle.data('parentEdge');
      const edge = this.cy.getElementById(edgeId);
      if (!edge || edge.empty()) return;
      const a = computeEndpointAnchor(edge, 'source');
      const b = computeEndpointAnchor(edge, 'target');
      const p = handle.position();
      const { t, d } = projectPointOnLine(a, b, p);
      if (Math.abs(d) < SNAP_STRAIGHT_PX) {
        edge.removeData('controlPointDistances');
        edge.removeData('controlPointWeights');
        handle.position({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        return;
      }
      // The handle lives on the CURVE peak (half the distance to the
      // invisible control point). Double the projected d so the
      // stored control-point makes the curve peak land where the
      // cursor is.
      edge.data('controlPointDistances', [d * 2]);
      edge.data('controlPointWeights',   [Math.max(0.05, Math.min(0.95, t))]);
      this._refreshHandlesFor(edge);
    });
    this.cy.on('dragfree', 'node.edge-bend-handle', (evt) => {
      const edgeId = evt.target.data('parentEdge');
      this._emit('graph-change', { action: 'bend-edge', id: edgeId });
    });

    // Double-click to rename node/edge labels in-place (UX #9, P6).
    // Cytoscape emits 'dblclick' on 3.26+; 'dbltap' is the cross-input
    // alias also fired on touch. We bind both to stay safe.
    const renameOnDouble = (evt) => {
      const el = evt.target;
      if (!el || el === this.cy) return;
      if (el.isNode && el.isNode() && (el.hasClass('edge-bend-handle') || el.hasClass('edge-endpoint-handle'))) return;
      this.renameElement(el);
    };
    this.cy.on('dblclick', 'node, edge', renameOnDouble);
    this.cy.on('dbltap',   'node, edge', renameOnDouble);

    // Endpoint handle drag: slide the attachment point along the node
    // boundary. The handle is projected onto the closest edge of the
    // node's bounding box, expressed as a percentage offset from the
    // node centre, and written into a custom source/target endpoint
    // style on the edge. Clears sourceFace/targetFace since the 4-
    // cardinal snap is superseded by the free-position override.
    this.cy.on('drag', 'node.edge-endpoint-handle', (evt) => {
      const handle = evt.target;
      const edgeId = handle.data('parentEdge');
      const role = handle.data('endpointRole');
      const edge = this.cy.getElementById(edgeId);
      if (!edge || edge.empty()) return;
      const attached = role === 'source' ? edge.source() : edge.target();
      const ep = computeEndpointPercent(attached, handle.position());
      if (role === 'source') {
        edge.removeData('sourceFace');
        edge.data('sourceEndpoint', `${ep.x}% ${ep.y}%`);
        edge.style('source-endpoint', `${ep.x}% ${ep.y}%`);
      } else {
        edge.removeData('targetFace');
        edge.data('targetEndpoint', `${ep.x}% ${ep.y}%`);
        edge.style('target-endpoint', `${ep.x}% ${ep.y}%`);
      }
      // Snap the handle exactly onto the computed boundary point so
      // the user's cursor tracks the endpoint visually.
      const snapped = percentToAbsolute(attached, ep);
      handle.position(snapped);
      this._refreshHandlesFor(edge);
    });
    this.cy.on('dragfree', 'node.edge-endpoint-handle', (evt) => {
      const handle = evt.target;
      const edgeId = handle.data('parentEdge');
      const role   = handle.data('endpointRole');
      const edge   = this.cy.getElementById(edgeId);
      if (edge && !edge.empty()) {
        // If released over a DIFFERENT regular node, re-parent the
        // edge's endpoint to that node (UX agent 2 #3). Face/endpoint
        // overrides and any bezier are cleared so the re-pointed edge
        // starts from a clean anchor.
        const hit = this._topNodeAtPoint(handle.position(), false);
        const currentId = role === 'source' ? edge.source().id() : edge.target().id();
        if (hit && !hit.hasClass('edge-bend-handle') &&
            !hit.hasClass('edge-endpoint-handle') &&
            hit.id() !== currentId && hit.id() !== (role === 'source' ? edge.target().id() : edge.source().id())) {
          const patch = role === 'source' ? { source: hit.id() } : { target: hit.id() };
          edge.move(patch);
          edge.removeData(role === 'source' ? 'sourceFace' : 'targetFace');
          edge.removeData(role === 'source' ? 'sourceEndpoint' : 'targetEndpoint');
          edge.removeStyle(role === 'source' ? 'source-endpoint' : 'target-endpoint');
          showStatus(`Edge ${edge.id()} ${role} re-attached to ${hit.data('label') ?? hit.id()}.`);
        }
      }
      this._emit('graph-change', { action: 'move-endpoint', id: edgeId });
    });

    // When one of the attached nodes moves, refresh the edge's
    // handles AND scale any stored bezier control-point distance so
    // the curve keeps its proportional shape as the line length
    // changes (UX agent 2 #5). Without scaling the absolute pixel
    // offset would make the curve look increasingly flat or ballooned.
    this._lineLengthCache = new Map();
    const cacheLen = (edgeId, len) => this._lineLengthCache.set(edgeId, len);
    this.cy.on('grab', 'node', (evt) => {
      const node = evt.target;
      if (node.hasClass('edge-bend-handle') || node.hasClass('edge-endpoint-handle')) return;
      node.connectedEdges().forEach((e) => {
        const a = computeEndpointAnchor(e, 'source');
        const b = computeEndpointAnchor(e, 'target');
        cacheLen(e.id(), Math.hypot(b.x - a.x, b.y - a.y));
      });
    });
    this.cy.on('drag', 'node', (evt) => {
      const node = evt.target;
      if (node.hasClass('edge-bend-handle') || node.hasClass('edge-endpoint-handle')) return;
      node.connectedEdges().forEach((e) => {
        const cpd = e.data('controlPointDistances');
        const cpw = e.data('controlPointWeights');
        if (Array.isArray(cpd) && cpd.length > 0) {
          const a = computeEndpointAnchor(e, 'source');
          const b = computeEndpointAnchor(e, 'target');
          const newLen = Math.hypot(b.x - a.x, b.y - a.y);
          const oldLen = this._lineLengthCache.get(e.id()) ?? newLen;
          if (oldLen > 0 && newLen > 0) {
            const scale = newLen / oldLen;
            e.data('controlPointDistances', cpd.map((d) => d * scale));
            this._lineLengthCache.set(e.id(), newLen);
          }
        }
        this._refreshHandlesFor(e);
      });
    });

    // Reparent on drag-free: node inside zone bounding box -> become
    // child. When multiple zones contain the drop point, pick the
    // SMALLEST (deepest-containment) so overlapping zones produce a
    // deterministic parent (UX agent 3 P3).
    this.cy.on('dragfree', 'node', (evt) => {
      const node = evt.target;
      if (node.hasClass('zone')) return;
      if (node.hasClass('edge-bend-handle') || node.hasClass('edge-endpoint-handle')) return;
      const pos = node.position();
      const containers = [];
      this.cy.$('node.zone').forEach((z) => {
        const bb = z.boundingBox({ includeLabels: false });
        if (pos.x >= bb.x1 && pos.x <= bb.x2 && pos.y >= bb.y1 && pos.y <= bb.y2) {
          const area = (bb.x2 - bb.x1) * (bb.y2 - bb.y1);
          containers.push({ z, area });
        }
      });
      containers.sort((a, b) => a.area - b.area);
      const newParent = containers.length > 0 ? containers[0].z.id() : null;
      const current = node.parent().nonempty() ? node.parent().id() : null;
      if (newParent !== current) {
        node.move({ parent: newParent });
        this._emit('graph-change', { action: 'reparent', id: node.id(), parent: newParent });
      }
    });

    // Context menus.
    this.cy.on('cxttap', 'node', (evt) => {
      const node = evt.target;
      // Skip UI pseudo-nodes (bend/endpoint handles).
      if (node.hasClass('edge-bend-handle')) return;
      if (node.hasClass('edge-endpoint-handle')) return;
      const isZone = node.hasClass('zone');
      const items = [
        { label: 'Rename', action: () => this.renameElement(node) },
      ];
      if (!isZone) {
        items.push({
          label: 'Edit role context...',
          action: () => this.promptRoleContext(node),
        });
        items.push({
          label: 'Toggle multi-tenant border',
          action: () => this.setMultiTenantExplicit(node, !node.data('multiTenant')),
        });
      }
      items.push(null);
      items.push({ label: 'Delete', action: () => this.deleteElement(node) });
      const re = evt.originalEvent;
      showContextMenu(re.clientX, re.clientY, items);
    });

    this.cy.on('cxttap', 'edge', (evt) => {
      const edge = evt.target;
      const raw = edge.data('direction');
      const dir = raw === 'one-way' ? 'forward' : (raw ?? (edge.data('directed') ? 'forward' : 'none'));
      const DIR_LABEL = {
        'none':     'no arrows',
        'forward':  'source -> target',
        'reverse':  'target -> source',
        'two-way':  'both ways',
      };
      const NEXT = { 'none': 'forward', 'forward': 'reverse', 'reverse': 'two-way', 'two-way': 'none' };
      const items = [
        { label: 'Rename label', action: () => this.renameElement(edge) },
        {
          label: `Direction: ${DIR_LABEL[dir]} -> ${DIR_LABEL[NEXT[dir]]}`,
          action: () => this.cycleDirection(edge),
        },
      ];
      // Endpoint owner pickers appear only when the relevant endpoint
      // has >1 owner (single-owner nodes have no choice to make).
      const srcOwners = edge.source().data('owners') ?? [];
      const tgtOwners = edge.target().data('owners') ?? [];
      if (srcOwners.length > 1) {
        items.push({
          label: 'Pick source-endpoint owner...',
          action: () => this.promptEndpointOwner(edge, 'source'),
        });
      }
      if (tgtOwners.length > 1) {
        items.push({
          label: 'Pick target-endpoint owner...',
          action: () => this.promptEndpointOwner(edge, 'target'),
        });
      }
      items.push(null);
      items.push({ label: 'Delete', action: () => this.deleteElement(edge) });
      const re = evt.originalEvent;
      showContextMenu(re.clientX, re.clientY, items);
    });
  }

  _bindChipDrop() {
    const dom = this.container;
    dom.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('application/x-blindspot-chip')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    dom.addEventListener('drop', (e) => {
      const chipId = e.dataTransfer?.getData('application/x-blindspot-chip');
      if (!chipId) return;
      e.preventDefault();

      // Convert drop screen coords to cytoscape model coords.
      const bb = dom.getBoundingClientRect();
      const sx = e.clientX - bb.left;
      const sy = e.clientY - bb.top;
      const pan = this.cy.pan();
      const zoom = this.cy.zoom();
      const mx = (sx - pan.x) / zoom;
      const my = (sy - pan.y) / zoom;
      const point = { x: mx, y: my };

      // Prefer a non-zone node under the cursor (owner assign). If none,
      // try a zone (set zone authority).
      const nodeHit = this._topNodeAtPoint(point, false);
      if (nodeHit) {
        this.assignOwner(nodeHit, chipId);
        return;
      }
      const zoneHit = this._topNodeAtPoint(point, true);
      if (zoneHit) {
        this.setZoneAuthority(zoneHit, chipId);
        return;
      }
      showStatus('Drop a chip on a node (or zone) to assign it.');
    });
  }

  _topNodeAtPoint(point, zoneOnly) {
    const candidates = this.cy.nodes().filter((n) => {
      const isZone = n.hasClass('zone');
      if (zoneOnly !== isZone) return false;
      const bb = n.boundingBox({ includeLabels: false });
      return point.x >= bb.x1 && point.x <= bb.x2 && point.y >= bb.y1 && point.y <= bb.y2;
    });
    if (candidates.length === 0) return null;
    // Cytoscape returns elements in z-order; pick the topmost (last).
    return candidates[candidates.length - 1];
  }

  _currentSelection() {
    const selected = this.cy.$(':selected')
      .filter((el) => !el.hasClass('edge-bend-handle') && !el.hasClass('edge-endpoint-handle'));
    if (selected.length === 0) return null;
    if (selected.length > 1) return { type: 'multi', count: selected.length, elements: selected };
    const el = selected[0];
    if (el.isEdge()) return { type: 'edge', element: el };
    if (el.hasClass('zone')) return { type: 'zone', element: el };
    return { type: 'node', element: el };
  }

  // ---- CRUD ----
  addNodeAt(position) {
    const id = nextNodeId();
    const label = `Node ${_nodeCounter}`;
    const added = this.cy.add({
      group: 'nodes',
      data: {
        id,
        label,
        displayLabel: label,
        roleContext: '',
        owners: [],
        bgColor: '#e2e8f0',
        borderColor: '#a0aec0',
        multiTenant: false,
      },
      position: { x: position.x, y: position.y },
    });
    applyOwnerColors(added, [], this.library);
    this._emit('graph-change', { action: 'add-node', id });
    this._maybeWarnNearLimit();
    return id;
  }

  addEdge(sourceId, targetId, opts = {}) {
    // Self-loops are rejected at the API level: paper §4
    // biconditional requires two distinct endpoints to even enter the
    // SC-1 test. Accepting a self-loop silently would let an
    // adversarial or confused user inflate the NO_CROSS_AO bucket.
    if (sourceId === targetId) {
      showStatus('Self-loops are not allowed (source and target must differ).');
      return null;
    }
    const id = nextEdgeId();
    const data = {
      id,
      label: id,
      source: sourceId,
      target: targetId,
      directed: false,
      direction: 'none',
    };
    // Record which face of each endpoint the user clicked, so the
    // edge attaches visually to that side (source-endpoint /
    // target-endpoint styles). Optional - edges without a face fall
    // back to 'outside-to-node' auto-endpoint.
    if (opts.sourceFace && FACE_ENDPOINT[opts.sourceFace]) {
      data.sourceFace = opts.sourceFace;
    }
    if (opts.targetFace && FACE_ENDPOINT[opts.targetFace]) {
      data.targetFace = opts.targetFace;
    }
    this.cy.add({ group: 'edges', data });
    this._emit('graph-change', { action: 'add-edge', id });
    return id;
  }

  createZoneFromSelection(label) {
    const selected = this.cy.$('node:selected').filter((n) => !n.hasClass('zone'));
    if (selected.empty()) {
      showStatus('Select one or more nodes first, then click Group as Zone.');
      return null;
    }
    const id = nextZoneId();
    const zoneLabel = sanitizeText(label ?? `Zone ${_zoneCounter}`, 64);
    this.cy.add({
      group: 'nodes',
      data: {
        id,
        label: zoneLabel,
        zoneAuthority: null,
        borderColor: '#bee3f8',
      },
      classes: 'zone',
    });
    selected.move({ parent: id });
    this._emit('graph-change', { action: 'add-zone', id });
    showStatus(`Zone '${zoneLabel}' created. Drag a chip onto it to set authority.`);
    return id;
  }

  assignOwner(node, chipId) {
    const chip = this.library.getChip(chipId);
    if (!chip) {
      showStatus(`Unknown owner id: ${chipId}`);
      return;
    }
    const owners = Array.from(node.data('owners') ?? []);
    if (owners.includes(chipId)) {
      showStatus(`${node.data('label')} already has owner ${chipId}.`);
      return;
    }
    owners.push(chipId);
    node.data('owners', owners);
    applyOwnerColors(node, owners, this.library);
    // Respect a user-set explicit multiTenant flag. Only auto-derive
    // from owners count when the user hasn't manually pinned the flag
    // (UX agent 3 P8).
    if (node.data('multiTenantUserSet') !== true) {
      node.data('multiTenant', owners.length > 1);
    }
    this._emit('graph-change', { action: 'assign-owner', id: node.id(), owner: chipId });
    showStatus(`Owner ${chipId} assigned to ${node.data('label')}.`);
  }

  removeOwner(node, chipId) {
    const owners = (node.data('owners') ?? []).filter((o) => o !== chipId);
    node.data('owners', owners);
    applyOwnerColors(node, owners, this.library);
    // When all owners are gone, always clear multiTenant regardless
    // of user-set override (ghost double-border on empty node makes
    // no sense; UX agent 3 P17).
    if (owners.length === 0) {
      node.data('multiTenant', false);
      node.removeData('multiTenantUserSet');
    } else if (node.data('multiTenantUserSet') !== true) {
      node.data('multiTenant', owners.length > 1);
    }
    this._emit('graph-change', { action: 'remove-owner', id: node.id(), owner: chipId });
  }

  setMultiTenantExplicit(node, value) {
    node.data('multiTenant', !!value);
    node.data('multiTenantUserSet', true);
    this._emit('graph-change', { action: 'set-multi-tenant', id: node.id() });
  }

  setZoneAuthority(zone, chipId) {
    zone.data('zoneAuthority', chipId);
    const colors = this.library.colorsFor(chipId);
    zone.data('borderColor', colors.border);
    this._emit('graph-change', { action: 'set-zone-authority', id: zone.id(), authority: chipId });
    showStatus(`Zone authority '${chipId}' set on ${zone.data('label')}.`);
  }

  async renameElement(el) {
    const current = el.data('label') ?? '';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.maxLength = 64;
    input.setAttribute('aria-label', 'New label');
    const labelWrap = document.createElement('label');
    const t = document.createElement('span');
    t.textContent = 'New label';
    labelWrap.appendChild(t);
    labelWrap.appendChild(input);
    const sanitized = await showModal({
      title: 'Rename',
      confirmLabel: 'Save',
      bodyElements: [labelWrap],
      onConfirm: () => sanitizeText(input.value.trim(), 64) || null,
    });
    if (!sanitized) return;
    el.data('label', sanitized);
    if (el.isNode() && !el.hasClass('zone')) {
      this._updateDisplayLabel(el);
    }
    this._emit('graph-change', { action: 'rename', id: el.id() });
  }

  async promptRoleContext(node) {
    if (node.hasClass('zone')) return;
    const current = node.data('roleContext') ?? '';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.maxLength = 128;
    input.placeholder = 'e.g. APT HW / VND maint., 3-tenant APT+ALN';
    input.setAttribute('aria-label', 'Role context');
    const labelWrap = document.createElement('label');
    const t = document.createElement('span');
    t.textContent = 'Role context (paper Fig 2 style; blank to clear)';
    labelWrap.appendChild(t);
    labelWrap.appendChild(input);
    const result = await showModal({
      title: 'Edit role context',
      confirmLabel: 'Save',
      bodyElements: [labelWrap],
      onConfirm: () => sanitizeText(input.value.trim(), 128),
    });
    if (result === null || result === undefined) return;
    this.setRoleContext(node, result);
  }

  async promptEndpointOwner(edge, end) {
    const endpoint = end === 'source' ? edge.source() : edge.target();
    const owners = endpoint.data('owners') ?? [];
    if (owners.length === 0) {
      showStatus(`${endpoint.data('label')} has no owners yet. Drop a chip on it first.`);
      return;
    }
    const key = end === 'source' ? 'sourceOwner' : 'targetOwner';
    const current = edge.data(key) ?? owners[0];
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Owner at endpoint');
    for (const o of owners) {
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      if (o === current) opt.selected = true;
      select.appendChild(opt);
    }
    const labelWrap = document.createElement('label');
    const t = document.createElement('span');
    t.textContent = `Owner on the ${end} end`;
    labelWrap.appendChild(t);
    labelWrap.appendChild(select);
    const pick = await showModal({
      title: `Pick ${end}-endpoint owner`,
      confirmLabel: 'Set',
      cancelLabel: 'Clear override',
      bodyElements: [labelWrap],
      onConfirm: () => select.value,
    });
    if (pick === null || pick === undefined) {
      this.setEndpointOwner(edge, end, null);
      showStatus(`${end === 'source' ? 'Source' : 'Target'} override cleared.`);
      return;
    }
    this.setEndpointOwner(edge, end, pick);
    showStatus(`${end === 'source' ? 'Source' : 'Target'} owner set to ${pick}.`);
  }

  deleteElement(el) {
    const id = el.id();
    // Collect all orphan handles (bend + endpoints) that would be
    // left pointing at this edge (or any edge connected to this node)
    // before we remove it.
    const handleIds = [];
    if (el.isEdge()) {
      handleIds.push(`__bend-${id}`, `__src-${id}`, `__tgt-${id}`);
    } else {
      el.connectedEdges().forEach((e) => {
        handleIds.push(`__bend-${e.id()}`, `__src-${e.id()}`, `__tgt-${e.id()}`);
      });
    }
    el.remove();
    for (const hid of handleIds) {
      const h = this.cy.getElementById(hid);
      if (!h.empty()) h.remove();
    }
    this._emit('graph-change', { action: 'delete', id });
    this._emit('selection', null);
  }

  deleteSelected() {
    const sel = this.cy.$(':selected')
      .filter((el) => !el.hasClass('edge-bend-handle') && !el.hasClass('edge-endpoint-handle'));
    if (sel.empty()) {
      showStatus('Nothing selected.');
      return;
    }
    const ids = sel.map((e) => e.id());
    // Gather orphan handle ids before removing the underlying elements.
    const handleIds = [];
    sel.forEach((el) => {
      if (el.isEdge()) {
        handleIds.push(`__bend-${el.id()}`, `__src-${el.id()}`, `__tgt-${el.id()}`);
      } else if (!el.hasClass('zone')) {
        el.connectedEdges().forEach((e) => {
          handleIds.push(`__bend-${e.id()}`, `__src-${e.id()}`, `__tgt-${e.id()}`);
        });
      }
    });
    sel.remove();
    for (const hid of handleIds) {
      const h = this.cy.getElementById(hid);
      if (!h.empty()) h.remove();
    }
    this._emit('graph-change', { action: 'delete-many', ids });
    this._emit('selection', null);
    showStatus(`Deleted ${ids.length} item(s).`);
  }

  fit() {
    if (this.cy.elements().empty()) return;
    this.cy.fit(undefined, 40);
  }

  exportPng({ background = '#ffffff', scale = 2, full = true } = {}) {
    return this.cy.png({ output: 'blob', full, scale, bg: background });
  }

  nodeCount() {
    return this.cy.nodes()
      .filter((n) =>
        !n.hasClass('zone') &&
        !n.hasClass('edge-bend-handle') &&
        !n.hasClass('edge-endpoint-handle'),
      )
      .length;
  }

  _maybeWarnNearLimit() {
    const n = this.nodeCount();
    if (n >= NODE_LIMIT) {
      showStatus(`Node limit reached: ${n}/${NODE_LIMIT}.`);
    } else if (n >= NODE_WARN) {
      showStatus(`${n}/${NODE_LIMIT} nodes (approaching limit).`);
    }
  }

  /**
   * Reset the internal node counter used for auto-generated labels
   * ("Node N"). Called after a reset/load so fresh drawings start at
   * 1 instead of inheriting the previous session's counter - fixes
   * the UX complaint that labels show "Node 47" after churn (P14).
   */
  resetCounters() {
    _nodeCounter = 0;
    _edgeCounter = 0;
    _zoneCounter = 0;
  }
}
