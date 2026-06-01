// extensions/gemma-memory-intercept/index.ts
//
// gemma-memory P2.25c option F + P2.28 hook preinject (2026-05-30).
//
// When a user sends a natural-language memo / recall / journal request to
// agentId="gemma" via Telegram (DM or group), the model has a strong prior
// from its training data to start with `read({path:"*SKILL.md"})` or
// `exec({command:"find ..."})` even though the workspace TOOLS/AGENTS/BOOTSTRAP
// docs forbid those paths and require `bash scripts/recall.sh "<원문>"` instead.
// Prompt-level enforcement (P2.25a/b/c) was insufficient on DM channel.
//
// 2026-05-30 P2.28 추가 진단: Gemma 4 26B NVFP4 가 도구 호출 의도 시 빈 content
// (content=[] + stop=toolUse) 만 송출 → toolCall 미성립 → before_tool_call hook
// 미발화 → 회상 실패 + P2.26 빈응답 fallback. 본질 변경 Step 3 = plugin 의미
// 파싱 전환: inbound 단계에서 recall.sh 를 선실행하고 그 결과를 prependContext
// 로 주입(before_prompt_build), Gemma4 의 toolCall 의존 제거.
//
// This plugin enforces the rule at the OpenClaw hook level:
//   1. message_received -> cache user text per (sessionKey,sessionId,runId),
//      if it matches the natural-language memo signal, AND synchronously
//      execute recall.sh to cache the recall result (P2.28).
//   2. before_prompt_build -> if a recall result is cached, prepend it to
//      the agent context so the model can answer from it without needing a
//      toolCall (P2.28).
//   3. before_tool_call -> if the cached message exists and the first toolCall
//      matches a forbidden pattern, block/reroute it (kept as safety net for
//      cases where the model still emits a toolCall).
//
// Scope: agentId === "gemma" ONLY. Other agents (main/Claw, gemma-kevin,
// luna) are not affected.

import { spawnSync } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

// ---------------------------------------------------------------------------
// Pattern definitions (kept in sync with workspace/scripts/recall.sh).
// If you change any of these, change recall.sh too and vice versa.
// ---------------------------------------------------------------------------

const INTENT_PATTERNS: RegExp[] = [
  // DELETE
  /지워줘|지워|삭제해|삭제|잊어버려|잘못\s*적었어|빼줘|없애줘/,
  // EDIT
  /고쳐줘|수정해|바꿔줘|바꿔/,
  // WRITE
  /적어둬|적어줘|메모해둬|메모해|기록해둬|기록해줘|기록해|저장해|남겨둬|남겨줘/,
  // SEARCH (2026-05-29: 찾아봐/검색 계열 보강 — '안미라 누군지 찾아봐' 미스 수정)
  /찾아줘|찾아봐|찾아보자|찾아본|찾아|검색해줘|검색해|검색|어디에\s*있어|어디에\s*있더라|어디\s*갔지/,
  // READ / RECALL
  /보여줘|보여줄래|알려줘|다시\s*봐|다시\s*보자|어떻게\s*됐어|얼마였더라|뭐였더라|봐줘|봐\s*줘|보자|기억나|기억해|기억\s*안\s*나|기억이\s*안/,
  // PERSON-RECALL (2026-05-24 P2.25c; 2026-05-29 누군지/누군가 축약형 보강): "누구" 류 인물 회상
  /누구지|누군지|누구인지|누구인가|누군가|누구임|누구야|누구더라|누구였더라|누구였지|누구냐|누구였\b/,
];

const TIME_PATTERNS: RegExp[] = [
  /오늘|어제|그제|그저께|내일|모레|지난주|저번주|이번주|지난달|저번달|이번달|작년|올해|하루\s*전|이틀\s*전|사흘\s*전|며칠\s*전|그때|그날|그\s*날/,
];

const HANGUL_TOKEN_RE = /[가-힣]{2,}/;

const FORBIDDEN_EXEC_HEAD_RE = /^\s*(find|ind|fnd|grep|cat|ls\s+-[a-zA-Z]*[Rr][a-zA-Z]*|ls\s+-l)\b/;
const DIRECT_MEMORY_SH_RE = /\bscripts\/(memory|person)\.sh\b/;
const RECALL_SH_RE = /\bscripts\/recall\.sh\b/;

