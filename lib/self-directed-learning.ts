import "server-only";
import { getAdminDb } from "@/lib/firebase-admin";
import { listCalendarEvents } from "@/lib/calendar";
import { getSchoolClassesSetting, getSchoolPeriodsSetting, getSchoolSpaceStructure } from "@/lib/module-host-data";
import { cachedRead, invalidateReadCache } from "@/lib/read-cache";
import { getCacheTtlSeconds, getCurrentPeriod, readSystemDoc } from "@/lib/settings-server";
import { isActiveEntry, loadPeriodEntries } from "@/lib/roster";
import {
  DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS,
  SELF_DIRECTED_LEARNING_SETTINGS_COLLECTION,
  SELF_DIRECTED_LEARNING_SETTINGS_DOC_ID,
  buildWeekSchedule,
  countWeeksBetween,
  normalizeSettings,
  type ClassOption,
  type FlexibleSlot,
  type PeriodOption,
  type RecordWindow,
  type SchoolActivityOccurrence,
  type SelfDirectedLearningSettings,
  type SpaceOption,
  type StaffCandidate,
  type WeekSchedule,
} from "../types/self-directed-learning";

const SETTINGS_CACHE_KEY = "selfDirectedLearning:settings";

async function settingsTtlMs(): Promise<number> {
  return (await getCacheTtlSeconds()) * 1000;
}

function settingsRef() {
  return getAdminDb()
    .collection(SELF_DIRECTED_LEARNING_SETTINGS_COLLECTION)
    .doc(SELF_DIRECTED_LEARNING_SETTINGS_DOC_ID);
}

/** 讀設定（缺檔即建預設值：lazy init） */
export async function getSettings(): Promise<SelfDirectedLearningSettings> {
  return cachedRead(SETTINGS_CACHE_KEY, await settingsTtlMs(), async () => {
    const snap = await settingsRef().get();
    if (!snap.exists) {
      const initial = { ...DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS, updatedAt: Date.now() };
      await settingsRef().set(initial);
      return initial;
    }
    return normalizeSettings(snap.data());
  });
}

/** 存設定（合併寫入＋失效快取） */
export async function saveSettings(
  value: SelfDirectedLearningSettings
): Promise<SelfDirectedLearningSettings> {
  const next: SelfDirectedLearningSettings = { ...value, updatedAt: Date.now() };
  await settingsRef().set(next, { merge: true });
  invalidateReadCache(SETTINGS_CACHE_KEY);
  return next;
}

const FULL_WEEKS_CACHE_KEY = "selfDirectedLearning:fullWeeks";
const SEMESTER_WINDOW_CACHE_KEY = "selfDirectedLearning:semesterWindow";

