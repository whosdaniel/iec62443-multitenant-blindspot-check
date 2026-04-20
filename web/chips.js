// Owner chip library.
//
// A "chip" is the UI representation of an asset_owner entry. Dragging a
// chip onto a node assigns that owner. The library seeds 12 default
// chips spanning airport / rail / maritime / power personas; users can
// add custom chips via the "+ Add owner" button.
//
// Each chip maps to a palette name (see styles.css :root CSS variables
// --chip-<NAME>-bg / --chip-<NAME>-border). Colors are read at runtime so
// theming changes to the CSS propagate to canvas fills without JS edits.

import { ID_PATTERN, sanitizeText, showModal } from './ui.js';

export const DEFAULT_CHIPS = Object.freeze([
  // Airport family (Kim 2026 §4 reference architecture)
  { id: 'APT',      label: 'APT',      role: 'AO', palette: 'APT',    description: 'Airport operator (Platform Provider)' },
  { id: 'ALN',      label: 'ALN',      role: 'AO', palette: 'ALN',    description: 'Airline tenant (Application Provider)' },
  // Per-airline tenants so users can build paper-§4 aligned canvases
  // without first loading a template (UX agent 3 P9).
  { id: 'ALN-A',    label: 'ALN-A',    role: 'AO', palette: 'ALN-A',  description: 'Tenant airline A (Application Provider)' },
  { id: 'ALN-B',    label: 'ALN-B',    role: 'AO', palette: 'ALN-B',  description: 'Tenant airline B' },
  { id: 'ALN-C',    label: 'ALN-C',    role: 'AO', palette: 'ALN-C',  description: 'Tenant airline C' },
  { id: 'VND',      label: 'VND',      role: 'AO', palette: 'VND',    description: 'CUPPS vendor (Platform Operator)' },
  // Rail family (CLC/TS 50701)
  { id: 'IM',       label: 'IM',       role: 'AO', palette: 'IM',   description: 'Infrastructure Manager' },
  { id: 'TOC',      label: 'TOC',      role: 'AO', palette: 'TOC',  description: 'Train Operating Company' },
  { id: 'SSV',      label: 'SSV',      role: 'AO', palette: 'SSV',  description: 'Station Services Vendor' },
  // Maritime family (IACS UR E26/E27 + IMO MSC-FAL)
  { id: 'PortAuth', label: 'PortAuth', role: 'AO', palette: 'PORT', description: 'Port Authority' },
  { id: 'TermOp',   label: 'TermOp',   role: 'AO', palette: 'TERM', description: 'Terminal Operator' },
  { id: 'ShipLine', label: 'ShipLine', role: 'AO', palette: 'SHIP', description: 'Shipping Line' },
  // Power grid (IEC 62443-aligned but no published conduit map)
  { id: 'TSO',      label: 'TSO',      role: 'AO', palette: 'TSO',  description: 'Transmission System Operator' },
  { id: 'DSO',      label: 'DSO',      role: 'AO', palette: 'DSO',  description: 'Distribution System Operator' },
  { id: 'IPP',      label: 'IPP',      role: 'AO', palette: 'IPP',  description: 'Independent Power Producer' },
]);

const PALETTES = [
  'APT', 'ALN', 'VND',
  'IM', 'TOC', 'SSV',
  'PORT', 'TERM', 'SHIP',
  'TSO', 'DSO', 'IPP',
  'CUSTOM',
];

const ROLES = ['AO', 'SP', 'integrator', 'product_supplier'];

function paletteColors(name) {
  // CSS variables declared in styles.css :root. Reading on each call
  // picks up theme changes; the lookup is cheap so no memoisation.
  const style = getComputedStyle(document.documentElement);
  const bg = style.getPropertyValue(`--chip-${name}-bg`).trim();
  const border = style.getPropertyValue(`--chip-${name}-border`).trim();
  if (!bg || !border) {
    // Unknown palette: fall back to CUSTOM.
    return paletteColors('CUSTOM');
  }
  return { bg, border };
}

export class ChipLibrary {
  constructor(container, onChange) {
    this.container = container;
    this.onChange = onChange ?? (() => {});
    this.chips = DEFAULT_CHIPS.map((c) => ({ ...c }));
    this.render();
  }

  getChip(id) {
    return this.chips.find((c) => c.id === id);
  }

  /** True if `id` belongs to the bundled DEFAULT_CHIPS palette. */
  isDefault(id) {
    return DEFAULT_CHIPS.some((c) => c.id === id);
  }

  colorsFor(id) {
    const c = this.getChip(id);
    return paletteColors(c ? c.palette : 'CUSTOM');
  }

