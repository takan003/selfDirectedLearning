import "server-only";
import { getAdminDb } from "@/lib/firebase-admin";
import { cachedRead, invalidateReadCache } from "@/lib/read-cache";
import { getCacheTtlSeconds } from "@/lib/settings-server";
import {
  DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS,
  SELF_DIRECTED_LEARNING_SETTINGS_COLLECTION,
  SELF_DIRECTED_LEARNING_SETTINGS_DOC_ID,
  countWeeksBetween,
  normalizeSettings,
  type SelfDirectedLearningSettings,
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

/**
 * 全學期形式的須填週數：依主程式「學校基本設定 → 學期起訖設定」推算——
 * **優先上課日起訖**（實際授课期間，以週日～週六為一週、未滿七日仍計一週，
 * 台灣學校通常為 21 或 22 週），其次學期起訖、再次學年度起訖；
 * 學校尚未設定起訖時回 null。
 * 只讀主程式的 `settings/system` 日期欄位，不寫入。
 */
export async function getFullWeeks(): Promise<number | null> {
  return cachedRead(FULL_WEEKS_CACHE_KEY, await settingsTtlMs(), async () => {
    const snap = await getAdminDb().collection("settings").doc("system").get();
    const data = (snap.exists ? snap.data() : {}) as Record<string, unknown>;
    const str = (value: unknown) => (typeof value === "string" ? value : "");
    return (
      countWeeksBetween(str(data.classDayStart), str(data.classDayEnd)) ??
      countWeeksBetween(str(data.semesterStart), str(data.semesterEnd)) ??
      countWeeksBetween(str(data.academicYearStart), str(data.academicYearEnd))
    );
  });
}
