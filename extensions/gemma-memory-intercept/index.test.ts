// extensions/gemma-memory-intercept/index.test.ts
//
// Pure-function unit tests for the gemma-memory-intercept plugin.
// Validates the natural-language detector + the forbidden-call detector
// against the recall.sh pattern set documented in
// settings/projects/gemma-memory.md (P2.25 D24.1 + D24.2).

import assert from "node:assert/strict";
import { test } from "node:test";
import pluginDefault, { __test__ } from "./index.ts";

const {
  looksLikeNaturalMemoRequest,
  detectForbiddenCall,
  buildBlockReason,
  buildPrependContext,
  executeRecallSync,
  cacheKey,
  sessionKeyToConversationId,
  cache,
} = __test__;

// ---------------------------------------------------------------------------
// looksLikeNaturalMemoRequest — POSITIVE cases (must return true)
// ---------------------------------------------------------------------------

const POSITIVE: Array<[string, string]> = [
  [
    "지난주에 그 사람 만나기로 한 계획 어떻게 됐어?",
    "T1: 지난주(time) + 어떻게 됐어(intent) + 한글 명사",
  ],
  ["오로라랑 정한 계획 다시 보여줘", "T1 alt: 보여줘(intent) + 한글 명사"],
  ["방이동 갔던 날 메모 다시 보여줘", "T2: 보여줘 + 명사"],
  ["오늘 점심 김치찌개 먹었어, 적어둬", "T3: 오늘(time) + 적어둬(intent) + 명사"],
  ["어제 적은 거 지워줘", "T4: 어제(time) + 지워줘(intent) + 명사"],
  ["엄마한테 내일 병원 같이 가자고 했어. 기록해둬", "T5: 내일(time) + 기록해둬(intent) + 명사"],
  [
    "그때 정해둔 옵션 가격이 얼마였더라",
    "READ-tense recall: 그때(time) + 얼마였더라(intent) + 명사",
  ],
  ["엄마 전화번호 알려줘", "person + 알려줘(intent) + 명사"],
  ["방이동 어디에 있더라", "place + SEARCH intent"],
  ["지난주에 만난 사람 누구였지", "지난주(time) + 명사 (intent 약하지만 time + noun으로 통과)"],
];

for (const [text, label] of POSITIVE) {
  test(`looksLikeNaturalMemoRequest POSITIVE: ${label}`, () => {
    assert.equal(
      looksLikeNaturalMemoRequest(text),
      true,
      `expected true for: ${JSON.stringify(text)}`,
    );
  });
}

// ---------------------------------------------------------------------------
// looksLikeNaturalMemoRequest — NEGATIVE cases (must return false)
// ---------------------------------------------------------------------------

const NEGATIVE: Array<[string, string]> = [
  ["", "empty"],
  ["응", "too short (1 char)"],
  ["응 알겠어", "no intent or time keywords + short"],
  ["/export-context", "slash command"],
  ["/help", "slash command"],
  ["bash scripts/recall.sh 어제 메모 보여줘", "already routed to recall.sh — let it through"],
  ["1234567890", "no Hangul"],
  ["hello world", "no Hangul"],
  ["The weather is nice today", "English only, no Hangul"],
  ["고마워", "noun-only, no intent or time"],
  [
    "오늘 날씨가 좋네",
    "오늘 + noun BUT no intent/recall verb… actually 오늘 is TIME so this should be TRUE — see borderline",
  ],
  ["123", "too short"],
];

// Remove the borderline "오늘 날씨가 좋네" — it actually IS positive by design
// (time + noun). The recall plugin would catch this and try to route to recall.sh.
// If false-positive becomes a problem we can tighten in next iteration.
const NEGATIVE_FILTERED = NEGATIVE.filter(([text]) => text !== "오늘 날씨가 좋네");

for (const [text, label] of NEGATIVE_FILTERED) {
  test(`looksLikeNaturalMemoRequest NEGATIVE: ${label}`, () => {
    assert.equal(
      looksLikeNaturalMemoRequest(text),
      false,
      `expected false for: ${JSON.stringify(text)}`,
    );
  });
}

