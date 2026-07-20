import Foundation
import Testing
@testable import OpenClaw

struct TalkBackgroundPolicyTests {
    @Test func `active user session with toggle keeps running in background`() {
        #expect(TalkBackgroundPolicy.shouldMaintainInBackground(
            backgroundEnabled: true, talkEnabled: true, userInitiatedActive: true))
    }

    @Test func `no user session means no background persistence`() {
        #expect(!TalkBackgroundPolicy.shouldMaintainInBackground(
            backgroundEnabled: true, talkEnabled: true, userInitiatedActive: false))
        #expect(!TalkBackgroundPolicy.shouldMaintainInBackground(
            backgroundEnabled: true, talkEnabled: false, userInitiatedActive: true))
        #expect(!TalkBackgroundPolicy.shouldMaintainInBackground(
            backgroundEnabled: false, talkEnabled: true, userInitiatedActive: true))
    }

    @Test func `background never starts a new talk session`() {
        #expect(!TalkBackgroundPolicy.allowsNewTalkStart(foregroundAllowed: false))
        #expect(TalkBackgroundPolicy.allowsNewTalkStart(foregroundAllowed: true))
    }

    @Test func `realtime restart allowed only in foreground or maintained session`() {
        #expect(TalkBackgroundPolicy.allowsRealtimeStart(foregroundAllowed: false, maintainingBackground: true))
        #expect(TalkBackgroundPolicy.allowsRealtimeStart(foregroundAllowed: true, maintainingBackground: false))
        #expect(!TalkBackgroundPolicy.allowsRealtimeStart(foregroundAllowed: false, maintainingBackground: false))
    }

    @Test func `state machine follows the p7 flow`() {
        var s = TalkFlowState.idle
        s = s.transitioned(on: .startRequested); #expect(s == .connecting)
        s = s.transitioned(on: .connected); #expect(s == .listening)
        s = s.transitioned(on: .transcriptFinal(taskId: "t1")); #expect(s == .consulting(taskId: "t1"))
        s = s.transitioned(on: .resultArrived); #expect(s == .resultReady)
        s = s.transitioned(on: .speechStarted); #expect(s == .speaking)
        s = s.transitioned(on: .speechFinished); #expect(s == .listening)
    }

    @Test func `user stop cleans up to idle from any state`() {
        #expect(TalkFlowState.speaking.transitioned(on: .stopped) == .idle)
        #expect(TalkFlowState.consulting(taskId: "x").transitioned(on: .stopped) == .idle)
        #expect(TalkFlowState.connecting.transitioned(on: .stopped) == .idle)
    }

    @Test func `interruption and resume do not duplicate sessions`() {
        let consulting = TalkFlowState.consulting(taskId: "keep")
        let afterBegan = consulting.transitioned(on: .interruptionBegan)
        #expect(afterBegan == consulting) // taskId 보존
        let afterEnded = afterBegan.transitioned(on: .interruptionEnded)
        #expect(afterEnded == consulting) // 멱등 — 재시작/중복 전이 없음
        // 동일 이벤트 반복도 멱등
        #expect(afterEnded.transitioned(on: .interruptionEnded) == consulting)
    }

    @Test func `relay status mapping preserves consulting task`() {
        let c = TalkFlowState.consulting(taskId: "t9")
        #expect(TalkFlowState.fromRelayStatus("Thinking…", current: c) == c)
        #expect(TalkFlowState.fromRelayStatus("Listening (Realtime)", current: c) == .listening)
        #expect(TalkFlowState.fromRelayStatus("Speaking", current: .resultReady) == .speaking)
        #expect(TalkFlowState.fromRelayStatus("Ready", current: .speaking) == .idle)
    }
}