/** 學期起訖（`YYYY-MM-DD`），用於推算週次與逐週彈性學習時間 */
export interface SemesterWindow {
  start: string;
  end: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function pickWindow(
  data: Record<string, unknown>,
  startKey: string,
  endKey: string
): SemesterWindow | null {
  const start = typeof data[startKey] === "string" ? data[startKey].trim() : "";
  const end = typeof data[endKey] === "string" ? data[endKey].trim() : "";
  if (!DATE_PATTERN.test(start) || !DATE_PATTERN.test(end)) return null;
  return countWeeksBetween(start, end) === null ? null : { start, end };
}

/**
 * 學期起訖：依主程式「學校基本設定 → 學期起訖設定」推算——
 * **優先上課日起訖**，其次學期起訖、再次學年度起訖；皆未設定時回 null。
 * 只讀主程式的 `settings/system` 日期欄位，不寫入。
 */
export async function getSemesterWindow(): Promise<SemesterWindow | null> {
  return cachedRead(SEMESTER_WINDOW_CACHE_KEY, await settingsTtlMs(), async () => {
    const data = (await readSystemDoc()) ?? {};
    return (
      pickWindow(data, "classDayStart", "classDayEnd") ??
      pickWindow(data, "semesterStart", "semesterEnd") ??
      pickWindow(data, "academicYearStart", "academicYearEnd")
    );
  });
}

/**
 * 全學期形式的須填週數：依學期起訖推算（以週日～週六為一週、未滿七日仍計一週，
 * 台灣學校通常為 21 或 22 週）；學校尚未設定起訖時回 null。
 */
export async function getFullWeeks(): Promise<number | null> {
  const window = await getSemesterWindow();
  if (!window) return null;
  return cachedRead(FULL_WEEKS_CACHE_KEY, await settingsTtlMs(), async () =>
    countWeeksBetween(window.start, window.end)
  );
}

const PERIOD_OPTIONS_CACHE_KEY = "selfDirectedLearning:periodOptions";
const SPACE_OPTIONS_CACHE_KEY = "selfDirectedLearning:spaceOptions";
const SCHOOL_DAYS_CACHE_KEY = "selfDirectedLearning:schoolDays";
const STAFF_CANDIDATES_CACHE_KEY = "selfDirectedLearning:staffCandidates";

/** 學校作息：上課星期（1=週一…7=週日）與節次候選（只讀主程式課表作息） */
export interface SchoolScheduleOptions {
  /** 上課日的星期代碼（升冪；至少一天） */
  schoolDays: number[];
  /** 節次候選（作息表順序） */
  periods: PeriodOption[];
}

/** 學校作息候選：主程式「學校基本設定 → 課表作息時間」（文件缺漏時回內建預設） */
export async function getSchoolScheduleOptions(): Promise<SchoolScheduleOptions> {
  return cachedRead(PERIOD_OPTIONS_CACHE_KEY, await settingsTtlMs(), async () => {
    const setting = await getSchoolPeriodsSetting();
    return {
      schoolDays: [...setting.schoolDays],
      periods: setting.periods.map((row) => ({
        code: row.code,
        name: row.name,
        period: row.period,
        start: row.start,
        end: row.end,
      })),
    };
  });
}

/** 本地時區的該日零時（epoch ms）；格式錯誤回 0 */
function localDateMs(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const ms = new Date(year, month - 1, day).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 逐週彈性學習時間（日期／節次）與學校活動衝堂：學生端「撰寫計畫」表格用。
 * 節次行程取自模組設定，節次起訖取自主程式課表作息；
 * 衝堂只比對行事曆中「有學校活動層級且涵蓋該學生」的行程（可見性沿用學生身分）。
 */
export async function getWeekSchedule(
  grade: string,
  classCode: string
): Promise<WeekSchedule[]> {
  const window = await getSemesterWindow();
  if (!window) return [];
  const weeks = countWeeksBetween(window.start, window.end);
  if (!weeks) return [];

  const [settings, schedule] = await Promise.all([getSettings(), getSchoolScheduleOptions()]);
  const base = {
    semesterStart: window.start,
    semesterEnd: window.end,
    weeks,
    periods: schedule.periods,
    grade,
    classCode,
  };
  const occurrences =
    settings.slots.length === 0
      ? []
      : await loadSchoolActivityOccurrences(classCode, localDateMs(window.start));
  return buildWeekSchedule({ ...base, slots: settings.slots, events: occurrences });
}

/**
 * 逐週日期／節次（不做衝堂比對）：審核端逐週表格顯示用。
 * 只取決於學期起訖、節次行程與課表作息，與班級無關，整頁共用一份。
 */
export async function getWeekSlotSchedule(): Promise<WeekSchedule[]> {
  const window = await getSemesterWindow();
  if (!window) return [];
  const weeks = countWeeksBetween(window.start, window.end);
  if (!weeks) return [];
  const [settings, schedule] = await Promise.all([getSettings(), getSchoolScheduleOptions()]);
  return buildWeekSchedule({
    semesterStart: window.start,
    semesterEnd: window.end,
    weeks,
    periods: schedule.periods,
    grade: "",
    classCode: "",
    slots: settings.slots,
    events: [],
  });
}

/** 日期 + `HH:MM` → epoch ms；格式錯誤回 null */
function clockEndMs(date: string, clock: string): number | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) return null;
  const base = localDateMs(date);
  if (!base) return null;
  const [hour, minute] = clock.split(":").map(Number);
  const value = new Date(base);
  value.setHours(hour, minute, 0, 0);
  return value.getTime();
}

/** 該日 23:59:59.999（epoch ms）；格式錯誤回 0 */
function endOfDayMs(date: string): number {
  const base = localDateMs(date);
  if (!base) return 0;
  const value = new Date(base);
  value.setHours(23, 59, 59, 999);
  return value.getTime();
}

/**
 * 逐週「執行成果紀錄」開放時間：該週最後一個規劃時段（日期＋節次結束時間）之後才開放。
 * - 未設定節次行程（或課表作息缺該節次）時，以該週最後一天結束（週六 23:59）為準。
 * - 學期起訖未設定時回空陣列，學生端即顯示為無法填寫。
 */