// SKILL.md path matcher (case-insensitive, trailing-anchored). Also catches
// "...SKILL.md", "memory-search/SKILL.md", "skill-creator/SKILL.md", etc.
const SKILL_MD_PATH_RE = /SKILL\.md\s*$/i;

// P2.29 audience visibility filter
// owner user id 집합. 그 외 발화자(그룹에 합류한 다른 사람)는 guest 로 분류되어
// recall.sh 에서 visibility != shared 카드는 결과에서 제외된다.
const OWNER_USER_IDS: ReadonlySet<string> = new Set(["56682682"]);

export type Audience = "owner" | "guest";

// PluginHookMessageReceivedEvent 의 metadata.senderId 가 telegram user id 다
// (src/hooks/message-hook-mappers.ts:184-199 → toPluginMessageReceivedEvent).
// metadata 가 없거나 senderId 가 비어 있으면 sessionKey 의 direct:<id> 패턴을
// 폴백으로 사용한다 (그룹에선 chat_id 가 잡혀 owner 매칭이 실패 → guest).
export function extractSenderUserId(
  event: { metadata?: Record<string, unknown> } | undefined | null,
  ctx: { sessionKey?: string } | undefined | null,
): string | undefined {
  const meta = event && typeof event === "object" ? event.metadata : undefined;
  if (meta && typeof meta === "object") {
    const sid = (meta as { senderId?: unknown }).senderId;
    if (typeof sid === "string" && sid) return sid;
    if (typeof sid === "number" && Number.isFinite(sid)) return String(sid);
  }
  // Fallback: sessionKey direct:<id> 패턴 (DM 에선 sender = chat 이므로 안전)
  const sk = ctx && typeof ctx === "object" ? ctx.sessionKey : undefined;
  if (typeof sk === "string" && sk) {
    const m = /^agent:[^:]+:[^:]+:direct:(.+)$/.exec(sk);
    if (m) return m[1];
  }
  return undefined;
}

export function isOwnerAudience(userId: string | undefined): boolean {
  if (!userId) return false;
  return OWNER_USER_IDS.has(userId);
}

export function audienceLabel(userId: string | undefined): Audience {
  return isOwnerAudience(userId) ? "owner" : "guest";
}

// MD profile files inside agent workspace that the model often "reads"
// instead of calling recall.sh. read({path:"SOUL.md"}), MEMORY.md, USER.md,
// TOOLS.md, AGENTS.md etc. — these are already in systemPrompt; opening them
// via the read tool is wasted bandwidth and a signal the model is bypassing
// recall.sh.
const WORKSPACE_PROFILE_MD_RE =
  /\/?(?:SOUL|IDENTITY|USER|MEMORY|AGENTS|TOOLS|BOOTSTRAP|HEARTBEAT)\.md\s*$/;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function looksLikeNaturalMemoRequest(text: string): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (t.length < 4) return false;
  if (t.startsWith("/")) return false; // slash command, not natural language
  // If the user is already telling the model to call recall.sh, skip.
  if (RECALL_SH_RE.test(t)) return false;

  const hasIntent = INTENT_PATTERNS.some((p) => p.test(t));
  const hasTime = TIME_PATTERNS.some((p) => p.test(t));
  const hasNoun = HANGUL_TOKEN_RE.test(t);

  return (hasIntent || hasTime) && hasNoun;
}

export function detectForbiddenCall(
  toolName: string,
  params: Record<string, unknown> | undefined,
): string | null {
  const p = params ?? {};
  const name = String(toolName ?? "").toLowerCase();

  // read({path:"...SKILL.md"}) or read on workspace profile mds
  if (name === "read") {
    const pathStr = String(
      (p as { path?: unknown }).path ?? (p as { file_path?: unknown }).file_path ?? "",
    );
    if (SKILL_MD_PATH_RE.test(pathStr)) {
      return `read({path:"${truncate(pathStr, 80)}"}) — SKILL.md path`;
    }
    if (WORKSPACE_PROFILE_MD_RE.test(pathStr)) {
      return `read({path:"${truncate(pathStr, 80)}"}) — workspace profile MD (already in system prompt)`;
    }
  }

  // exec/bash direct filesystem explorers and memory.sh/person.sh shortcuts
  if (name === "exec" || name === "bash") {
    const cmdRaw = String(
      (p as { command?: unknown }).command ??
        (p as { cmd?: unknown }).cmd ??
        (p as { script?: unknown }).script ??
        "",
    );
    if (!cmdRaw) return null;

    // already routed to recall.sh — allow.
    if (RECALL_SH_RE.test(cmdRaw)) return null;

    if (FORBIDDEN_EXEC_HEAD_RE.test(cmdRaw)) {
      const head = cmdRaw.replace(/^\s+/, "").split(/\s/, 1)[0];
      return `${name}({command:"${head} ..."}) — direct fs explorer`;
    }
    if (DIRECT_MEMORY_SH_RE.test(cmdRaw)) {
      return `${name}({command:"... memory.sh|person.sh ..."}) — direct script (must go via recall.sh)`;
    }
  }

  return null;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "...";
}

