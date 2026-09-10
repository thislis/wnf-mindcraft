package com.isttech.firewater.stage;

import com.isttech.firewater.domain.Role;

public record TriggerDefinition(TriggerType type, BlockPosition position, TriggerAccess access) {
    public TriggerDefinition(TriggerType type, BlockPosition position) {
        this(type, position, TriggerAccess.ANY);
    }

    public TriggerDefinition {
        if (type == null || position == null || access == null) {
            throw new IllegalArgumentException("Trigger requires type, position, and access");
        }
    }

    public boolean allows(Role role) {
        return access.allows(role);
    }
}
