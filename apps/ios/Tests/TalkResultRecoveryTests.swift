import Foundation
import Testing
@testable import OpenClaw

struct TalkResultRecoveryTests {
    // MARK: - 회수 2경로 · 중복 낭독 0

    @Test func `push final speaks exactly once and duplicate push is dropped`() {
        var r = TalkResultRecovery()
        r.beginConsult(taskId: "t1")
        let first = r.resultArrived(taskId: "t1", state: "final", text: "안녕", via: .push)
        #expect(first == .speak(taskId: "t1", text: "안녕"))
        let dup = r.resultArrived(taskId: "t1", state: "final", text: "안녕", via: .push)
        #expect(dup == .drop(taskId: "t1", reason: "already-consumed-push"))
    }

    @Test func `push first then pull of same task is dropped`() {
        var r = TalkResultRecovery()
        r.beginConsult(taskId: "t1")
        _ = r.resultArrived(taskId: "t1", state: "final", text: "결과", via: .push)
        let pull = r.resultArrived(taskId: "t1", state: "final", text: "결과", via: .pull)
        #expect(pull == .drop(taskId: "t1", reason: "already-consumed-pull"))
    }

    @Test func `pull first then late push of same task is dropped`() {
        var r = TalkResultRecovery()
        r.beginConsult(taskId: "t1")
        let pull = r.resultArrived(taskId: "t1", state: "final", text: "결과", via: .pull)
        #expect(pull == .speak(taskId: "t1", text: "결과"))
        let push = r.resultArrived(taskId: "t1", state: "final", text: "결과", via: .push)
        #expect(push == .drop(taskId: "t1", reason: "already-consumed-push"))
    }

    // MARK: - 재연결: 새 요청 0, 동일 taskId 재조회만

    @Test func `reconnect during consult pulls the same task id and is idempotent`() {
        var r = TalkResultRecovery()
        r.beginConsult(taskId: "t1")
        #expect(r.reconnectAction() == .pull(taskId: "t1"))
        #expect(r.reconnectAction() == .pull(taskId: "t1"))
        #expect(r.activeTaskId == "t1")
    }

    @Test func `reconnect with no pending task resumes listening`() {
        var r = TalkResultRecovery()
        #expect(r.reconnectAction() == .resumeListening)
        r.beginConsult(taskId: "t1")
        _ = r.resultArrived(taskId: "t1", state: "final", text: "결과", via: .push)
        #expect(r.reconnectAction() == .resumeListening)
    }

    // MARK: - 실패 상태 · 빈 본문

    @Test func `error state fails once and later final for same task is dropped`() {
        var r = TalkResultRecovery()
        r.beginConsult(taskId: "t1")
        let fail = r.resultArrived(taskId: "t1", state: "error", text: nil, via: .push)
        #expect(fail == .fail(taskId: "t1", state: "error"))
        let late = r.resultArrived(taskId: "t1", state: "final", text: "늦은 결과", via: .pull)
        #expect(late == .drop(taskId: "t1", reason: "already-consumed-pull"))
    }

