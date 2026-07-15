/** UTC trading schedule — sleep outside configured windows. */

import type { ScheduleConfig, ScheduleWindowConfig } from './config.js';

export const WEEKDAY_NAMES = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

function utcNow(): Date {
  return new Date();
}

function normalizedWeekdays(weekdays: string[]): Set<string> {
  return new Set(
    weekdays
      .map((day) => String(day).toLowerCase().trim())
      .filter(Boolean),
  );
}

function timeMinutes(dt: Date): number {
  return dt.getUTCHours() * 60 + dt.getUTCMinutes();
}

function windowMinutes(window: ScheduleWindowConfig): [number, number] {
  return [
    window.start_hour * 60 + window.start_minute,
    window.end_hour * 60 + window.end_minute,
  ];
}

function windowStartOnDay(day: Date, window: ScheduleWindowConfig): Date {
  return new Date(
    Date.UTC(
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate(),
      window.start_hour,
      window.start_minute,
      0,
      0,
    ),
  );
}

/** True when `now` falls inside a configured weekday + time window (UTC). */
export function isTradingActive(now: Date, schedule: ScheduleConfig): boolean {
  if (!schedule.enabled) {
    return true;
  }
  const weekday = WEEKDAY_NAMES[now.getUTCDay() === 0 ? 6 : now.getUTCDay() - 1];
  if (!normalizedWeekdays(schedule.weekdays).has(weekday)) {
    return false;
  }
  const t = timeMinutes(now);
  for (const window of schedule.windows) {
    const [startM, endM] = windowMinutes(window);
    if (startM <= t && t < endM) {
      return true;
    }
  }
  return false;
}

/** Next UTC datetime when a configured trading window opens. */
export function nextWindowStart(now: Date, schedule: ScheduleConfig): Date {
  const allowed = normalizedWeekdays(schedule.weekdays);
  const dayBase = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  const candidates: Date[] = [];

  for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
    const day = new Date(dayBase.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const weekday = WEEKDAY_NAMES[day.getUTCDay() === 0 ? 6 : day.getUTCDay() - 1];
    if (!allowed.has(weekday)) {
      continue;
    }
    for (const window of schedule.windows) {
      const startAt = windowStartOnDay(day, window);
      if (startAt.getTime() > now.getTime()) {
        candidates.push(startAt);
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error('schedule has no upcoming trading windows');
  }
  return new Date(Math.min(...candidates.map((candidate) => candidate.getTime())));
}

/** e.g. '459 min remind to 09/06/26 Monday 4 AM UTC'. */
export function formatScheduleReminder(now: Date, nextStart: Date): string {
  const remainingS = Math.max(0, (nextStart.getTime() - now.getTime()) / 1000);
  const minutes = Math.floor(remainingS / 60);
  const datePart = [
    String(nextStart.getUTCDate()).padStart(2, '0'),
    String(nextStart.getUTCMonth() + 1).padStart(2, '0'),
    String(nextStart.getUTCFullYear()).slice(-2),
  ].join('/');

  const weekdayNames = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  const weekday = weekdayNames[nextStart.getUTCDay()] ?? 'Unknown';

  const hour = nextStart.getUTCHours();
  const minute = nextStart.getUTCMinutes();
  let h12: number;
  let ampm: 'AM' | 'PM';
  if (hour === 0) {
    h12 = 12;
    ampm = 'AM';
  } else if (hour < 12) {
    h12 = hour;
    ampm = 'AM';
  } else if (hour === 12) {
    h12 = 12;
    ampm = 'PM';
  } else {
    h12 = hour - 12;
    ampm = 'PM';
  }

  const timeStr =
    minute === 0 ? `${h12} ${ampm}` : `${h12}:${String(minute).padStart(2, '0')} ${ampm}`;
  return `${minutes} min remind to ${datePart} ${weekday} ${timeStr} UTC`;
}

export function describeSchedule(schedule: ScheduleConfig): string {
  if (!schedule.enabled) {
    return 'schedule=off (24/7)';
  }
  const days = schedule.weekdays.join(', ');
  const parts = schedule.windows.map(
    (window) =>
      `${String(window.start_hour).padStart(2, '0')}:${String(window.start_minute).padStart(2, '0')}` +
      `–${String(window.end_hour).padStart(2, '0')}:${String(window.end_minute).padStart(2, '0')}`,
  );
  return `schedule=on UTC days=[${days}] windows=[${parts.join('; ')}]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

/** Block (with periodic logs) until the next trading window opens. */
export async function waitForTradingWindow(schedule: ScheduleConfig): Promise<void> {
  if (!schedule.enabled || isTradingActive(utcNow(), schedule)) {
    return;
  }

  const logIntervalS = Math.max(1, Math.trunc(schedule.sleep_log_interval_min)) * 60;
  while (!isTradingActive(utcNow(), schedule)) {
    const now = utcNow();
    const nextStart = nextWindowStart(now, schedule);
    console.log(`[SCHEDULE] ${formatScheduleReminder(now, nextStart)}`);
    await sleep(logIntervalS * 1000);
  }
  console.log(`[SCHEDULE] trading window active at ${utcNow().toISOString()}`);
}
