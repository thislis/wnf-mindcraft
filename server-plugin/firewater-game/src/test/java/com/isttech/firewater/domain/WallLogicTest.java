package com.isttech.firewater.domain;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WallLogicTest {
    @Test
    void implementsDefaultVisibleXorAnyTrigger() {
        assertTrue(WallLogic.isVisible(true, false));
        assertFalse(WallLogic.isVisible(true, true));
        assertFalse(WallLogic.isVisible(false, false));
        assertTrue(WallLogic.isVisible(false, true));
    }

    @Test
    void duplicateActiveTriggersRemainOneLogicalSignal() {
        assertFalse(WallLogic.isVisible(true, List.of(true, true)));
        assertTrue(WallLogic.isVisible(false, List.of(true, true)));
        assertTrue(WallLogic.isVisible(true, List.of(false, false)));
    }
}
