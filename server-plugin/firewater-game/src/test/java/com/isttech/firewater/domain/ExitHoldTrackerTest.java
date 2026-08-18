package com.isttech.firewater.domain;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ExitHoldTrackerTest {
    @Test
    void requiresBothPlayersForConsecutiveTicks() {
        ExitHoldTracker tracker = new ExitHoldTracker(3);
        assertFalse(tracker.tick(true, false));
        assertEquals(0, tracker.heldTicks());
        assertFalse(tracker.tick(true, true));
        assertFalse(tracker.tick(true, true));
        assertTrue(tracker.tick(true, true));
    }

    @Test
    void leavingAnExitResetsTheHold() {
        ExitHoldTracker tracker = new ExitHoldTracker(2);
        tracker.tick(true, true);
        assertFalse(tracker.tick(false, true));
        assertEquals(0, tracker.heldTicks());
        assertFalse(tracker.tick(true, true));
        assertTrue(tracker.tick(true, true));
    }
}