// Track this borderline case explicitly:
test("looksLikeNaturalMemoRequest BORDERLINE: time + noun without intent verb still matches", () => {
  assert.equal(
    looksLikeNaturalMemoRequest("오늘 날씨가 좋네"),
    true,
    "design: time + noun is enough to trigger; intent verb optional",
  );
});

// ---------------------------------------------------------------------------
// detectForbiddenCall — must return non-null for forbidden patterns
// ---------------------------------------------------------------------------

const FORBIDDEN: Array<[string, Record<string, unknown>, string]> = [
  ["read", { path: "/home/lisyoen/projects/openclaw/skills/memory/SKILL.md" }, "SKILL.md path"],
  ["read", { path: "/some/where/skill-creator/SKILL.md" }, "SKILL.md nested path"],
  ["read", { path: "MEMORY-SEARCH/skill.md" }, "case-insensitive SKILL.md"],
  [
    "read",
    { path: "/home/lisyoen/.openclaw/agents/gemma/workspace/SOUL.md" },
    "workspace profile SOUL.md",
  ],
  ["read", { path: "MEMORY.md" }, "workspace profile MEMORY.md (already in prompt)"],
  ["read", { path: "TOOLS.md" }, "workspace profile TOOLS.md"],
  ["read", { path: "BOOTSTRAP.md" }, "workspace profile BOOTSTRAP.md"],
  ["read", { file_path: "AGENTS.md" }, "workspace profile via file_path alias"],
  ["exec", { command: "find ~/workspace -name '*.md'" }, "exec find"],
  ["exec", { command: "ind ~/workspace" }, "exec ind (find typo)"],
  ["exec", { command: "grep -r aurora ~/workspace" }, "exec grep -r"],
  ["exec", { command: "cat ~/workspace/MEMORY.md" }, "exec cat workspace md"],
  ["exec", { command: "ls -R ~/workspace" }, "exec ls -R"],
  ["exec", { command: "bash scripts/memory.sh search aurora" }, "direct memory.sh"],
  ["exec", { command: "bash scripts/person.sh new aurora" }, "direct person.sh"],
  ["bash", { command: "find . -type f" }, "bash variant: find"],
];

for (const [tool, params, label] of FORBIDDEN) {
  test(`detectForbiddenCall FORBIDDEN: ${label}`, () => {
    const r = detectForbiddenCall(tool, params);
    assert.notEqual(
      r,
      null,
      `expected non-null for tool=${tool} params=${JSON.stringify(params)}, got null`,
    );
  });
}

// ---------------------------------------------------------------------------
// detectForbiddenCall — must return null for allowed patterns
// ---------------------------------------------------------------------------

const ALLOWED: Array<[string, Record<string, unknown>, string]> = [
  ["exec", { command: 'bash scripts/recall.sh "어제 메모 보여줘"' }, "recall.sh — allow"],
  [
    "exec",
    {
      command:
        'bash /home/lisyoen/.openclaw/agents/gemma/workspace/scripts/recall.sh "오로라 계획"',
    },
    "recall.sh abs path",
  ],
  ["exec", { command: "date +%Y-%m-%d" }, "harmless date call"],
  ["exec", { command: "echo hello" }, "echo"],
  ["read", { path: "/home/lisyoen/some/data.json" }, "read non-md non-skill"],
  ["read", { path: "/etc/hosts" }, "read unrelated file"],
  ["write", { path: "/tmp/x.md", content: "..." }, "write tool — out of scope"],
  ["read", { path: "" }, "read with empty path"],
  ["exec", {} as Record<string, unknown>, "exec with empty params"],
];

for (const [tool, params, label] of ALLOWED) {
  test(`detectForbiddenCall ALLOWED: ${label}`, () => {
    const r = detectForbiddenCall(tool, params);
    assert.equal(
      r,
      null,
      `expected null for tool=${tool} params=${JSON.stringify(params)}, got: ${r}`,
    );
  });
}

