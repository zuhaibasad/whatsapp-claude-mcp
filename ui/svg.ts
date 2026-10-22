// Safe insertion of the QR code SVG: parse, then rebuild with a strict element/attribute allowlist.
const SVG_NS = 'http://www.w3.org/2000/svg';
const ALLOWED_TAGS = new Set(['svg', 'path', 'rect']);
const ALLOWED_ATTRS = new Set([
  'viewBox', 'width', 'height', 'd', 'x', 'y', 'fill', 'stroke', 'fill-rule', 'shape-rendering', 'stroke-width', 'transform',
]);
const SAFE_VALUE = /^[\w\s.,\-#()]*$/; // numbers, colours, path data, viewBox; no url(), no quotes or scripts

function copy(src: Element, depth: number): Element | null {
  const tag = src.localName;
  if (!ALLOWED_TAGS.has(tag) || depth > 4) return null;
  const out = document.createElementNS(SVG_NS, tag);
  for (const a of Array.from(src.attributes)) {
    if (ALLOWED_ATTRS.has(a.name) && SAFE_VALUE.test(a.value) && !/url\s*\(/i.test(a.value)) out.setAttribute(a.name, a.value);
  }
  for (const child of Array.from(src.children)) {
    const c = copy(child, depth + 1);
    if (c) out.appendChild(c);
  }
  return out;
}

/** Returns a sanitised <svg> element, or null if the input is not usable SVG. */
export function safeSvg(markup: string): SVGElement | null {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || doc.querySelector('parsererror')) return null;
  const el = copy(root, 0);
  return el as SVGElement | null;
}
