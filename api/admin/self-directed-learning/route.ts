import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { getSettings, saveSettings } from "../../../lib/self-directed-learning";
import { parseSettingsInput } from "../../../types/self-directed-learning";

const noStore = { "Cache-Control": "no-store" };

/** 主程式的 serverErrorMessage 等價小工具（模組不得依賴非公開面檔案 `@/lib/api-error`） */
function errorMessage(error: unknown, fallback: string): string {
  if (process.env.NODE_ENV !== "production" && error instanceof Error) return error.message;
  return fallback;
}

/** GET：回傳設定（含 lazy init 預設值） */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "self-directed-learning-admin",
      RATE.SELF_DIRECTED_LEARNING_ADMIN.limit,
      RATE.SELF_DIRECTED_LEARNING_ADMIN.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("selfDirectedLearning");
    if (denial) return toAuthResponse(denial);

    const settings = await getSettings();
    return NextResponse.json({ success: true, settings }, { headers: noStore });
  } catch (error) {
    console.error("selfDirectedLearning settings GET error:", error);
    return NextResponse.json({ success: false, message: errorMessage(error, "讀取設定失敗") }, { status: 500, headers: noStore });
  }
}

/** POST：儲存設定（限流＋CSRF＋權限＋稽核） */
export async function POST(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "self-directed-learning-admin-mutate",
      RATE.SELF_DIRECTED_LEARNING_ADMIN.limit,
      RATE.SELF_DIRECTED_LEARNING_ADMIN.windowMs
    );
    if (limited) return limited;
    if (!(await assertSameOrigin(request))) {
      return NextResponse.json({ success: false, message: "跨來源請求已被拒絕" }, { status: 403, headers: noStore });
    }

    const { session, denial } = await requireAdminModule("selfDirectedLearning");
    if (denial) return toAuthResponse(denial);

    const parsed = parseSettingsInput(await request.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ success: false, message: parsed.message }, { status: 400, headers: noStore });
    }

    const settings = await saveSettings(parsed.value);
    await logActivity({
      userId: session.uid,
      role: session.role,
      action: "self_directed_learning_settings_updated",
      ip: getClientIp(request),
      details: "更新自主學習計畫開放時間與審核設定",
    });
    return NextResponse.json({ success: true, settings }, { headers: noStore });
  } catch (error) {
    console.error("selfDirectedLearning settings POST error:", error);
    return NextResponse.json({ success: false, message: errorMessage(error, "儲存設定失敗") }, { status: 500, headers: noStore });
  }
}