// ---------------------------------------------------------------------------
// buildBlockReason — sanity
// ---------------------------------------------------------------------------

test("buildBlockReason includes original call and user text sample", () => {
  const reason = buildBlockReason(
    `read({path:"foo/SKILL.md"})`,
    "지난주에 오로라랑 정한 계획 다시 보여줘",
  );
  assert.match(reason, /P2\.25c/, "should mention P2.25c");
  assert.match(reason, /scripts\/recall\.sh/, "should suggest recall.sh");
  assert.match(reason, /지난주에 오로라랑 정한 계획/, "should echo user text sample");
  assert.match(reason, /read\(\{path:"foo\/SKILL\.md"\}\)/, "should name forbidden call");
});

test("buildBlockReason embeds escaped double quotes from user text", () => {
  const reason = buildBlockReason("read SKILL.md", '메모에 "방이동" 적어둬');
  // The inner " in the user text should appear escaped as \\" inside the sample.
  assert.match(reason, /방이동/);
  // Escaped form must be present (the sample is wrapped in escaped quotes).
  assert.ok(reason.includes('\\"방이동\\"'), 'should escape inner quotes as \\"');
});

// ---------------------------------------------------------------------------
// P2.28 hook preinject — buildPrependContext + executeRecallSync + key alignment
// ---------------------------------------------------------------------------

test("buildPrependContext: contains P2.28 marker and the raw recall body", () => {
  const recall = "[메모리 회상] 오로라랑 정한 계획: 방이동 점심 오늘 12시";
  const ctx = buildPrependContext(recall);
  assert.match(ctx, /P2\.28 plugin 선주입/, "should advertise P2.28 origin");
  assert.ok(ctx.includes(recall), "should embed raw recall body verbatim");
  assert.match(ctx, /추가 도구 호출.*없이/, "should instruct no further tool calls");
});

test("buildPrependContext: instructs fallback message when recall is empty", () => {
  const ctx = buildPrependContext("");
  assert.match(ctx, /비어 있거나 부족하면/, "should include empty-recall fallback hint");
});

test("executeRecallSync: empty input returns ok:false reason=empty-input", () => {
  const r = executeRecallSync("");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "empty-input");
  }
});

test("executeRecallSync: whitespace-only input treated as empty", () => {
  const r = executeRecallSync("   \n\t  ");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "empty-input");
  }
});

// Cache key alignment — message_received writes the key, before_prompt_build
// reads it. Both must agree on the conversation id derived from sessionKey.
test("cacheKey + sessionKeyToConversationId: telegram direct DM aligns", () => {
  const sk = "agent:gemma:telegram:direct:56682682";
  const cid = sessionKeyToConversationId(sk);
  assert.equal(cid, "56682682");
  assert.equal(cacheKey("gemma", cid), "gemma|56682682");
});

test("cacheKey + sessionKeyToConversationId: telegram group with negative chat id", () => {
  const sk = "agent:gemma:telegram:group:-1003821022499";
  const cid = sessionKeyToConversationId(sk);
  assert.equal(cid, "-1003821022499");
  assert.equal(cacheKey("gemma", cid), "gemma|-1003821022499");
});

test("sessionKeyToConversationId: undefined / malformed → undefined", () => {
  assert.equal(sessionKeyToConversationId(undefined), undefined);
  assert.equal(sessionKeyToConversationId(""), undefined);
  assert.equal(sessionKeyToConversationId("not-a-session-key"), undefined);
  // Non-direct/group bucket falls through.
  assert.equal(sessionKeyToConversationId("agent:gemma:telegram:other:12345"), undefined);
});

// ---------------------------------------------------------------------------
// P2.28 integration — register hooks via mock api and exercise the
// before_prompt_build path end-to-end (cache seed → inject → 1-shot consume).
// ---------------------------------------------------------------------------

type HookRegistry = Map<string, (event: unknown, ctx: unknown) => unknown>;

