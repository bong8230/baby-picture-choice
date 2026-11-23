const DAY_MS = 86_400_000;
const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;

// ISO 8601 week id for the date's LOCAL calendar day, e.g. '2026-W48'.
export function isoWeek(date) {
  const t = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const d = new Date(t);
  const dow = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dow); // Thursday of this week
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function thursdayOf(weekId) {
  const match = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/.exec(weekId);
  if (!match) return null;
  const [, year, week] = match;
  const day = new Date(`${year}-01-04T00:00:00Z`);
  const offset = 4 - (day.getUTCDay() || 7) + 7 * (Number(week) - 1);
  day.setUTCDate(day.getUTCDate() + offset);
  return day.getUTCFullYear() === Number(year) ? day : null;
}

function dateText(date) {
  return date.toISOString().slice(0, 10);
}

export function monthWeek(weekId) {
  const thursday = thursdayOf(weekId);
  if (!thursday) return null;
  return {
    year: thursday.getUTCFullYear(),
    month: thursday.getUTCMonth() + 1,
    nth: Math.ceil(thursday.getUTCDate() / 7),
  };
}

export function weekLabel(weekId) {
  const week = monthWeek(weekId);
  if (!week) return null;
  return `${week.year}년 ${week.month}월 ${week.nth}주차`;
}

export function weekFileLabel(weekId) {
  const week = monthWeek(weekId);
  if (!week) return null;
  return `${String(week.year).padStart(4, '0')}-${String(week.month).padStart(2, '0')}월${week.nth}주차`;
}

export function weekRange(weekId) {
  const thursday = thursdayOf(weekId);
  if (!thursday) return null;
  return {
    start: dateText(new Date(+thursday - 3 * DAY_MS)),
    end: dateText(new Date(+thursday + 3 * DAY_MS)),
  };
}

function calendarDateMs(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+date) && dateText(date) === value ? +date : null;
}

export function isCalendarDate(value) {
  return calendarDateMs(value) !== null;
}

export function babyDay(birthDate, date) {
  const birth = calendarDateMs(birthDate);
  if (birth === null || !(date instanceof Date) || !Number.isFinite(+date)) return null;
  const day = Math.floor((+date + SEOUL_OFFSET_MS) / DAY_MS) - birth / DAY_MS + 1;
  return day >= 1 ? day : null;
}

export function babyWeekText(birthDate, weekId) {
  const birth = calendarDateMs(birthDate);
  const thursday = thursdayOf(weekId);
  if (birth === null || !thursday) return null;
  const thursdayDay = (+thursday - birth) / DAY_MS + 1;
  const sunday = thursdayDay + 3;
  if (sunday < 1) return null;
  const monday = Math.max(1, sunday - 6);
  return `생후 ${monday}~${sunday}일 · ${Math.ceil(monday / 7)}주차`;
}

export function babyDayText(birthDate, takenAt) {
  if (!Number.isFinite(takenAt)) return null;
  const day = babyDay(birthDate, new Date(takenAt));
  return day === null ? null : `생후 ${day}일`;
}