// Shell single-quote escaping for safe recall.sh argument passing.
function shSingleQuote(v: string): string {
  return "'" + v.replace(/'/g, "'\\''") + "'";
}

// Build the canonical recall.sh invocation from the cached natural-language text.
function buildRecallCommand(userText: string): string {
  return `bash scripts/recall.sh ${shSingleQuote(userText.trim())}`;
}

// ---------------------------------------------------------------------------
// Block reason text — what the model sees and learns from.
// ---------------------------------------------------------------------------

function buildBlockReason(originalCall: string, userText: string): string {
  const sample = truncate(userText.replace(/\n/g, " "), 200).replace(/"/g, '\\"');
  return (
    `자연어 메모/일지/회상 요청 감지 (P2.25c 옵션 F). ` +
    `차단된 호출: ${originalCall}. ` +
    `허용된 단일 호출: exec({command: "bash scripts/recall.sh \\"${sample}\\""}). ` +
    `find/grep/cat/ls -R/memory.sh/person.sh/SKILL.md/profile MD 직접 호출 모두 차단됨. ` +
    `recall.sh 가 자연어 1줄을 받아 intent 분류 + 시간/명사/인물 추출 + 도구 시퀀스를 자동 처리.`
  );
}

// ---------------------------------------------------------------------------
// Per-session cache of the latest user text + first-call flag
// ---------------------------------------------------------------------------

type CacheEntry = {
  text: string;
  firstToolCallSeen: boolean;
  ts: number;
  // P2.28: recall.sh 선실행 결과 + before_prompt_build 1회용 소비 flag
  recallResult?: string;
  recallInjected?: boolean;
};

const userTextCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_CAP = 1000;

function cacheKey(agentId: string | undefined, conversationId: string | undefined): string {
  // P2.25c route 1 fix (2026-05-24): PluginHookMessageContext lacks
  // sessionKey/sessionId/runId. Use agentId+conversationId for cross-hook
  // matching. In message_received ctx provides accountId/channelId/conversationId
  // (channel-scoped); in before_tool_call ctx provides agentId/sessionKey.
  // We map sessionKey → conversationId via sessionKeyToConversationId().
  return `${agentId ?? ""}|${conversationId ?? ""}`;
}

// P2.25c route 1 fix: extract conversation id (telegram chat_id) from sessionKey.
// sessionKey format observed (nohup.log hook-shape):
//   "agent:gemma:telegram:direct:56682682"      → "56682682"
//   "agent:gemma:telegram:group:-1003821022499" → "-1003821022499"
// Returns undefined if format doesn't match (e.g. non-telegram or unexpected layout).
function sessionKeyToConversationId(sessionKey: string | undefined): string | undefined {
  if (typeof sessionKey !== "string" || !sessionKey) return undefined;
  const m = /^agent:[^:]+:[^:]+:(?:direct|group):(.+)$/.exec(sessionKey);
  return m ? m[1] : undefined;
}

function pruneCache(): void {
  const now = Date.now();
  for (const [k, v] of userTextCache) {
    if (now - v.ts > CACHE_TTL_MS) userTextCache.delete(k);
  }
  if (userTextCache.size > CACHE_CAP) {
    const overflow = userTextCache.size - CACHE_CAP;
    const it = userTextCache.keys();
    for (let i = 0; i < overflow; i++) {
      const k = it.next().value;
      if (typeof k === "string") userTextCache.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Counters (exposed via debug logger; not a registered command in this
// version to minimize OpenClaw surface area).
// ---------------------------------------------------------------------------

const counters = {
  messagesSeen: 0,
  naturalMemoMatched: 0,
  toolCallsInspected: 0,
  blocked: 0,
  rerouted: 0,
  skippedNotGemma: 0,
  skippedNotFirstCall: 0,
  skippedNoMatch: 0,
  skippedAllowed: 0,
  // P2.28 hook preinject counters
  recallPreexecOk: 0,
  recallPreexecFail: 0,
  recallInjected: 0,
  // P2.29 audience filter counters
  audienceOwner: 0,
  audienceGuest: 0,
};

export function __dumpCounters(): Record<string, number> {
  return { ...counters, cacheSize: userTextCache.size };
}

// ---------------------------------------------------------------------------
// Helpers for extracting user text from message_received events. The shape
// can vary by channel; this is best-effort.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// P2.28: recall.sh 동기 선실행 + 주입 텍스트 빌더
// ---------------------------------------------------------------------------

// 환경변수로 override 가능. 기본은 gemma 워크스페이스 절대 경로 (recall.sh 가
// cd 없이 호출되도록 cwd 를 워크스페이스로 고정).
const RECALL_PREINJECT_WORKSPACE =
  process.env.RECALL_PREINJECT_WORKSPACE || "/home/lisyoen/.openclaw/agents/gemma/workspace";
const RECALL_PREINJECT_TIMEOUT_MS = Number.parseInt(
  process.env.RECALL_PREINJECT_TIMEOUT_MS || "30000",
  10,
);
const RECALL_PREINJECT_MAX_OUTPUT = Number.parseInt(
  process.env.RECALL_PREINJECT_MAX_OUTPUT || "4194304",
  10,
);
const RECALL_PREINJECT_DISABLE = process.env.RECALL_PREINJECT_DISABLE === "1";

type RecallPreexecResult =
  | { ok: true; stdout: string; durationMs: number }
  | { ok: false; reason: string; durationMs: number };

export function executeRecallSync(
  userText: string,
  audience: Audience = "owner",
): RecallPreexecResult {
  const t0 = Date.now();
  if (RECALL_PREINJECT_DISABLE) {
    return { ok: false, reason: "disabled-by-env", durationMs: 0 };
  }
  const arg = (userText ?? "").trim();
  if (!arg) return { ok: false, reason: "empty-input", durationMs: 0 };
  try {
    // P2.29: RECALL_AUDIENCE 환경변수 주입 (owner|guest). recall.sh 가 visibility
    // 필터 + write/edit/delete 거부 게이트에 사용.
    const env = { ...process.env, RECALL_AUDIENCE: audience };
    const result = spawnSync("bash", ["scripts/recall.sh", arg], {
      cwd: RECALL_PREINJECT_WORKSPACE,
      encoding: "utf8",
      timeout: RECALL_PREINJECT_TIMEOUT_MS,
      maxBuffer: RECALL_PREINJECT_MAX_OUTPUT,
      env,
    });
    const durationMs = Date.now() - t0;
    if (result.error) {
      return { ok: false, reason: `error:${result.error.message}`, durationMs };
    }
    if (typeof result.status === "number" && result.status !== 0) {
      return { ok: false, reason: `nonzero-exit:${result.status}`, durationMs };
    }
    const stdout = (result.stdout || "").trim();
    if (!stdout) return { ok: false, reason: "empty-stdout", durationMs };
    return { ok: true, stdout, durationMs };
  } catch (e) {
    const durationMs = Date.now() - t0;
    return {
      ok: false,
      reason: `exception:${e instanceof Error ? e.message : String(e)}`,
      durationMs,
    };
  }
}

// before_prompt_build prependContext 본문 — Gemma4 가 toolCall 없이도 회상
// 결과를 근거 인용할 수 있도록 명시적 안내문을 둘러친다.
export function buildPrependContext(recallResult: string): string {
  return (
    `[메모리 회상 결과 (P2.28 plugin 선주입)]\n` +
    `${recallResult}\n` +
    `— 위 회상 결과를 근거로 사용자 질문에 답하라. ` +
    `추가 도구 호출(read/exec/find/grep/cat 등) 없이 위 본문만으로 응답한다. ` +
    `회상 결과가 비어 있거나 부족하면 그 사실을 사용자에게 한 문장으로 알려라.\n`
  );
}

function extractUserText(event: unknown): string {
  if (!event || typeof event !== "object") return "";
  const ev = event as Record<string, unknown>;

  // common shapes
  const m = ev["message"];
  if (typeof m === "string") return m;
  if (m && typeof m === "object") {
    const t = (m as Record<string, unknown>)["text"];
    if (typeof t === "string") return t;
    const c = (m as Record<string, unknown>)["content"];
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const joined = c
        .map((seg) =>
          seg && typeof seg === "object" && typeof (seg as { text?: unknown }).text === "string"
            ? (seg as { text: string }).text
            : "",
        )
        .filter(Boolean)
        .join("\n");
      if (joined) return joined;
    }
  }
  if (typeof ev["text"] === "string") return ev["text"] as string;
  if (typeof ev["content"] === "string") return ev["content"] as string;
  return "";
}

// ---------------------------------------------------------------------------
// Plugin entrypoint
// ---------------------------------------------------------------------------

export default (api: OpenClawPluginApi) => {
  const { logger } = api;

  // P2.25c hook-debug: confirm plugin registration on every load
  logger.info(`[gemma-memory-intercept] plugin registered; api keys=${Object.keys(api).join(",")}`);

  api.on("message_received", (event, ctx) => {
    // P2.25c route 2 fix (2026-05-24 21:10): PluginHookMessageContext now carries
    // agentId/sessionKey/sessionId/runId (dispatcher populates them via
    // toPluginMessageContext + deriveInboundMessageHookContext overrides). The
    // route-1 accountId-based workaround and channel-prefix strip are removed in
    // favor of ctx.agentId direct check + sessionKey-derived conversationId
    // (matches before_tool_call's source for cache key alignment).
    const agentId = ctx.agentId;
    const sessionKey = ctx.sessionKey;
    if (agentId !== "gemma") return;
    const conversationId = sessionKeyToConversationId(sessionKey);
    counters.messagesSeen++;

    const text = extractUserText(event);
    const matched = text ? looksLikeNaturalMemoRequest(text) : false;
    // P2.29: audience 추출 (event.metadata.senderId 우선, sessionKey direct: 폴백).
    const senderUserId = extractSenderUserId(event, ctx);
    const audience: Audience = audienceLabel(senderUserId);
    logger.info(
      `[gemma-memory-intercept] message_received agent=${agentId} ` +
        `sessionKey=${sessionKey ?? ""} convId=${conversationId ?? ""} ` +
        `userId=${senderUserId ?? "?"} audience=${audience} ` +
        `textLen=${text?.length ?? 0} matched=${matched} ` +
        `sample="${truncate(text || "", 60).replace(/"/g, '\\"')}"`,
    );
    if (!text) return;
    if (!matched) return;

    counters.naturalMemoMatched++;
    if (audience === "owner") counters.audienceOwner++;
    else counters.audienceGuest++;

    const key = cacheKey(agentId, conversationId);
    const entry: CacheEntry = { text, firstToolCallSeen: false, ts: Date.now() };
    userTextCache.set(key, entry);
    pruneCache();

    logger.info(
      `[gemma-memory-intercept] natural-memo cached: key=${key} audience=${audience} ` +
        `sample="${truncate(text, 80)}"`,
    );

    // P2.28: recall.sh 동기 선실행 → 결과 캐시 적재. 실패/빈 결과/timeout 이면
    // recallResult 미설정 (모델 기존 흐름 유지, P2.26 가드가 빈응답 fallback).
    // P2.29: audience 전달 → recall.sh 가 visibility 필터 적용.
    const preexec = executeRecallSync(text, audience);
    if (preexec.ok) {
      entry.recallResult = preexec.stdout;
      counters.recallPreexecOk++;
      logger.info(
        `[gemma-memory-intercept] recall preexec OK: key=${key} ` +
          `bytes=${preexec.stdout.length} durMs=${preexec.durationMs}`,
      );
    } else {
      counters.recallPreexecFail++;
      logger.warn(
        `[gemma-memory-intercept] recall preexec FAIL: key=${key} ` +
          `reason=${preexec.reason} durMs=${preexec.durationMs}`,
      );
    }
  });

  // P2.28: before_prompt_build — 캐시 recallResult 가 있으면 prependContext 로
  // 주입하고 1회용 소비. 비-gemma agent / 미매치 / 이미 주입 / 빈 결과는 패스.
  // ctx 는 PluginHookAgentContext (agentId, sessionKey, ...) 를 제공한다.
  api.on("before_prompt_build", (_event, ctx) => {
    const agentId = ctx.agentId;
    if (agentId !== "gemma") return;
    const sessionKey = ctx.sessionKey;
    const conversationId = sessionKeyToConversationId(sessionKey);
    const key = cacheKey(agentId, conversationId);
    const entry = userTextCache.get(key);
    if (!entry) return;
    if (!entry.recallResult) return;
    if (entry.recallInjected) return;
    entry.recallInjected = true;
    counters.recallInjected++;
    const prependContext = buildPrependContext(entry.recallResult);
    logger.info(
      `[gemma-memory-intercept] recall preinject: key=${key} ` +
        `sessionKey=${sessionKey ?? ""} bytes=${entry.recallResult.length}`,
    );
    return { prependContext };
  });

  api.on("before_tool_call", (event, ctx) => {
    const agentId = (ctx as { agentId?: string }).agentId;
    if (agentId !== "gemma") {
      counters.skippedNotGemma++;
      return;
    }
    counters.toolCallsInspected++;

    // P2.25c route 1 fix: derive conversationId from sessionKey to match
    // the key written by message_received handler.
    const sessionKey = (ctx as { sessionKey?: string }).sessionKey;
    const conversationId = sessionKeyToConversationId(sessionKey);
    const key = cacheKey(agentId, conversationId);
    const entry = userTextCache.get(key);
    logger.info(
      `[gemma-memory-intercept] before_tool_call agent=${agentId} ` +
        `sessionKey=${sessionKey ?? ""} convId=${conversationId ?? ""} key=${key} ` +
        `tool=${String(event.toolName ?? "")} ` +
        `hasCache=${entry ? "yes" : "no"} ` +
        `firstCall=${entry && !entry.firstToolCallSeen ? "yes" : "no"}`,
    );
    if (!entry) {
      counters.skippedNoMatch++;
      return;
    }

    // Only intercept the FIRST toolCall after a matched memo signal.
    if (entry.firstToolCallSeen) {
      counters.skippedNotFirstCall++;
      return;
    }
    entry.firstToolCallSeen = true;

    // 2026-05-29 force-route: Gemma 4 26B NVFP4 는 도구 호출 인자를 자주
    // 비워(exec({})) 보내거나 누락한다. 차단 후 모델 재시도에 의존하는 대신,
    // exec/bash 호출이면 params 를 recall.sh 로 재작성(adjust)하여 결정적으로
    // 라우팅한다. recall.sh 자체 호출은 통과. read(SKILL.md/profile md) 등
    // 비-exec 금지 호출은 기존대로 block + 안내.
    const toolNameLc = String(event.toolName ?? "").toLowerCase();
    const params = (event.params ?? {}) as Record<string, unknown>;

    if (toolNameLc === "exec" || toolNameLc === "bash") {
      const cmdRaw = String(
        (params as { command?: unknown }).command ??
          (params as { cmd?: unknown }).cmd ??
          (params as { script?: unknown }).script ??
          "",
      );
      if (RECALL_SH_RE.test(cmdRaw)) {
        counters.skippedAllowed++;
        return; // already recall.sh — let it through
      }
      const recallCmd = buildRecallCommand(entry.text);
      counters.rerouted++;
      logger.warn(
        `[gemma-memory-intercept] REROUTED ${toolNameLc} -> recall.sh: key=${key} ` +
          `origCmd="${truncate(cmdRaw, 60).replace(/"/g, '\\"')}" ` +
          `text="${truncate(entry.text, 60).replace(/"/g, '\\"')}"`,
      );
      return { params: { ...params, command: recallCmd } };
    }

    const forbidden = detectForbiddenCall(event.toolName, event.params);
    if (!forbidden) {
      counters.skippedAllowed++;
      return; // benign non-exec call
    }

    counters.blocked++;
    const blockReason = buildBlockReason(forbidden, entry.text);
    logger.warn(
      `[gemma-memory-intercept] BLOCKED toolCall: key=${key} sessionKey=${sessionKey ?? ""} call=${forbidden}`,
    );

    return { block: true, blockReason };
  });

  return undefined;
};

// ---------------------------------------------------------------------------
// Test surface — pure functions exported for unit tests.
// ---------------------------------------------------------------------------

export const __test__ = {
  looksLikeNaturalMemoRequest,
  detectForbiddenCall,
  buildBlockReason,
  buildPrependContext,
  executeRecallSync,
  cacheKey,
  sessionKeyToConversationId,
  // P2.29 audience surface
  extractSenderUserId,
  isOwnerAudience,
  audienceLabel,
  OWNER_USER_IDS,
  cache: userTextCache,
  counters,
};