  /** Throws if the id is malformed or duplicates an existing chip id. */
  addChip(chip) {
    if (!ID_PATTERN.test(chip.id)) {
      throw new Error(`owner id must match ${ID_PATTERN}`);
    }
    if (this.chips.some((c) => c.id === chip.id)) {
      throw new Error(`owner id already exists: ${chip.id}`);
    }
    this.chips.push(chip);
    this.render();
    this.onChange('add', chip);
  }

  /**
   * Remove a chip. Optionally pass a `usageCheck(id)` callback that
   * returns the current usage count; the remove is refused if usage
   * is non-zero so the AO role on any node that references the chip
   * can't silently drift to the default 'AO' fallback (UX F-06).
   */
  removeChip(id, usageCheck) {
    if (typeof usageCheck === 'function' && usageCheck(id) > 0) {
      throw new Error(`owner '${id}' is still assigned to one or more nodes; remove those first`);
    }
    const idx = this.chips.findIndex((c) => c.id === id);
    if (idx === -1) return;
    const [removed] = this.chips.splice(idx, 1);
    this.render();
    this.onChange('remove', removed);
  }

  render() {
    this.container.replaceChildren();
    for (const chip of this.chips) {
      this.container.appendChild(this._renderChip(chip));
    }
  }

  _renderChip(chip) {
    const el = document.createElement('div');
    el.className = 'chip';
    el.setAttribute('role', 'listitem');
    el.setAttribute('draggable', 'true');
    el.setAttribute('tabindex', '0');
    el.dataset.chipId = chip.id;
    el.title = `${chip.description}\nrole: ${chip.role}\nDrag onto a node to assign; drag onto a zone to set zone authority.`;

    const swatch = document.createElement('span');
    swatch.className = 'chip-swatch';
    const colors = this.colorsFor(chip.id);
    swatch.style.backgroundColor = colors.bg;
    swatch.style.borderColor = colors.border;
    el.appendChild(swatch);

    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = chip.label;
    el.appendChild(label);

    const role = document.createElement('span');
    role.className = 'chip-role';
    role.textContent = chip.role;
    el.appendChild(role);

    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-blindspot-chip', chip.id);
      e.dataTransfer.effectAllowed = 'copy';
    });

    return el;
  }
}

/**
 * Modal dialog for creating a custom chip. Resolves with the new chip
 * object or null on cancel.
 */
export async function promptCustomChip(existingIds) {
  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.placeholder = 'e.g. MSSP-X';
  idInput.setAttribute('aria-label', 'Owner id');
  idInput.maxLength = 64;

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.placeholder = 'e.g. Managed Security Service Provider';
  labelInput.setAttribute('aria-label', 'Display label');
  labelInput.maxLength = 64;

  const roleSelect = document.createElement('select');
  roleSelect.setAttribute('aria-label', 'IEC 62443 role');
  for (const r of ROLES) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    roleSelect.appendChild(opt);
  }

  const paletteSelect = document.createElement('select');
  paletteSelect.setAttribute('aria-label', 'Color palette');
  for (const p of PALETTES) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    paletteSelect.appendChild(opt);
  }
  paletteSelect.value = 'CUSTOM';

  const errorMsg = document.createElement('div');
  errorMsg.className = 'muted';
  errorMsg.style.color = 'var(--color-danger)';

  const wrap = (labelText, el) => {
    const l = document.createElement('label');
    const t = document.createElement('span');
    t.textContent = labelText;
    l.appendChild(t);
    l.appendChild(el);
    return l;
  };

  return showModal({
    title: 'Add owner',
    confirmLabel: 'Add',
    bodyElements: [
      wrap('Owner id (matches YAML asset_owners.id)', idInput),
      wrap('Display label', labelInput),
      wrap('IEC 62443 role', roleSelect),
      wrap('Color palette', paletteSelect),
      errorMsg,
    ],
    onConfirm: () => {
      const id = sanitizeText(idInput.value.trim(), 64);
      const label = sanitizeText(labelInput.value.trim(), 64) || id;
      if (!ID_PATTERN.test(id)) {
        errorMsg.textContent =
          'Id must start with a letter and contain only [A-Za-z0-9_-], 1-64 chars.';
        return undefined;
      }
      if (existingIds.has(id)) {
        errorMsg.textContent = `Owner id '${id}' already exists.`;
        return undefined;
      }
      return {
        id,
        label,
        role: roleSelect.value,
        palette: paletteSelect.value,
        description: label,
      };
    },
  });
}
