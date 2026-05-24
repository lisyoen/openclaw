import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

type AbortResult = { handled: boolean; aborted: boolean; stoppedSubagents?: number };

const mocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
  tryFastAbortFromMessage: vi.fn<() => Promise<AbortResult>>(async () => ({
    handled: false,
    aborted: false,
  })),
}));
const diagnosticMocks = vi.hoisted(() => ({
  logMessageQueued: vi.fn(),
  logMessageProcessed: vi.fn(),
  logSessionStateChange: vi.fn(),
}));
const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runMessageReceived: vi.fn(async () => {}),
  },
}));
const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(),
  triggerInternalHook: vi.fn(async () => {}),
}));
const acpMocks = vi.hoisted(() => ({
  listAcpSessionEntries: vi.fn(async () => []),
  readAcpSessionEntry: vi.fn<() => unknown>(() => null),
  upsertAcpSessionMeta: vi.fn(async () => null),
  requireAcpRuntimeBackend: vi.fn<() => unknown>(),
}));
const sessionBindingMocks = vi.hoisted(() => ({
  listBySession: vi.fn<(targetSessionKey: string) => SessionBindingRecord[]>(() => []),
}));
const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: ReplyPayload };
    return params.payload;
  }),
  normalizeTtsAutoMode: vi.fn((value: unknown) => (typeof value === "string" ? value : undefined)),
  resolveTtsConfig: vi.fn((_cfg: OpenClawConfig) => ({ mode: "final" })),
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) =>
    Boolean(
      channel &&
      ["telegram", "slack", "discord", "signal", "imessage", "whatsapp", "feishu"].includes(
        channel,
      ),
    ),
  routeReply: mocks.routeReply,
}));

vi.mock("./abort.js", () => ({
  tryFastAbortFromMessage: mocks.tryFastAbortFromMessage,
  formatAbortReplyText: () => "⚙️ Agent was aborted.",
}));

vi.mock("../../logging/diagnostic.js", () => ({
  logMessageQueued: diagnosticMocks.logMessageQueued,
  logMessageProcessed: diagnosticMocks.logMessageProcessed,
  logSessionStateChange: diagnosticMocks.logSessionStateChange,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: internalHookMocks.createInternalHookEvent,
  triggerInternalHook: internalHookMocks.triggerInternalHook,
}));
vi.mock("../../acp/runtime/session-meta.js", () => ({
  listAcpSessionEntries: acpMocks.listAcpSessionEntries,
  readAcpSessionEntry: acpMocks.readAcpSessionEntry,
  upsertAcpSessionMeta: acpMocks.upsertAcpSessionMeta,
}));
vi.mock("../../acp/runtime/registry.js", () => ({
  requireAcpRuntimeBackend: acpMocks.requireAcpRuntimeBackend,
}));
vi.mock("../../infra/outbound/session-binding-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/session-binding-service.js")>();
  return {
    ...actual,
    getSessionBindingService: () => ({
      bind: vi.fn(async () => {
        throw new Error("bind not mocked");
      }),
      getCapabilities: vi.fn(() => ({
        adapterAvailable: true,
        bindSupported: true,
        unbindSupported: true,
        placements: ["current", "child"] as const,
      })),
      listBySession: (targetSessionKey: string) =>
        sessionBindingMocks.listBySession(targetSessionKey),
      resolveByConversation: vi.fn(() => null),
      touch: vi.fn(),
      unbind: vi.fn(async () => []),
    }),
  };
});
vi.mock("../../tts/tts.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
  normalizeTtsAutoMode: (value: unknown) => ttsMocks.normalizeTtsAutoMode(value),
  resolveTtsConfig: (cfg: OpenClawConfig) => ttsMocks.resolveTtsConfig(cfg),
}));

const { dispatchReplyFromConfig } = await import("./dispatch-from-config.js");
const { resetInboundDedupe } = await import("./inbound-dedupe.js");
const { __testing: acpManagerTesting } = await import("../../acp/control-plane/manager.js");

const noAbortResult = { handled: false, aborted: false } as const;
const emptyConfig = {} as OpenClawConfig;

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