    @Test func `final without text is a failure not a speak`() {
        var r = TalkResultRecovery()
        r.beginConsult(taskId: "t1")
        #expect(r.resultArrived(taskId: "t1", state: "final", text: nil, via: .push)
            == .fail(taskId: "t1", state: "final"))
        var r2 = TalkResultRecovery()
        r2.beginConsult(taskId: "t2")
        #expect(r2.resultArrived(taskId: "t2", state: "final", text: "", via: .pull)
            == .fail(taskId: "t2", state: "final"))
    }

    @Test func `timeout and aborted fail once and duplicates are dropped`() {
        var r = TalkResultRecovery()
        r.beginConsult(taskId: "t1")
        #expect(r.resultArrived(taskId: "t1", state: "timeout", text: nil, via: .push)
            == .fail(taskId: "t1", state: "timeout"))
        #expect(r.resultArrived(taskId: "t1", state: "timeout", text: nil, via: .push)
            == .drop(taskId: "t1", reason: "already-consumed-push"))
    }

    // MARK: - 활성 taskId 1개 · stale 차단 · 세션 종료

    @Test func `new consult supersedes old task and late old result is dropped`() {
        var r = TalkResultRecovery()
        r.beginConsult(taskId: "t1")
        r.beginConsult(taskId: "t2")
        let stale = r.resultArrived(taskId: "t1", state: "final", text: "옛 결과", via: .push)
        #expect(stale == .drop(taskId: "t1", reason: "already-consumed-push"))
        #expect(r.resultArrived(taskId: "t2", state: "final", text: "새 결과", via: .push)
            == .speak(taskId: "t2", text: "새 결과"))
    }

    @Test func `unknown task id is marked stale and never spoken`() {
        var r = TalkResultRecovery()
        r.beginConsult(taskId: "t1")
        #expect(r.resultArrived(taskId: "ghost", state: "final", text: "유령", via: .push)
            == .drop(taskId: "ghost", reason: "stale-task"))
        #expect(r.resultArrived(taskId: "ghost", state: "final", text: "유령", via: .pull)
            == .drop(taskId: "ghost", reason: "already-consumed-pull"))
    }

    @Test func `end session consumes active task so late results stay silent`() {
        var r = TalkResultRecovery()
        r.beginConsult(taskId: "t1")
        r.endSession()
        #expect(r.activeTaskId == nil)
        #expect(r.resultArrived(taskId: "t1", state: "final", text: "종료 후 결과", via: .push)
            == .drop(taskId: "t1", reason: "already-consumed-push"))
    }

    @Test func `interruption preserves the pending task id`() {
        var r = TalkResultRecovery()
        r.beginConsult(taskId: "t1")
        r.interruptionBegan()
        r.interruptionEnded()
        #expect(r.activeTaskId == "t1")
        #expect(r.reconnectAction() == .pull(taskId: "t1"))
    }

    @Test func `consumed list keeps only recent ids within capacity`() {
        var r = TalkResultRecovery(consumedCapacity: 2)
        r.beginConsult(taskId: "t1")
        _ = r.resultArrived(taskId: "t1", state: "final", text: "1", via: .push)
        r.beginConsult(taskId: "t2")
        _ = r.resultArrived(taskId: "t2", state: "final", text: "2", via: .push)
        r.beginConsult(taskId: "t3")
        _ = r.resultArrived(taskId: "t3", state: "final", text: "3", via: .push)
        #expect(!r.isConsumed("t1"))
        #expect(r.isConsumed("t2"))
        #expect(r.isConsumed("t3"))
    }
}

struct TalkFlowStateReconnectTests {
    @Test func `connection loss during consult preserves task id`() {
        let s = TalkFlowState.consulting(taskId: "t1").transitioned(on: .connectionLost)
        #expect(s == .reconnecting(taskId: "t1"))
    }

    @Test func `repeated connection loss is idempotent`() {
        let s = TalkFlowState.reconnecting(taskId: "t1").transitioned(on: .connectionLost)
        #expect(s == .reconnecting(taskId: "t1"))
    }

    @Test func `idle ignores connection loss`() {
        #expect(TalkFlowState.idle.transitioned(on: .connectionLost) == .idle)
    }

    @Test func `listening without task reconnects without task id`() {
        #expect(TalkFlowState.listening.transitioned(on: .connectionLost)
            == .reconnecting(taskId: nil))
    }

    @Test func `reconnected with pending task returns to consulting`() {
        let s = TalkFlowState.reconnecting(taskId: "t1").transitioned(on: .reconnected)
        #expect(s == .consulting(taskId: "t1"))
    }

    @Test func `reconnected without pending task returns to listening`() {
        #expect(TalkFlowState.reconnecting(taskId: nil).transitioned(on: .reconnected)
            == .listening)
    }

    @Test func `result arriving while reconnecting becomes result ready`() {
        #expect(TalkFlowState.reconnecting(taskId: "t1").transitioned(on: .resultArrived)
            == .resultReady)
    }

    @Test func `stop while reconnecting ends the session`() {
        #expect(TalkFlowState.reconnecting(taskId: "t1").transitioned(on: .stopped) == .idle)
    }

    @Test func `interruption while reconnecting preserves state`() {
        #expect(TalkFlowState.reconnecting(taskId: "t1").transitioned(on: .interruptionBegan)
            == .reconnecting(taskId: "t1"))
    }
}
