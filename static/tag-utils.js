// Hashtags are canonical; keep legacy comma-separated, multi-word tags readable.
export function parseTags(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(String(value || '').includes('#') ? /[\s,#]+/u : /,/u);
  return [...new Set(source.map(tag => String(tag).trim().replace(/^#+/u, '').toLowerCase().slice(0, 24)).filter(Boolean))].slice(0, 8);
}

export function formatTags(value) {
  return parseTags(value).map(tag => '#' + tag.replace(/\s+/gu, '-')).join(' ');
}
