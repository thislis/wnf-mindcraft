package com.isttech.firewater.runtime;

import com.isttech.firewater.domain.ExitHoldTracker;
import com.isttech.firewater.domain.FailureLatch;
import com.isttech.firewater.domain.SessionState;
import com.isttech.firewater.domain.SessionStateMachine;
import com.isttech.firewater.stage.StageDefinition;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public final class StageSession {
    private final UUID sessionId = UUID.randomUUID();
    private final StageDefinition stage;
    private final SessionStateMachine state = new SessionStateMachine();
    private final FailureLatch<UUID> failureLatch = new FailureLatch<>();
    private final ExitHoldTracker exitHold;
    private final Map<String, Boolean> wallVisibility = new HashMap<>();
    private final Map<String, Boolean> wallTriggerActive = new HashMap<>();
    private final long startedAtMillis = System.currentTimeMillis();
    private int attempt = 1;
    private String pendingCause;
    private String pendingVictim;

    public StageSession(StageDefinition stage) {
        this.stage = stage;
        this.exitHold = new ExitHoldTracker(stage.finishHoldTicks());
    }

    public UUID sessionId() { return sessionId; }
    public StageDefinition stage() { return stage; }
    public SessionState state() { return state.state(); }
    public void transitionTo(SessionState next) { state.transitionTo(next); }
    public int attempt() { return attempt; }
    public long startedAtMillis() { return startedAtMillis; }
    public FailureLatch<UUID> failureLatch() { return failureLatch; }
    public ExitHoldTracker exitHold() { return exitHold; }
    public Map<String, Boolean> wallVisibility() { return wallVisibility; }
    public Map<String, Boolean> wallTriggerActive() { return wallTriggerActive; }
    public String pendingCause() { return pendingCause; }
    public String pendingVictim() { return pendingVictim; }

    public void markFailure(String cause, String victim) {
        pendingCause = cause;
        pendingVictim = victim;
    }

    public void beginNextAttempt() {
        attempt++;
        pendingCause = null;
        pendingVictim = null;
        failureLatch.reset();
        exitHold.reset();
        wallVisibility.clear();
        wallTriggerActive.clear();
    }
}