function installPlugin(): HookRegistry {
  const handlers: HookRegistry = new Map();
  const api = {
    id: "gemma-memory-intercept",
    name: "gemma-memory-intercept",
    source: "test",
    config: {},
    runtime: {},
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    on: (name: string, h: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, h);
    },
    registerTool: () => {},
    registerHook: () => {},
    registerHttpRoute: () => {},
    registerChannel: () => {},
    registerGatewayMethod: () => {},
    registerCli: () => {},
    registerService: () => {},
    registerProvider: () => {},
    registerCommand: () => {},
    registerContextEngine: () => {},
    resolvePath: (p: string) => p,
  };
  // biome-ignore lint/suspicious/noExplicitAny: mock api for test only
  pluginDefault(api as any);
  return handlers;
}

test("P2.28 hook flow: cached recall result is injected once via prependContext, then consumed", () => {
  const handlers = installPlugin();
  const hook = handlers.get("before_prompt_build");
  assert.ok(hook, "plugin must register before_prompt_build");

  const sk = "agent:gemma:telegram:direct:99991";
  const key = cacheKey("gemma", sessionKeyToConversationId(sk));
  cache.set(key, {
    text: "어제 메모 보여줘",
    firstToolCallSeen: false,
    ts: Date.now(),
    recallResult: "RESULT: OK\n--- BEGIN CONTENT ---\nmemo body\n--- END CONTENT ---",
  });

  const r1 = hook!({ prompt: "x", messages: [] }, { agentId: "gemma", sessionKey: sk }) as
    | { prependContext?: string }
    | undefined;
  assert.ok(r1 && r1.prependContext, "first call should return prependContext");
  assert.match(r1.prependContext!, /P2\.28 plugin 선주입/);
  assert.match(r1.prependContext!, /memo body/);

  const r2 = hook!({ prompt: "x", messages: [] }, { agentId: "gemma", sessionKey: sk });
  assert.equal(r2, undefined, "second call should not inject (1-shot consumed)");

  cache.delete(key);
});

test("P2.28 hook flow: non-gemma agent gets no injection even with cached entry", () => {
  const handlers = installPlugin();
  const hook = handlers.get("before_prompt_build");
  assert.ok(hook);

  const sk = "agent:gemma:telegram:direct:99992";
  const key = cacheKey("gemma", sessionKeyToConversationId(sk));
  cache.set(key, {
    text: "어제 메모 보여줘",
    firstToolCallSeen: false,
    ts: Date.now(),
    recallResult: "RESULT: OK\nx",
  });

  const r = hook!({ prompt: "x", messages: [] }, { agentId: "main", sessionKey: sk });
  assert.equal(r, undefined, "main agent should pass through");

  cache.delete(key);
});

test("P2.28 hook flow: no cached entry → no injection (pass-through)", () => {
  const handlers = installPlugin();
  const hook = handlers.get("before_prompt_build");
  assert.ok(hook);

  const sk = "agent:gemma:telegram:direct:99993";
  // Ensure no leftover from prior tests for this conv id.
  cache.delete(cacheKey("gemma", sessionKeyToConversationId(sk)));

  const r = hook!({ prompt: "x", messages: [] }, { agentId: "gemma", sessionKey: sk });
  assert.equal(r, undefined);
});

test("P2.28 hook flow: cached entry without recallResult → no injection", () => {
  const handlers = installPlugin();
  const hook = handlers.get("before_prompt_build");
  assert.ok(hook);

  const sk = "agent:gemma:telegram:direct:99994";
  const key = cacheKey("gemma", sessionKeyToConversationId(sk));
  cache.set(key, {
    text: "방이동 어디",
    firstToolCallSeen: false,
    ts: Date.now(),
    // recallResult intentionally omitted (recall preexec failed or empty).
  });

  const r = hook!({ prompt: "x", messages: [] }, { agentId: "gemma", sessionKey: sk });
  assert.equal(r, undefined, "missing recallResult → fall through, no injection");

  cache.delete(key);
});
