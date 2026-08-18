package com.isttech.firewater.domain;

import java.util.EnumMap;
import java.util.EnumSet;
import java.util.Map;
import java.util.Set;

public final class SessionStateMachine {
    private static final Map<SessionState, Set<SessionState>> ALLOWED = new EnumMap<>(SessionState.class);

    static {
        ALLOWED.put(SessionState.IDLE, EnumSet.of(SessionState.STARTING));
        ALLOWED.put(SessionState.STARTING, EnumSet.of(SessionState.RUNNING, SessionState.IDLE));
        ALLOWED.put(SessionState.RUNNING, EnumSet.of(SessionState.RESETTING, SessionState.CLEARED, SessionState.IDLE));
        ALLOWED.put(SessionState.RESETTING, EnumSet.of(SessionState.RUNNING, SessionState.IDLE));
        ALLOWED.put(SessionState.CLEARED, EnumSet.of(SessionState.IDLE));
    }

    private SessionState state = SessionState.IDLE;

    public SessionState state() {
        return state;
    }

    public void transitionTo(SessionState next) {
        if (!ALLOWED.getOrDefault(state, Set.of()).contains(next)) {
            throw new IllegalStateException("Invalid Firewater state transition: " + state + " -> " + next);
        }
        state = next;
    }
}
