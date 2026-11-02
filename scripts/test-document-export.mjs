import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = path.resolve(process.argv[2] || path.join(root, "..", "campus-toolkit"));
const requireHost = createRequire(path.join(host, "package.json"));
const swc = requireHost("next/dist/build/swc");

function loadTs(relativePath, imports = {}) {
  const { code } = swc.transformSync(fs.readFileSync(path.join(root, relativePath), "utf8"), {
    jsc: { parser: { syntax: "typescript" }, target: "es2022" },
    module: { type: "commonjs" },
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", code)((name) => {
    if (Object.hasOwn(imports, name)) return imports[name];
    throw new Error(`Unexpected dependency: ${name}`);
  }, module, module.exports);
  return module.exports;
}

const types = loadTs(path.join("types", "self-directed-learning.ts"));
const exporter = loadTs(path.join("lib", "document-export.ts"), {
  "../types/self-directed-learning": types,
});
const authorization = loadTs(path.join("lib", "google-docs-authorization.ts"), {
  "./document-export": exporter,
});

const payload = {
  period: "115-1", studentName: "測試學生", className: "101",
  topic: '學習 <script>bad()</script> & "主題"', studyGroup: "資訊", advisor: "",
  learningGoals: '<p><b>學習目標</b></p><script>dropMe()</script><img src=x onerror=bad()>',
  reflection: "<p>反思心得</p>", source: "approved", layout: "separate", generatedAt: 123,
  weeks: [
    { week: 1, timing: "flexible", content: "<p>第一週安排</p>", venue: "<測試場地>", slots: [], blocked: false, record: "<p>第一週成果</p>" },
    { week: 2, timing: "afterSchool", content: "第二週安排\n第二行", venue: "", slots: [], blocked: false, record: "" },
  ],
};

test("export includes plan, formatted goals, weeks, outcomes and reflection without executable HTML", () => {
  const html = exporter.buildDocumentHtml(payload);
  for (const text of ["測試學生", "101", "<b>學習目標</b>", "第一週安排", "第一週成果", "反思心得", "課餘", "不會同步或覆蓋校內計畫"]) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(html.includes("&lt;script&gt;bad()&lt;/script&gt;"));
  assert.ok(html.includes("&lt;測試場地&gt;"));
  assert.ok(html.includes("第二週安排<br>第二行"));
  assert.doesNotMatch(html, /<script>|<img|onerror|dropMe/);
});

test("separate and integrated outcome layouts each include each outcome exactly once", () => {
  for (const layout of ["separate", "integrated"]) {
    const html = exporter.buildDocumentHtml({ ...payload, layout });
    assert.equal(html.split("第一週成果").length - 1, 1);
    const tableEnd = html.indexOf("</table>");
    assert.equal(html.indexOf("第一週成果") < tableEnd, layout === "integrated");
  }
});

test("draft and student-promoted copies cannot be mislabelled as school-approved", () => {
  assert.ok(exporter.buildDocumentHtml({ ...payload, source: "draft" }).includes("草稿副本"));
  const promoted = exporter.buildDocumentHtml({ ...payload, formalByStudent: true });
  assert.ok(promoted.includes("學生自行提升之正式計畫副本"));
  assert.ok(!promoted.includes("學校審核通過之計畫副本"));
});

test("multipart import converts HTML into a private native Google Doc without permission changes", async () => {
  const body = exporter.buildGoogleDocsUpload(payload, "test-boundary");
  assert.equal(body.type, "multipart/related; boundary=test-boundary");
  const text = await body.text();
  const metadata = JSON.parse(text.split("\r\n\r\n")[1].split("\r\n--")[0]);
  assert.equal(metadata.mimeType, "application/vnd.google-apps.document");
  assert.equal(metadata.name, exporter.documentTitle(payload));
  assert.deepEqual(Object.keys(metadata).sort(), ["mimeType", "name"]);
  assert.ok(text.includes("Content-Type: text/html; charset=UTF-8"));
  assert.ok(text.endsWith("--test-boundary--\r\n"));
});

test("successful upload uses only Drive upload, ephemeral bearer token and a safe document link", async (t) => {
  let captured;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    captured = { url, options };
    return new globalThis.Response(JSON.stringify({ id: "document_123-abc" }), { status: 200 });
  });
  assert.equal(
    await exporter.createGoogleDocument(payload, "synthetic-token"),
    "https://docs.google.com/document/d/document_123-abc/edit"
  );
  assert.equal(captured.url, exporter.GOOGLE_DOCS_UPLOAD_URL);
  assert.equal(captured.options.headers.Authorization, "Bearer synthetic-token");
  assert.equal(captured.options.credentials, "omit");
  assert.equal(captured.options.referrerPolicy, "no-referrer");
  const text = await captured.options.body.text();
  assert.ok(!text.includes("synthetic-token"));
  assert.ok(!text.includes("permissions"));
});

for (const status of [401, 403, 429, 500]) {
  test(`HTTP ${status} is surfaced without automatic retries`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls += 1;
      return new globalThis.Response("{}", { status });
    });
    await assert.rejects(exporter.createGoogleDocument(payload, "synthetic-token"));
    assert.equal(calls, 1);
  });
}

test("malformed success responses warn of possible creation rather than claiming success", async (t) => {
  for (const value of [{}, { id: "../bad" }, { id: "https://example.com" }]) {
    t.mock.method(globalThis, "fetch", async () => new globalThis.Response(JSON.stringify(value)));
    await assert.rejects(exporter.createGoogleDocument(payload, "token"), /可能已建立/);
    t.mock.restoreAll();
  }
});

test("network failure and timeout explicitly warn to check Drive before retrying", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("network"); });
  await assert.rejects(exporter.createGoogleDocument(payload, "token"), /先查看自己的雲端硬碟/);
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });
  await assert.rejects(exporter.createGoogleDocument(payload, "token"), /逾時.*先檢查/);
});

function mockOAuth(t, outcome) {
  let config;
  let request;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    google: { accounts: { oauth2: {
      initTokenClient(value) {
        config = value;
        return { requestAccessToken(value) {
          request = value;
          if (outcome.type) config.error_callback(outcome);
          else config.callback(outcome);
        } };
      },
      hasGrantedAllScopes: () => outcome.granted !== false,
    } } },
  } });
  return { config: () => config, request: () => request };
}

test("authorization requests only drive.file, account selection and no inherited grants", async (t) => {
  const fixture = mockOAuth(t, { access_token: "synthetic-token" });
  assert.equal(await authorization.authorizeGoogleDocs("test-client"), "synthetic-token");
  assert.equal(fixture.config().scope, exporter.GOOGLE_DRIVE_FILE_SCOPE);
  assert.equal(fixture.config().include_granted_scopes, false);
  assert.equal(fixture.request().prompt, "select_account");
});

for (const outcome of [
  { error: "access_denied" },
  { access_token: "token", granted: false },
  { type: "popup_closed" },
  { type: "popup_failed_to_open" },
]) {
  test(`authorization failure is explicit: ${JSON.stringify(outcome)}`, async (t) => {
    mockOAuth(t, outcome);
    await assert.rejects(authorization.authorizeGoogleDocs("test-client"));
  });
}
