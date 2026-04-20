// Bundled starter templates. Each entry is a plain-data snapshot of a
// canvas state: owners (chip library additions), zones (compound nodes
// with authority), nodes (with owners + parent zone + position), edges
// (with optional directed/spCovered/notes), plus a meta block carrying
// name, domain, evidence_level, and paper citation.
//
// `meta.evidence_level`:
//   - "measured"            : reproduces a result directly observed in
//                             the paper's testbed (§4, §5). Banner green.
//   - "analytic-hypothesis" : structural mapping from public standards,
//                             NOT validated on a deployment (paper §8.1).
//                             Banner amber.
//   - "custom"              : empty / user-drawn. Banner grey.
//
// Positions are approximate and meant to give users a readable starting
// layout. Users can hit "Layout" to reflow, or drag to suit.

export const TEMPLATES = {
  'empty': {
    meta: {
      name: 'Empty canvas',
      domain: 'custom',
      evidence_level: 'custom',
      description: 'Start from scratch. Drag chips onto nodes and wire edges freely.',
      source: '',
    },
    owners: [],
    zones: [],
    nodes: [],
    edges: [],
  },

  'airport-cupps-1.0': {
    meta: {
      name: 'Airport CUPPS 1.0 (paper Fig 2 + Table 3)',
      domain: 'airport',
      evidence_level: 'measured',
      description:
        'The paper\'s reference architecture: a Common-Use Passenger Processing System shared by an airport operator (APT), a vendor (VND), and three airline tenants (ALN-A/B/C). Reproduces Table 3 verdicts - 3 structural blind spots (CD-06, CD-08a, CD-08b), 2 borderline federation conduits, 2 resolved-by-SP.',
      source: 'W. Kim 2026, Compliant Yet Blind - §3 Fig 2 + §4 Table 3.',
    },
    owners: [
      { id: 'APT',   role: 'AO', palette: 'APT',   label: 'APT',   description: 'Airport operator (Platform Provider per IATA RP 1797)' },
      // Per-airline palettes give each tenant a distinguishable pie-slice
      // colour on the 3-tenant CUPPS Workstation; without this the three
      // airlines would all resolve to the same teal and the pie would
      // read as one merged slice.
      { id: 'ALN-A', role: 'AO', palette: 'ALN-A', label: 'ALN-A', description: 'Tenant airline A (Application Provider)' },
      { id: 'ALN-B', role: 'AO', palette: 'ALN-B', label: 'ALN-B', description: 'Tenant airline B' },
      { id: 'ALN-C', role: 'AO', palette: 'ALN-C', label: 'ALN-C', description: 'Tenant airline C' },
      { id: 'VND',   role: 'AO', palette: 'VND',   label: 'VND',   description: 'CUPPS/BHS vendor (Platform Operator; AO of own asset class per paper §3)' },
    ],
    // Only the three APT-designated federation zones are declared - these
    // are what distinguish CD-04/CD-05 (borderline under single-IDP-
    // operator) from a plain cross-AO blind-spot. All other conduits
    // fall back to the SC-1 parity rule for NC-2 and do not need explicit
    // zone metadata (paper §4; evaluator.py::_evaluate_conduit).
    zones: [
      { id: 'VLAN-IDP-Fed-VND', label: 'Fed-VND (APT)', authority: 'APT' },
      { id: 'VLAN-IDP-Fed-ALN', label: 'Fed-ALN (APT)', authority: 'APT' },
      { id: 'VLAN-IDP',         label: 'IDP (APT)',     authority: 'APT' },
    ],
    // Fig 2 node positions: 4 columns (A BHS-lane, B CUPPS-center,
    // C Bldg-lane / CUPPS-MW, D ALN-lane) x 5 Purdue rows (L5 clouds,
    // L4 enterprise, L3 supervisory, L2 operations, L1 control) plus
    // a thin federation row between L5 and L4.
    //
    //   Cols: A=200   B=560   C=920   D=1320
    //   Rows: L5=80, Fed=300, L4=540, L3=780, L2=1020, L1=1260
    nodes: [
      // --- L5 (cloud tier) ------------------------------------------------
      // Fig 2 column alignment:
      //   col A = 200 (BHS lane: VND Cloud BHS, Airport IT, DMZ, BHS-WS, BHS-PLC)
      //   col B = 560 (CUPPS lane: VND Cloud CUPPS, IDP, NTP, CUPPS-WS, IDF-Switch)
      //   col C = 920 (MW lane:    CUPPS Middleware, Bldg Sys, EDS)
      //   col D = 1280 (ALN lane:  ALN Cloud, Airline DCS)
      // VND Cloud (CUPPS) lives in col B (same column as IDP below), NOT
      // col C - that was a mis-read of Fig 2 in an earlier iteration.
      // CD-09 therefore runs diagonally from col B (L5) to col C (L3).
      { id: 'vnd-cloud-bhs',   label: 'VND Cloud (BHS)',   owners: ['VND'],   roleContext: 'VND',                       x: 200,  y:  80 },
      { id: 'vnd-cloud-cupps', label: 'VND Cloud (CUPPS)', owners: ['VND'],   roleContext: 'VND',                       x: 560,  y:  80 },
      { id: 'aln-cloud',       label: 'ALN Cloud',         owners: ['ALN-A'], roleContext: 'ALN (indep. AO)',           x: 1280, y:  80 },

      // --- Federation tier (small clients between L5 and L4) --------------
      // vnd-fed sits directly below VND Cloud (CUPPS) (col B) so CD-04
      // renders as a short vertical line VND Cloud -> OIDC -> IDP.
      // aln-c-fed sits in col C so CD-05 is a visible diagonal into
      // IDP at col B without crossing the vertical CD-09 backbone.
      { id: 'vnd-fed',         label: 'VND OIDC client',   owners: ['VND'],   roleContext: 'VND (federation client)',   parent: 'VLAN-IDP-Fed-VND', x: 560,  y: 280 },
      { id: 'aln-c-fed',       label: 'ALN-C OIDC',        owners: ['ALN-C'], roleContext: 'ALN-C (federation client)', parent: 'VLAN-IDP-Fed-ALN', x: 920,  y: 280 },

      // --- L4 (enterprise tier) -------------------------------------------
      { id: 'airport-it',      label: 'Airport IT',        owners: ['APT'],   roleContext: 'APT (FIDS/AODB)',           x: 200,  y: 540 },
      { id: 'idp',             label: 'IDP',               owners: ['APT'],   roleContext: 'APT',                       parent: 'VLAN-IDP', x: 560, y: 540 },
      { id: 'airline-dcs',     label: 'Airline DCS',       owners: ['ALN-A'], roleContext: 'ALN, airline-owned',        x: 1320, y: 540 },

      // --- L3 (supervisory tier) ------------------------------------------
      { id: 'dmz-jump',        label: 'DMZ / Jump',        owners: ['APT'],        roleContext: 'APT HW / VND oper. (SP)', x: 200,  y: 780 },
      { id: 'ntp',             label: 'NTP',               owners: ['APT'],        roleContext: 'APT',                     x: 560,  y: 780 },
      // CUPPS MW: APT owns HW, VND is AO of middleware software. Not
      // tenant-coexistence - Fig 2 shows single border. Explicit
      // multiTenant:false keeps the double-border visual reserved for
      // true session coexistence (CUPPS Workstation).
      { id: 'cupps-mw',        label: 'CUPPS Middleware',  owners: ['APT', 'VND'], roleContext: 'VND oper. / APT HW',      multiTenant: false, x: 920,  y: 780 },

      // --- L2 (operations tier) -------------------------------------------
      { id: 'bhs-eng-ws',      label: 'BHS Eng WS',        owners: ['APT'], roleContext: 'APT HW / VND maint. (SP)', x: 200,  y: 1020 },
      // CUPPS Workstation: true multi-tenant coexistence per paper §3.
      // Owners = APT (HW) + three independent airline tenants. VND is
      // SP not AO on this asset, so it stays out of owners[].
      { id: 'cupps-ws',        label: 'CUPPS Workstation', owners: ['APT', 'ALN-A', 'ALN-B', 'ALN-C'], roleContext: '3-tenant APT+ALN (VND operates)', multiTenant: true, x: 560,  y: 1020 },
      { id: 'bldg-sys',        label: 'Bldg Sys',          owners: ['APT'], roleContext: 'APT',                      x: 920,  y: 1020 },

      // --- L1 (control/field tier) ----------------------------------------
      { id: 'bhs-plc',         label: 'BHS PLC x4',        owners: ['APT'], roleContext: 'APT HW / VND code (SP)',   x: 200,  y: 1260 },
      { id: 'idf-switch',      label: 'IDF Switch',        owners: ['APT'], roleContext: 'APT (ALN+VND traffic)',    x: 560,  y: 1260 },
      { id: 'eds',             label: 'EDS',               owners: ['APT'], roleContext: 'OOS / SSI',                x: 920,  y: 1260,
        notes: 'Explosive-detection subsystem. Excluded from evaluation per US 49 CFR Part 1520 (SSI).' },
    ],
    edges: [
      // Resolved-by-SP (2): VND is APT's SP for cloud config push + MW management (CD-01, CD-09)
      // CD-01 goes from VND Cloud (BHS) at L5 col A down to DMZ/Jump
      // at L3 col A. Exit the source on its right wall and enter the
      // target on its right wall so the edge leaves the col-A column
      // entirely; a single eastward bezier control point bulges the
      // curve further east to clear Airport IT's right edge. User can
      // drag the endpoint handles to move them along either node's
      // boundary, and the bend handle to change the curve radius.
      { id: 'CD-01',  source: 'vnd-cloud-bhs',   target: 'dmz-jump',    sourceOwner: 'VND',   targetOwner: 'APT',   spCovered: true, directed: true,
        sourceFace: 'right', targetFace: 'right',
        controlPointDistances: [-160],
        controlPointWeights:   [0.5],
        notes: 'VND is SP to APT per IEC 62443-2-4 SP.08.02 BR - obligations flow via the SP-AO contract.' },
      { id: 'CD-09',  source: 'vnd-cloud-cupps', target: 'cupps-mw',    sourceOwner: 'VND',   targetOwner: 'APT',   spCovered: true, directed: true,
        notes: 'Covered by VND -> APT SP-AO scope; management-plane for CUPPS MW.' },

      // Borderline (2): federation trust under single-IDP-operator (CD-04, CD-05)
      { id: 'CD-04',  source: 'vnd-fed',         target: 'idp',         sourceOwner: 'VND',   targetOwner: 'APT',   directed: true,
        notes: 'Federation trust: APT designates both Fed-VND and IDP zones (NC-2 fails). Transitions to blind-spot if airport/vendor move to independent IdPs.' },
      { id: 'CD-05',  source: 'aln-c-fed',       target: 'idp',         sourceOwner: 'ALN-C', targetOwner: 'APT',   directed: true,
        notes: 'Same federation pattern as CD-04; airline OIDC client inside APT-designated federation zone.' },

      // No-cross-AO (6): APT->APT or ALN-A->ALN-A (CD-02, CD-03, CD-07, CD-10, CD-11, CD-24)
      { id: 'CD-02',  source: 'dmz-jump',        target: 'bhs-eng-ws',  directed: true,
        notes: 'APT HW at both ends; VND under SP agreement for maintenance.' },
      { id: 'CD-03',  source: 'bhs-eng-ws',      target: 'bhs-plc',     directed: true,
        notes: 'APT HW at both ends; VND-supplied PLC code under SP agreement.' },
      { id: 'CD-07',  source: 'bhs-plc',         target: 'idf-switch',  directed: true,
        notes: 'APT HW at both ends.' },
      { id: 'CD-10',  source: 'ntp',             target: 'cupps-ws',    targetOwner: 'APT',   directed: true,
        notes: 'APT-operated NTP utility reaching the thin client at the HW layer (not a tenant session path).' },
      { id: 'CD-11',  source: 'dmz-jump',        target: 'idf-switch',  directed: true,
        notes: 'APT-owned path at both endpoints; internal APT-VND SP interaction.' },
      { id: 'CD-24',  source: 'aln-cloud',       target: 'airline-dcs', directed: true,
        notes: 'Airline-internal cloud path (same AO at both ends).' },

      // Structural blind spots (3): CD-06 latent, CD-08a active, CD-08b active
      { id: 'CD-06',  source: 'cupps-ws',        target: 'idf-switch',  sourceOwner: 'ALN-B', targetOwner: 'APT',   directed: true,
        notes: 'LATENT: ALN-B tenant session traversing APT-designated IDF switch. Zero safety margin if VLAN boundary degrades through misconfiguration or firmware regression.' },
      { id: 'CD-08a', source: 'cupps-ws',        target: 'cupps-mw',    sourceOwner: 'ALN-A', targetOwner: 'VND',   directed: true,
        notes: 'ACTIVE: 3-tenant thin-client session heartbeat from ALN-A to VND middleware.' },
      { id: 'CD-08b', source: 'cupps-mw',        target: 'airline-dcs', sourceOwner: 'VND',   targetOwner: 'ALN-A', directed: true,
        notes: 'ACTIVE: PP/AP seam per IATA RP 1797. ALN is independent Application Provider, NOT VND\'s SP - IEC 62443-2-4 inapplicable.' },
    ],
  },

  // NOTE: CUPPS 2.0 variants (paper §8.2 Limitation 6) are deliberately not
  // bundled as templates. The paper defers their classification to §8.3 future
  // work, so shipping templates for them would amount to a tool-level claim
  // the paper does not yet make. Rail/maritime/power templates below ARE
  // bundled because paper §8.1 explicitly states the analytic hypothesis
  // on its own terms; CUPPS 2.0 does not.

  'rail-passenger-station': {
    meta: {
      name: 'Rail passenger station (multi-TOC)',
      domain: 'rail',
      evidence_level: 'analytic-hypothesis',
      description:
        'Infrastructure Manager (IM) owns the station fabric; multiple Train Operating Companies (TOCs) run their own DCS-equivalent systems over it. Paper §8.1 predicts the same structural blind-spot pattern - not empirically validated.',
      source: 'W. Kim 2026, Compliant Yet Blind - §8.1 (cross-domain).',
      measurement_prerequisites: [
        'Access to a multi-TOC passenger station with independent TOC IT networks transiting the IM-owned station LAN (EU liberalised-market hub).',
        'Documented contract structure confirming each TOC runs an independent SOC or MSSP with no SP-AO relationship to the IM.',
        'A controlled attack scenario analogous to paper §5 Sc-1: TOC-to-TOC lateral movement via a shared service (PID cluster or ticketing ledger), with pcap captured at the IM LAN boundary.',
        'Classification reviewed against CENELEC CLC/TS 50701 zone/conduit scope clauses and the TS 50701 inheritance of IEC 62443-2-4 SP roles.',
      ],
    },
    owners: [
      { id: 'IM',    role: 'AO', palette: 'IM',  label: 'IM' },
      { id: 'TOC-A', role: 'AO', palette: 'TOC', label: 'TOC-A' },
      { id: 'TOC-B', role: 'AO', palette: 'TOC', label: 'TOC-B' },
      { id: 'SSV',   role: 'AO', palette: 'SSV', label: 'SSV' },
    ],
    zones: [
      { id: 'ZONE-IM-LAN',      label: 'ZONE-IM-LAN',      authority: 'IM' },
      { id: 'ZONE-TOC-A-INTRA', label: 'ZONE-TOC-A-INTRA', authority: 'TOC-A' },
      { id: 'ZONE-TOC-B-INTRA', label: 'ZONE-TOC-B-INTRA', authority: 'TOC-B' },
      { id: 'ZONE-SSV-MW',      label: 'ZONE-SSV-MW',      authority: 'SSV' },
    ],
    nodes: [
      { id: 'pid-cluster', label: 'PID display cluster',     owners: ['IM'],    parent: 'ZONE-IM-LAN',      x: 300, y: 200 },
      { id: 'ledger',      label: 'Station ticket ledger',   owners: ['IM'],    parent: 'ZONE-IM-LAN',      x: 500, y: 200 },
      { id: 'toc-a-sched', label: 'TOC-A scheduler',         owners: ['TOC-A'], parent: 'ZONE-TOC-A-INTRA', x: 100, y: 320 },
      { id: 'toc-a-tick',  label: 'TOC-A ticketing',         owners: ['TOC-A'], parent: 'ZONE-TOC-A-INTRA', x: 100, y: 380 },
      { id: 'toc-b-sched', label: 'TOC-B scheduler',         owners: ['TOC-B'], parent: 'ZONE-TOC-B-INTRA', x: 700, y: 320 },
      { id: 'toc-b-tick',  label: 'TOC-B ticketing',         owners: ['TOC-B'], parent: 'ZONE-TOC-B-INTRA', x: 700, y: 380 },
      { id: 'ssv-mw',      label: 'SSV middleware',          owners: ['SSV'],   parent: 'ZONE-SSV-MW',      x: 400, y:  80 },
    ],
    edges: [
      { id: 'CD-TOC-A-PID',  source: 'toc-a-sched', target: 'pid-cluster', directed: true,
        notes: 'Cross-AO; IM is not TOC-A service provider.' },
      { id: 'CD-TOC-B-PID',  source: 'toc-b-sched', target: 'pid-cluster', directed: true },
      { id: 'CD-TOC-A-TICK', source: 'toc-a-tick',  target: 'ledger',      directed: true },
      { id: 'CD-TOC-B-TICK', source: 'toc-b-tick',  target: 'ledger',      directed: true },
      { id: 'CD-SSV-PID',    source: 'ssv-mw',      target: 'pid-cluster', spCovered: true, directed: true,
        notes: 'SSV operates PID under IM contract (SP-AO).' },
    ],
  },

  'maritime-container-terminal': {
    meta: {
      name: 'Maritime container terminal',
      domain: 'maritime',
      evidence_level: 'analytic-hypothesis',
      description:
        'Port Authority, Terminal Operator, and Shipping Lines share the port IT fabric. UR E26/E27 cover ships; MSC-FAL.1/Circ.3 covers ship-side risk; neither addresses the port-terminal seam (paper §8.1).',
      source: 'W. Kim 2026, Compliant Yet Blind - §8.1 (cross-domain).',
      measurement_prerequisites: [
        'Access to a container terminal with a Port Authority, a distinct Terminal Operator under contract, and multiple Shipping Lines connecting their on-shore back-office systems to the Terminal Operating System.',
        'Documented absence of an SP-AO relationship between the Port Authority and each Shipping Line (they are co-equal asset owners on the port fabric).',
        'A controlled attack scenario: supply-chain compromise of a Shipping Line back office propagating to TOS (paper §5 Sc-1 analogue), pcap captured at port LAN + PCS ingress.',
        'Classification reviewed against IACS UR E26 / E27 scope (ship-level vs port-terminal seam) and IMO MSC-FAL.1/Circ.3.',
      ],
    },
    owners: [
      { id: 'PortAuth',   role: 'AO', palette: 'PORT', label: 'PortAuth' },
      { id: 'TermOp',     role: 'AO', palette: 'TERM', label: 'TermOp' },
      { id: 'ShipLine-A', role: 'AO', palette: 'SHIP', label: 'ShipLine-A' },
      { id: 'ShipLine-B', role: 'AO', palette: 'SHIP', label: 'ShipLine-B' },
    ],
    zones: [
      { id: 'ZONE-PORT-PCS',  label: 'ZONE-PORT-PCS',  authority: 'PortAuth' },
      { id: 'ZONE-TERM-TOS',  label: 'ZONE-TERM-TOS',  authority: 'TermOp' },
      { id: 'ZONE-SHIP-A-BO', label: 'ZONE-SHIP-A-BO', authority: 'ShipLine-A' },
      { id: 'ZONE-SHIP-B-BO', label: 'ZONE-SHIP-B-BO', authority: 'ShipLine-B' },
    ],
    nodes: [
      { id: 'pcs',       label: 'Port Community System', owners: ['PortAuth'],   parent: 'ZONE-PORT-PCS',  x: 400, y: 120 },
      { id: 'tos',       label: 'Terminal OS',           owners: ['TermOp'],     parent: 'ZONE-TERM-TOS',  x: 400, y: 300 },
      { id: 'ship-a-bo', label: 'ShipLine-A back office', owners: ['ShipLine-A'], parent: 'ZONE-SHIP-A-BO', x: 150, y: 440 },
      { id: 'ship-b-bo', label: 'ShipLine-B back office', owners: ['ShipLine-B'], parent: 'ZONE-SHIP-B-BO', x: 650, y: 440 },
    ],
    edges: [
      { id: 'CD-SHIP-A-STOW', source: 'ship-a-bo', target: 'tos', directed: true,
        notes: 'Cross-AO stowage-plan push; no SP-AO relationship.' },
      { id: 'CD-SHIP-B-STOW', source: 'ship-b-bo', target: 'tos', directed: true },
      { id: 'CD-SHIP-A-PCS',  source: 'ship-a-bo', target: 'pcs', directed: true },
      { id: 'CD-TOS-PCS',     source: 'tos',       target: 'pcs', spCovered: true, directed: true,
        notes: 'TermOp operates under PortAuth contract (SP-AO).' },
    ],
  },

  'power-grid-tso-dso': {
    meta: {
      name: 'Power grid TSO/DSO interface',
      domain: 'power-grid',
      evidence_level: 'analytic-hypothesis',
      description:
        'Shared substations where a TSO interfaces with one or more DSOs and Independent Power Producers. IEC 62443-aligned treatment exists in IEC 62351 for power systems communications, but the multi-owner substation seam has no designated monitoring authority in the standard (paper §8.1).',
      source: 'W. Kim 2026, Compliant Yet Blind - §8.1 (cross-domain).',
      measurement_prerequisites: [
        'Access to a shared substation where a TSO, one or more DSOs, and at least one IPP each operate network equipment on a common substation bus.',
        'Confirmed absence of SP-AO contracts between the TSO and DSO / IPP parties for substation-bus monitoring (they are co-equal asset owners, not acquirer/supplier).',
        'Attack scenario: IPP-to-TSO telemetry abuse or DSO RTU compromise propagating onto the substation bus, pcap captured at the TSO SCADA ingress.',
        'Classification reviewed against NERC CIP-005 (Electronic Security Perimeters) and IEC 62351 scope; verify that neither framework designates a monitoring authority for the multi-owner substation bus.',
      ],
    },
    owners: [
      { id: 'TSO', role: 'AO', palette: 'TSO', label: 'TSO' },
      { id: 'DSO', role: 'AO', palette: 'DSO', label: 'DSO' },
      { id: 'IPP', role: 'AO', palette: 'IPP', label: 'IPP' },
    ],
    zones: [
      { id: 'ZONE-SUBSTATION-BUS', label: 'Substation bus', authority: 'TSO' },
      { id: 'ZONE-DSO-RTU',        label: 'DSO RTU',        authority: 'DSO' },
      { id: 'ZONE-IPP-GATEWAY',    label: 'IPP gateway',    authority: 'IPP' },
    ],
    nodes: [
      { id: 'tso-scada',   label: 'TSO SCADA',   owners: ['TSO'], parent: 'ZONE-SUBSTATION-BUS', x: 400, y: 200 },
      { id: 'tso-hmi',     label: 'TSO HMI',     owners: ['TSO'], parent: 'ZONE-SUBSTATION-BUS', x: 560, y: 200 },
      { id: 'dso-rtu',     label: 'DSO RTU',     owners: ['DSO'], parent: 'ZONE-DSO-RTU',        x: 160, y: 360 },
      { id: 'dso-backend', label: 'DSO backend', owners: ['DSO'], parent: 'ZONE-DSO-RTU',        x: 160, y: 500 },
      { id: 'ipp-gw',      label: 'IPP gateway', owners: ['IPP'], parent: 'ZONE-IPP-GATEWAY',    x: 640, y: 360 },
      { id: 'ipp-ems',     label: 'IPP EMS',     owners: ['IPP'], parent: 'ZONE-IPP-GATEWAY',    x: 800, y: 360 },
    ],
    edges: [
      { id: 'CD-DSO-TSO', source: 'dso-rtu', target: 'tso-scada', directed: true,
        notes: 'Cross-AO telemetry at substation bus; no SP-AO relationship between TSO and DSO.' },
      { id: 'CD-IPP-TSO', source: 'ipp-gw',  target: 'tso-scada', directed: true,
        notes: 'Cross-AO interconnect; IPP is independent asset owner.' },
      // Intra-AO internals so the distribution is not 2/2 blind-spot
      // (UX agent 1 F-11). Paper §8.1 frames this as structural-pattern
      // prediction, not a population claim.
      { id: 'CD-TSO-INT', source: 'tso-scada', target: 'tso-hmi',      directed: true,
        notes: 'TSO-internal operator workstation link (single-AO).' },
      { id: 'CD-DSO-INT', source: 'dso-rtu',   target: 'dso-backend',  directed: true,
        notes: 'DSO-internal backend poll (single-AO).' },
      { id: 'CD-IPP-INT', source: 'ipp-gw',    target: 'ipp-ems',      directed: true,
        notes: 'IPP-internal EMS link (single-AO).' },
    ],
  },
};

/** Ordered list of template ids used to render the selection modal. */
export const TEMPLATE_ORDER = [
  'empty',
  'airport-cupps-1.0',
  'rail-passenger-station',
  'maritime-container-terminal',
  'power-grid-tso-dso',
];
