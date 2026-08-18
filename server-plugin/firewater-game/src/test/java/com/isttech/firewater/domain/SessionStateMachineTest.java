package com.isttech.firewater.domain;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class SessionStateMachineTest {
    @Test
    void acceptsRuntimeLifecycle() {
        SessionStateMachine machine = new SessionStateMachine();
        machine.transitionTo(SessionState.STARTING);
        machine.transitionTo(SessionState.RUNNING);
        machine.transitionTo(SessionState.RESETTING);
        machine.transitionTo(SessionState.RUNNING);
        machine.transitionTo(SessionState.CLEARED);
        machine.transitionTo(SessionState.IDLE);
        assertEquals(SessionState.IDLE, machine.state());
    }

    @Test
    void rejectsSkippedTransitions() {
        SessionStateMachine machine = new SessionStateMachine();
        assertThrows(IllegalStateException.class, () -> machine.transitionTo(SessionState.RUNNING));
    }
}
