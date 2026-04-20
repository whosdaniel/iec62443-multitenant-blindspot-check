// Multi-owner colour helper.
//
// Paints each node's background as a horizontal linear-gradient with
// one hard colour band per owner. Single-owner nodes resolve to a
// flat colour visually identical to `background-color`; multi-owner
// nodes show one equal-width stripe per owner so the reader sees at
// a glance "this asset has N AO identities".
//
// Kept in its own module so serialize.js can import it without
// pulling in canvas.js's top-level globalThis.cytoscape check, which
// blocks Node-side unit tests that exercise serialize.js without
// Cytoscape present.
//
// The helper only touches the Cytoscape node via its .data(key, value)
// API, so it's duck-typeable: tests pass simple objects that stub
// .data() and the same logic works end-to-end.

// Upper bound for distinct colour bands. Nodes with more owners than
// this fall back to showing the first MAX_BANDS owners as stripes;
// additional owners still appear in the text label. Five is plenty
// for the paper's reference architecture (CUPPS Workstation = 4).
export const MAX_BANDS = 5;

/**
 * Paint a node's background (bgColor + gradient data) from its current
 * owners list using the chip library's palette colours.
 *
 * Sets these data keys:
 *   - bgColor:        fallback solid colour (first owner's palette)
 *   - borderColor:    first owner's border colour
 *   - gradientColors: space-separated list of stripe colours for the
 *                     Cytoscape linear-gradient stop-colors style
 *   - gradientStops:  space-separated list of percentages for the
 *                     linear-gradient stop-positions style
 *
 * For hard colour bands we emit each colour twice (at the start and
 * end of its stripe), producing a step gradient:
 *   colors:  '#A #A #B #B #C #C'
 *   stops:   '0 33 33 67 67 100'
 *
 * @param {object} node     Cytoscape node (or test stub with .data()).
 * @param {string[]} owners Ordered list of owner ids on this node.
 * @param {object} library  ChipLibrary-shaped object exposing
 *                          colorsFor(id) -> {bg, border}.
 */
export function applyOwnerColors(node, owners, library) {
  const list = Array.isArray(owners) ? owners : [];

  if (list.length === 0) {
    node.data('bgColor', '#e2e8f0');
    node.data('borderColor', '#a0aec0');
    node.data('gradientColors', '#e2e8f0 #e2e8f0');
    node.data('gradientStops', '0 100');
    return;
  }

  const primary = library.colorsFor(list[0]);
  node.data('bgColor', primary.bg);
  node.data('borderColor', primary.border);

  if (list.length === 1) {
    node.data('gradientColors', `${primary.bg} ${primary.bg}`);
    node.data('gradientStops', '0 100');
    return;
  }

  // When owners exceed MAX_BANDS, reserve the LAST band for a hatched
  // grey overflow marker so the viewer sees there are more owners.
  const overflow = list.length > MAX_BANDS;
  const bands = overflow ? MAX_BANDS : list.length;
  const ownerBands = overflow ? MAX_BANDS - 1 : bands;
  const step = 100 / bands;
  const colors = [];
  const stops = [];
  for (let i = 0; i < ownerBands; i++) {
    const { bg } = library.colorsFor(list[i]);
    const start = Math.round(i * step);
    const end   = Math.round((i + 1) * step);
    colors.push(bg, bg);
    stops.push(String(start), String(end));
  }
  if (overflow) {
    const start = Math.round(ownerBands * step);
    const end   = 100;
    colors.push('#718096', '#718096');
    stops.push(String(start), String(end));
    node.data('overflowOwners', list.length - ownerBands);
  } else {
    node.removeData('overflowOwners');
  }
  node.data('gradientColors', colors.join(' '));
  node.data('gradientStops', stops.join(' '));
}