export async function getRecordWindow(
  grade: string,
  classCode: string,
  weekSchedule?: WeekSchedule[]
): Promise<RecordWindow> {
  const [settings, schedule, weeks] = await Promise.all([
    getSettings(),
    getSchoolScheduleOptions(),
    weekSchedule ? Promise.resolve(weekSchedule) : getWeekSchedule(grade, classCode),
  ]);
  const endOfPeriod = new Map(schedule.periods.map((period) => [period.name, period.end]));
  const rows = weeks.map((week) => {
    let openAt = 0;
    for (const slot of week.slots) {
      for (const name of slot.periods) {
        const clock = endOfPeriod.get(name);
        if (!clock) continue;
        const ms = clockEndMs(slot.date, clock);
        if (ms !== null && ms > openAt) openAt = ms;
      }
    }
    if (openAt === 0) openAt = endOfDayMs(week.endDate);
    return { week: week.week, openAt, endAt: endOfDayMs(week.endDate) };
  });
  return { deadlineAt: settings.resultDeadlineAt, weeks: rows };
}

/** 讀取行事曆中「有學校活動層級」的行程，轉成衝堂比對用資料 */
async function loadSchoolActivityOccurrences(
  classCode: string,
  from: number
): Promise<SchoolActivityOccurrence[]> {
  const events = await listCalendarEvents({ role: "student", classCode, from });
  const occurrences: SchoolActivityOccurrence[] = [];
  for (const event of events) {
    const activity = event.schoolActivity;
    if (!activity) continue;
    if (!activity.school && activity.grades.length === 0) continue;
    occurrences.push({
      title: event.title,
      startAt: event.startAt,
      endAt: typeof event.endAt === "number" ? event.endAt : null,
      school: activity.school,
      grades: activity.grades.map((entry) => ({
        grade: entry.grade,
        classCodes: [...entry.classCodes],
      })),
    });
  }
  return occurrences;
}

/**
 * 管理端／學生端共用的可寫週數：以學校層級活動（全校）計算，
 * 供管理端驗證「下限週數」不可超過實際可寫週數。
 */
export async function getAvailableWeeks(
  slots: FlexibleSlot[]
): Promise<{ total: number; available: number } | null> {
  const window = await getSemesterWindow();
  if (!window) return null;
  const weeks = countWeeksBetween(window.start, window.end);
  if (!weeks) return null;
  const schedule = await getSchoolScheduleOptions();
  const occurrences =
    slots.length === 0
      ? []
      : await loadSchoolActivityOccurrences("", localDateMs(window.start));
  const rows = buildWeekSchedule({
    semesterStart: window.start,
    semesterEnd: window.end,
    weeks,
    slots,
    periods: schedule.periods,
    events: occurrences,
    grade: "",
    classCode: "",
  });
  return { total: weeks, available: rows.filter((row) => row.writable).length };
}

/** 場域候選清單：主程式「學校基本設定 → 樓層空間設定」的葉子空間（無下層者） */
export async function getSpaceOptions(): Promise<SpaceOption[]> {
  return cachedRead(SPACE_OPTIONS_CACHE_KEY, await settingsTtlMs(), async () => {
    const units = (await getSchoolSpaceStructure()).units;
    const hasChild = new Set(
      units.filter((unit) => unit.parent !== null).map((unit) => unit.parent as string)
    );
    return units
      .filter((unit) => !hasChild.has(unit.code) && unit.name)
      .map((unit) => ({ name: unit.name, floor: unit.floor }));
  });
}

const CLASS_OPTIONS_CACHE_KEY = "selfDirectedLearning:classOptions";

/** 班級候選：讀主程式「學校基本設定 → 年段班級設定」（settings/schoolClasses），單文件快取 */
export async function getClassOptions(): Promise<ClassOption[]> {
  return cachedRead(CLASS_OPTIONS_CACHE_KEY, await settingsTtlMs(), async () => {
    const setting = await getSchoolClassesSetting();
    const options: ClassOption[] = [];
    for (const grade of setting.grades) {
      const gradeName = grade.name.trim().slice(0, 20);
      for (const cls of grade.classes) {
        const code = cls.code.trim().slice(0, 20);
        if (!code) continue;
        options.push({
          code,
          name: cls.name.trim().slice(0, 40),
          grade: gradeName,
        });
        if (options.length >= 300) return options;
      }
    }
    return options;
  });
}

/** 當期教職員名冊候選人（有效條目，不依屬性過濾）；審核人員選擇用 */
export async function getStaffCandidates(): Promise<StaffCandidate[]> {
  return cachedRead(STAFF_CANDIDATES_CACHE_KEY, await settingsTtlMs(), async () => {
    const period = await getCurrentPeriod();
    const entries = await loadPeriodEntries(period, "staff");
    const list: StaffCandidate[] = [];
    for (const entry of entries.values()) {
      if (!isActiveEntry(entry)) continue;
      const uid = typeof entry.uid === "string" ? entry.uid : "";
      if (!uid) continue;
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      const attribute = typeof entry.attribute === "string" ? entry.attribute.trim() : "";
      list.push({ uid, name, attribute });
    }
    list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
    return list;
  });
}
