package com.isttech.firewater.domain;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class HazardRulesTest {
    @Test
    void appliesRoleMatrix() {
        assertFalse(HazardRules.isFatal(Role.WADE, Hazard.WATER));
        assertTrue(HazardRules.isFatal(Role.WADE, Hazard.LAVA));
        assertTrue(HazardRules.isFatal(Role.WADE, Hazard.POISON));
        assertTrue(HazardRules.isFatal(Role.EMBER, Hazard.WATER));
        assertFalse(HazardRules.isFatal(Role.EMBER, Hazard.LAVA));
        assertTrue(HazardRules.isFatal(Role.EMBER, Hazard.POISON));
    }
}
