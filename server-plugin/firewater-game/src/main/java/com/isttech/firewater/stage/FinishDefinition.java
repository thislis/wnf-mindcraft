package com.isttech.firewater.stage;

public record FinishDefinition(BlockPosition position, String material) {
    public FinishDefinition {
        if (position == null || material == null || material.isBlank()) {
            throw new IllegalArgumentException("Finish requires position and material");
        }
    }
}
