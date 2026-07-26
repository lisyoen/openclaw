import Foundation

/// P7-b T-Native: 결과 회수 신뢰성 조정자 (순수 로직, 기획서 v8 task_id 계약).
/// - 회수 2경로(게이트웨이 이벤트 push / 재조회 pull) 중 먼저 도착한 쪽만 낭독하고 소비 완료 마킹.
/// - 재연결·네트워크 전환·인터럽션에서 새 요청을 만들지 않는다 — 동일 taskId 재조회만 (중복 실행 0).
/// - 동일 taskId 의 늦은/중복 도착은 낭독하지 않는다 (중복 낭독 0).
enum TalkRecoveryChannel: String, Equatable, Sendable {
    case push
    case pull
}

enum TalkRecoveryAction: Equatable, Sendable {
    /// 낭독 진행 (첫 도착 경로에서 정확히 1회만 발생).
    case speak(taskId: String, text: String)
    /// aborted/error/timeout 또는 본문 없는 final — 실패 처리, 낭독 없음.
    case fail(taskId: String, state: String)
    /// 소비 완료·stale — 무시.
    case drop(taskId: String, reason: String)
}

enum TalkRecoveryReconnectAction: Equatable, Sendable {
    /// 미회수 taskId 재조회만 수행. 새 요청 생성 금지.
    case pull(taskId: String)
    case resumeListening
}

struct TalkResultRecovery: Sendable {
    private(set) var activeTaskId: String?
    private(set) var consumedTaskIds: [String]
    private let consumedCapacity: Int

    init(consumedCapacity: Int = 16) {
        self.consumedCapacity = max(1, consumedCapacity)
        self.activeTaskId = nil
        self.consumedTaskIds = []
    }

    /// consult 시작. 활성 taskId 는 항상 1개만 유지 — 직전 미소비 taskId 는 stale 로
    /// 소비 마킹해 늦게 도착한 결과가 낭독되지 않게 한다.
    mutating func beginConsult(taskId: String) {
        if let previous = activeTaskId, previous != taskId {
            markConsumed(previous)
        }
        activeTaskId = taskId
    }

    /// push/pull 어느 경로로든 결과가 도착하면 호출한다. 반환 액션만 수행할 것.
    mutating func resultArrived(
        taskId: String,
        state: String,
        text: String?,
        via channel: TalkRecoveryChannel) -> TalkRecoveryAction
    {
        if isConsumed(taskId) {
            return .drop(taskId: taskId, reason: "already-consumed-\(channel.rawValue)")
        }
        guard taskId == activeTaskId else {
            markConsumed(taskId)
            return .drop(taskId: taskId, reason: "stale-task")
        }
        markConsumed(taskId)
        activeTaskId = nil
        if state == "final", let text, !text.isEmpty {
            return .speak(taskId: taskId, text: text)
        }
        return .fail(taskId: taskId, state: state)
    }

    /// 재연결 완료 직후 호출: 미회수 taskId 가 있으면 동일 taskId 재조회만 지시한다.
    /// 몇 번을 호출해도 같은 taskId 만 반환 (멱등 — 재연결 반복에도 새 요청 0).
    func reconnectAction() -> TalkRecoveryReconnectAction {
        if let activeTaskId { return .pull(taskId: activeTaskId) }
        return .resumeListening
    }

    /// interruption(전화·Siri)·백그라운드 전환은 회수 상태를 바꾸지 않는다 (taskId 보존).
    /// 호출부 의도를 드러내기 위한 명시적 no-op.
    func interruptionBegan() {}
    func interruptionEnded() {}

    /// 사용자 종료: 활성 taskId 를 소비 마킹해 종료 후 도착한 결과의 낭독을 막는다.
    mutating func endSession() {
        if let activeTaskId { markConsumed(activeTaskId) }
        activeTaskId = nil
    }

    func isConsumed(_ taskId: String) -> Bool {
        consumedTaskIds.contains(taskId)
    }

    private mutating func markConsumed(_ taskId: String) {
        guard !consumedTaskIds.contains(taskId) else { return }
        consumedTaskIds.append(taskId)
        if consumedTaskIds.count > consumedCapacity {
            consumedTaskIds.removeFirst(consumedTaskIds.count - consumedCapacity)
        }
    }
}
