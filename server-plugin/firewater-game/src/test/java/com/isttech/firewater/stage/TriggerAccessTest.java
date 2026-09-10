package com.isttech.firewater.stage;

import com.isttech.firewater.domain.Role;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TriggerAccessTest {
    @Test
    void appliesRoleMatrixToEveryTriggerType() {
        for (TriggerType type : TriggerType.values()) {
            BlockPosition position = new BlockPosition(1, 2, 3);
            assertTrue(new TriggerDefinition(type, position, TriggerAccess.ANY).allows(Role.WADE));
            assertTrue(new TriggerDefinition(type, position, TriggerAccess.ANY).allows(Role.EMBER));
            assertTrue(new TriggerDefinition(type, position, TriggerAccess.WADE).allows(Role.WADE));
            assertFalse(new TriggerDefinition(type, position, TriggerAccess.WADE).allows(Role.EMBER));
            assertFalse(new TriggerDefinition(type, position, TriggerAccess.EMBER).allows(Role.WADE));
            assertTrue(new TriggerDefinition(type, position, TriggerAccess.EMBER).allows(Role.EMBER));
        }
    }

    @Test
    void missingRoleRemainsBackwardCompatibleAsAny() {
        TriggerDefinition legacy = new TriggerDefinition(TriggerType.LEVER, new BlockPosition(1, 2, 3));
        assertTrue(legacy.allows(Role.WADE));
        assertTrue(legacy.allows(Role.EMBER));
        assertTrue(TriggerAccess.parse(null).allows(Role.WADE));
        assertTrue(TriggerAccess.parse("").allows(Role.EMBER));
    }
}
