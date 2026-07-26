import Foundation

/// P7-a T-Native: 사용자가 명시적으로 시작한 활성 Talk 세션의 백그라운드 지속 정책.
/// 순수 로직으로 분리해 시뮬레이터 없이도 단위 테스트한다.
enum TalkBackgroundPolicy {
    /// 백그라운드 전환 시 활성 세션을 유지할지 결정한다.
    /// 사용자가 켠 토글 + Talk 활성 + 사용자가 직접 시작한 세션일 때만 유지한다.
    /// (강제 종료 후 상시 청취·몰래 마이크 활성화는 범위 밖 — 세션이 없으면 유지도 없다.)
    static func shouldMaintainInBackground(
        backgroundEnabled: Bool,
        talkEnabled: Bool,
        userInitiatedActive: Bool) -> Bool
    {
        backgroundEnabled && talkEnabled && userInitiatedActive
    }

    /// 백그라운드에서 새 Talk 시작은 항상 금지 (포그라운드 사용자 조작만 시작 가능).
    static func allowsNewTalkStart(foregroundAllowed: Bool) -> Bool {
        foregroundAllowed
    }

    /// Realtime/relay 세션 (재)시작 허용: 포그라운드이거나, 유지 중인 활성 세션의 연속 동작일 때.
    static func allowsRealtimeStart(foregroundAllowed: Bool, maintainingBackground: Bool) -> Bool {
        foregroundAllowed || maintainingBackground
    }
}

/// P7 상태머신: idle → connecting → listening → consulting(taskId) → resultReady → speaking → listening
enum TalkFlowState: Equatable {
    case idle
    case connecting
    case listening
    case consulting(taskId: String?)
    case resultReady
    case speaking
    case reconnecting(taskId: String?)

    enum Event: Equatable {
        case startRequested
        case connected
        case transcriptFinal(taskId: String?)
        case resultArrived
        case speechStarted
        case speechFinished
        case stopped
        case interruptionBegan
        case interruptionEnded
        case connectionLost
        case reconnected
    }

    /// 이벤트 기반 전이 (타이머/nudge 없음). 미정의 조합은 현 상태 유지(멱등).
    func transitioned(on event: Event) -> TalkFlowState {
        switch (self, event) {
        case (_, .stopped): return .idle
        case (.idle, .startRequested): return .connecting
        case (.connecting, .connected): return .listening
        case (.listening, .transcriptFinal(let taskId)): return .consulting(taskId: taskId)
        case (.consulting, .resultArrived): return .resultReady
        case (.resultReady, .speechStarted): return .speaking
        case (.consulting, .speechStarted): return .speaking
        // P7-b 재연결: 새 요청 생성 금지 — 동일 taskId 유지, 재조회(pull)만 수행 (기획서 v8 계약).
        case (.consulting(let taskId), .connectionLost): return .reconnecting(taskId: taskId)
        case (.reconnecting, .connectionLost): return self
        case (.idle, .connectionLost): return .idle
        case (_, .connectionLost): return .reconnecting(taskId: nil)
        case (.reconnecting(let taskId), .reconnected):
            if let taskId { return .consulting(taskId: taskId) }
            return .listening
        case (.reconnecting, .resultArrived): return .resultReady
        case (.reconnecting, .speechStarted): return .speaking
        case (.speaking, .speechFinished): return .listening
        // interruption: 상태 보존(활성 taskId 유지). 복귀 시 청취 재개는 speaking 중이었으면 listening 으로.
        case (.speaking, .interruptionBegan): return .listening
        case (_, .interruptionBegan): return self
        case (_, .interruptionEnded): return self
        default: return self
        }
    }

    /// 게이트웨이 relay status 문자열 → 상태 매핑 (기존 handleRealtimeRelayStatus 의미 보존).
    static func fromRelayStatus(_ status: String, current: TalkFlowState) -> TalkFlowState {
        let s = status.lowercased()
        if s.contains("listening") { return .listening }
        if s.contains("thinking") {
            if case .consulting = current { return current }
            return .consulting(taskId: nil)
        }
        if s.contains("speaking") { return .speaking }
        if s.contains("reconnect") {
            if case .consulting(let taskId) = current { return .reconnecting(taskId: taskId) }
            if case .reconnecting = current { return current }
            return .reconnecting(taskId: nil)
        }
        if s == "ready" { return .idle }
        return current
    }
}
