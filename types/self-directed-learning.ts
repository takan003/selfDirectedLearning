/** 自主學習計畫：共用型別（client/server 皆可 import，不含伺服器端依賴） */

export const SELF_DIRECTED_LEARNING_SETTINGS_COLLECTION = "selfDirectedLearningSettings";
export const SELF_DIRECTED_LEARNING_SETTINGS_DOC_ID = "global";

export const WEEKDAY_LABELS = ["週一", "週二", "週三", "週四", "週五", "週六", "週日"] as const;

/** 審核人員（v1 手動輸入 uid＋名稱；uid 供 staff 端鑑權比對，v1.1 擬改帳號選擇器） */
export interface ReviewerEntry {
  uid: string;
  name: string;
}

/** 彈性學習節次行程：週幾（1=週一…7=週日）＋該日節次文字（如「第 5 節」） */
export interface FlexibleSlot {
  day: number;
  periods: string[];
}

/** selfDirectedLearningSettings/global 單文件設定 */
export interface SelfDirectedLearningSettings {
  /** 開放撰寫開始（epoch ms；null＝尚未設定） */
  openAt: number | null;
  /** 開放撰寫截止（epoch ms；null＝尚未設定） */
  closeAt: number | null;
  /** 方案可填寫週數上限（課綱 21/22 週，校方可調） */
  maxWeeks: number;
  /** 校內彈性學習節次行程 */
  slots: FlexibleSlot[];
  /** 開放場域 */
  venues: string[];
  /** 審核人員名單 */
  reviewers: ReviewerEntry[];
  /** 給學生的說明文字 */
  instructions: string;
  updatedAt: number;
}

export const DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS: SelfDirectedLearningSettings = {
  openAt: null,
  closeAt: null,
  maxWeeks: 22,
  slots: [],
  venues: [],
  reviewers: [],
  instructions: "",
  updatedAt: 0,
};

function asStringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLength));
}

function asEpoch(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** 讀 Firestore 原始資料後正規化（防欄位缺漏／型別損毀） */
export function normalizeSettings(raw: unknown): SelfDirectedLearningSettings {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const slots: FlexibleSlot[] = Array.isArray(source.slots)
    ? source.slots
        .map((item): FlexibleSlot | null => {
          if (!item || typeof item !== "object") return null;
          const slot = item as Record<string, unknown>;
          const day = typeof slot.day === "number" ? slot.day : NaN;
          if (!Number.isInteger(day) || day < 1 || day > 7) return null;
          return { day, periods: asStringArray(slot.periods, 20, 40) };
        })
        .filter((slot): slot is FlexibleSlot => slot !== null)
        .slice(0, 14)
    : [];
  const reviewers: ReviewerEntry[] = Array.isArray(source.reviewers)
    ? source.reviewers
        .map((item): ReviewerEntry | null => {
          if (!item || typeof item !== "object") return null;
          const reviewer = item as Record<string, unknown>;
          const uid = typeof reviewer.uid === "string" ? reviewer.uid.trim() : "";
          if (!uid) return null;
          const name = typeof reviewer.name === "string" ? reviewer.name.trim() : "";
          return { uid: uid.slice(0, 128), name: name.slice(0, 128) };
        })
        .filter((reviewer): reviewer is ReviewerEntry => reviewer !== null)
        .slice(0, 50)
    : [];
  const maxWeeks =
    typeof source.maxWeeks === "number" && Number.isInteger(source.maxWeeks)
      ? Math.min(Math.max(source.maxWeeks, 1), 52)
      : DEFAULT_SELF_DIRECTED_LEARNING_SETTINGS.maxWeeks;
  return {
    openAt: asEpoch(source.openAt),
    closeAt: asEpoch(source.closeAt),
    maxWeeks,
    slots,
    venues: asStringArray(source.venues, 60, 80),
    reviewers,
    instructions:
      typeof source.instructions === "string" ? source.instructions.slice(0, 4000) : "",
    updatedAt: typeof source.updatedAt === "number" ? source.updatedAt : 0,
  };
}

export type ParseResult = { ok: true; value: SelfDirectedLearningSettings } | { ok: false; message: string };

/** API 輸入驗證（POST body） */
export function parseSettingsInput(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object") return { ok: false, message: "請求內容格式錯誤" };
  const body = raw as Record<string, unknown>;
  const openAt = asEpoch(body.openAt);
  const closeAt = asEpoch(body.closeAt);
  if (body.openAt !== null && openAt === null) return { ok: false, message: "開放開始時間格式錯誤" };
  if (body.closeAt !== null && closeAt === null) return { ok: false, message: "開放截止時間格式錯誤" };
  if (openAt !== null && closeAt !== null && closeAt <= openAt) {
    return { ok: false, message: "截止時間必須晚於開始時間" };
  }
  const value = normalizeSettings(body);
  if (typeof body.maxWeeks === "number" && !Number.isInteger(body.maxWeeks)) {
    return { ok: false, message: "可填週數必須是整數" };
  }
  if (value.slots.length === 0 && value.maxWeeks < 1) {
    return { ok: false, message: "設定內容不合法" };
  }
  return { ok: true, value };
}

/** 開放狀態：closed（未設定或未開始）／open（開放中）／ended（已截止） */
export function openStateOf(
  settings: SelfDirectedLearningSettings,
  now: number = Date.now()
): "unset" | "closed" | "open" | "ended" {
  if (settings.openAt === null || settings.closeAt === null) return "unset";
  if (now < settings.openAt) return "closed";
  if (now > settings.closeAt) return "ended";
  return "open";
}
