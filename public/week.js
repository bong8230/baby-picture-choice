// ISO 8601 week id for the date's LOCAL calendar day, e.g. '2026-W48'.
export function isoWeek(date) {
  const t = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const d = new Date(t);
  const dow = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dow); // Thursday of this week
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
