import "server-only";
import { getAdminDb } from "@/lib/firebase-admin";
import { getCurrentPeriod } from "@/lib/settings-server";
import {
  SELF_DIRECTED_LEARNING_PLANS_COLLECTION,
  SELF_DIRECTED_LEARNING_REVIEWS_COLLECTION,
  periodLabelOf,
  planDocIdOf,
  type PlanReview,
  type SelfDirectedLearningPlan,
  type SelfDirectedLearningSettings,
} from "../types/self-directed-learning";

function plansRef() {
  return getAdminDb().collection(SELF_DIRECTED_LEARNING_PLANS_COLLECTION);
}

/** 學生視角儀表資料 */
export interface StudentDashboard {
  period: string;
  plan: SelfDirectedLearningPlan | null;
  latestReview: PlanReview | null;
  /** 現在是否在開放撰寫期間 */
  withinWindow: boolean;
}

function readPlan(id: string, raw: Record<string, unknown>): SelfDirectedLearningPlan {
  const str = (value: unknown, fallback = "") =>
    typeof value === "string" ? value : fallback;
  const weeks = Array.isArray(raw.weeks)
    ? raw.weeks
        .map((item): SelfDirectedLearningPlan["weeks"][number] | null => {
          if (!item || typeof item !== "object") return null;
          const week = item as Record<string, unknown>;
          const weekNo = typeof week.week === "number" ? week.week : NaN;
          if (!Number.isInteger(weekNo) || weekNo < 1) return null;
          const timing = week.timing === "afterSchool" ? "afterSchool" : "flexible";
          return {
            week: weekNo,
            content: str(week.content),
            venue: str(week.venue),
            timing,
          };
        })
        .filter((week): week is NonNullable<typeof week> => week !== null)
        .sort((a, b) => a.week - b.week)
    : [];
  const status =
    raw.status === "submitted" || raw.status === "approved" || raw.status === "returned"
      ? raw.status
      : "draft";
  return {
    id,
    period: str(raw.period),
    studentUid: str(raw.studentUid),
    studentName: str(raw.studentName),
    grade: str(raw.grade),
    classCode: str(raw.classCode),
    className: str(raw.className),
    topic: str(raw.topic),
    studyGroup: str(raw.studyGroup),
    advisor: str(raw.advisor),
    weeks,
    status,
    submittedAt: typeof raw.submittedAt === "number" ? raw.submittedAt : null,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
  };
}

/** 讀當期學生計畫（精準點查，無快取需求） */
export async function getMyPlan(studentUid: string): Promise<SelfDirectedLearningPlan | null> {
  const period = periodLabelOf(await getCurrentPeriod());
  const id = planDocIdOf(period, studentUid);
  const snap = await plansRef().doc(id).get();
  if (!snap.exists) return null;
  return readPlan(id, (snap.data() || {}) as Record<string, unknown>);
}

/** 讀計畫的最新審查意見（where 精準條件＋本機排序，筆數有界） */
export async function getLatestReview(planId: string): Promise<PlanReview | null> {
  const snap = await getAdminDb()
    .collection(SELF_DIRECTED_LEARNING_REVIEWS_COLLECTION)
    .where("planId", "==", planId)
    .limit(20)
    .get();
  if (snap.empty) return null;
  const items = snap.docs.map((doc) => {
    const raw = (doc.data() || {}) as Record<string, unknown>;
    return {
      id: doc.id,
      planId: typeof raw.planId === "string" ? raw.planId : "",
      reviewerUid: typeof raw.reviewerUid === "string" ? raw.reviewerUid : "",
      reviewerName: typeof raw.reviewerName === "string" ? raw.reviewerName : "",
      decision: raw.decision === "returned" ? ("returned" as const) : ("approved" as const),
      note: typeof raw.note === "string" ? raw.note : "",
      reviewedAt: typeof raw.reviewedAt === "number" ? raw.reviewedAt : 0,
    };
  });
  items.sort((a, b) => b.reviewedAt - a.reviewedAt);
  return items[0] || null;
}

export interface StudentIdentityLite {
  uid: string;
  name: string;
  grade: string;
  classCode: string;
  className: string;
}

export type SaveAction = "save" | "submit";

export type SavePlanResult =
  | { ok: true; plan: SelfDirectedLearningPlan }
  | { ok: false; status: 400 | 409; message: string };

/**
 * 儲存草稿／送出審核。
 * save：任何時間可存（approved 鎖定不可改）；submit：僅開放期間內、狀態不得為 approved/submitted。
 */
export async function saveStudentPlan(input: {
  student: StudentIdentityLite;
  draft: {
    topic: string;
    studyGroup: string;
    advisor: string;
    weeks: SelfDirectedLearningPlan["weeks"];
  };
  action: SaveAction;
  settings: SelfDirectedLearningSettings;
  now?: number;
}): Promise<SavePlanResult> {
  const now = input.now ?? Date.now();
  const period = periodLabelOf(await getCurrentPeriod());
  const id = planDocIdOf(period, input.student.uid);
  const current = await getMyPlan(input.student.uid);

  if (current && current.status === "approved") {
    return { ok: false, status: 409, message: "計畫已通過審核，不可再修改" };
  }

  if (input.action === "submit") {
    const { openAt, closeAt } = input.settings;
    if (openAt === null || closeAt === null) {
      return { ok: false, status: 400, message: "學校尚未開放撰寫時間" };
    }
    if (now < openAt) return { ok: false, status: 400, message: "尚未到開放撰寫時間" };
    if (now > closeAt) return { ok: false, status: 400, message: "已超過開放撰寫期限" };
    if (current && current.status === "submitted") {
      return { ok: false, status: 409, message: "計畫審核中，請等待審查結果" };
    }
  }

  const next: SelfDirectedLearningPlan = {
    id,
    period,
    studentUid: input.student.uid,
    studentName: input.student.name,
    grade: input.student.grade,
    classCode: input.student.classCode,
    className: input.student.className,
    topic: input.draft.topic,
    studyGroup: input.draft.studyGroup,
    advisor: input.draft.advisor,
    weeks: input.draft.weeks,
    status: input.action === "submit" ? "submitted" : "draft",
    submittedAt: input.action === "submit" ? now : current?.submittedAt ?? null,
    updatedAt: now,
  };
  await plansRef().doc(id).set(next, { merge: true });
  return { ok: true, plan: next };
}
