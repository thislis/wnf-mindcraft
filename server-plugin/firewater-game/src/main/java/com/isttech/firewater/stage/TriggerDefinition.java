package com.isttech.firewater.stage;

public record TriggerDefinition(TriggerType type, BlockPosition position) {
    public TriggerDefinition {
        if (type == null || position == null) {
            throw new IllegalArgumentException("Trigger requires type and position");
        }
    }
}