describe("dispatchReplyFromConfig — P2.26 empty-response retry guard", () => {
  beforeEach(() => {
    acpManagerTesting.resetAcpSessionManagerForTests();
    resetInboundDedupe();
    mocks.routeReply.mockReset();
    mocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });
    acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
    diagnosticMocks.logMessageQueued.mockClear();
    diagnosticMocks.logMessageProcessed.mockClear();
    diagnosticMocks.logSessionStateChange.mockClear();
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runMessageReceived.mockClear();
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockClear();
    acpMocks.readAcpSessionEntry.mockReset();
    acpMocks.readAcpSessionEntry.mockReturnValue(null);
    acpMocks.upsertAcpSessionMeta.mockReset();
    acpMocks.upsertAcpSessionMeta.mockResolvedValue(null);
    acpMocks.requireAcpRuntimeBackend.mockReset();
    sessionBindingMocks.listBySession.mockReset();
    sessionBindingMocks.listBySession.mockReturnValue([]);
    ttsMocks.maybeApplyTtsToPayload.mockClear();
    ttsMocks.normalizeTtsAutoMode.mockClear();
    ttsMocks.resolveTtsConfig.mockClear();
    ttsMocks.resolveTtsConfig.mockReturnValue({ mode: "final" });
    setNoAbort();
  });

  it("retries once when first run returns payloadCount=0 + stopReason=toolUse and retry succeeds", async () => {
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", ChatType: "direct" });

    let callCount = 0;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ): Promise<ReplyPayload | undefined> => {
      callCount += 1;
      if (callCount === 1) {
        await opts?.onAgentRunEnd?.({
          runId: "run-1",
          stopReason: "toolUse",
          payloadCount: 0,
          totalTextLength: 0,
        });
        return undefined;
      }
      await opts?.onAgentRunEnd?.({
        runId: "run-2",
        stopReason: "stop",
        payloadCount: 1,
        totalTextLength: 5,
      });
      return { text: "안녕" };
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(callCount).toBe(2);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "안녕" });
  });

  it("sends fallback message when both first run and retry return empty + toolUse", async () => {
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", ChatType: "direct" });

    let callCount = 0;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ): Promise<ReplyPayload | undefined> => {
      callCount += 1;
      await opts?.onAgentRunEnd?.({
        runId: `run-${callCount}`,
        stopReason: "toolUse",
        payloadCount: 0,
        totalTextLength: 0,
      });
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(callCount).toBe(2);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    const sent = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(sent).toEqual({ text: "응답이 비어서 한 번 더 시도했어. 다시 말해줄래?" });
  });

  it("does not retry when payloadCount>0 and stopReason=stop (normal completion)", async () => {
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", ChatType: "direct" });

    let callCount = 0;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ): Promise<ReplyPayload> => {
      callCount += 1;
      await opts?.onAgentRunEnd?.({
        runId: "run-1",
        stopReason: "stop",
        payloadCount: 1,
        totalTextLength: 7,
      });
      return { text: "안녕하세요" };
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(callCount).toBe(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "안녕하세요" });
  });

  it("does not retry when payloadCount>0 and stopReason=toolUse (agent commentary with tool call)", async () => {
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", ChatType: "direct" });

    let callCount = 0;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ): Promise<ReplyPayload> => {
      callCount += 1;
      await opts?.onAgentRunEnd?.({
        runId: "run-1",
        stopReason: "toolUse",
        payloadCount: 1,
        totalTextLength: 12,
      });
      return { text: "도구 호출 중" };
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(callCount).toBe(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "도구 호출 중" });
  });

  it("does not retry when payloadCount=0 and stopReason=stop (genuinely silent)", async () => {
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", ChatType: "direct" });

    let callCount = 0;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ): Promise<ReplyPayload | undefined> => {
      callCount += 1;
      await opts?.onAgentRunEnd?.({
        runId: "run-1",
        stopReason: "stop",
        payloadCount: 0,
        totalTextLength: 0,
      });
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(callCount).toBe(1);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("does not retry when stopReason is undefined (defensive — no toolUse signal)", async () => {
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "telegram", ChatType: "direct" });

    let callCount = 0;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
      _cfg?: OpenClawConfig,
    ): Promise<ReplyPayload | undefined> => {
      callCount += 1;
      await opts?.onAgentRunEnd?.({
        runId: "run-1",
        stopReason: undefined,
        payloadCount: 0,
        totalTextLength: 0,
      });
      return undefined;
    };

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(callCount).toBe(1);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });
});
