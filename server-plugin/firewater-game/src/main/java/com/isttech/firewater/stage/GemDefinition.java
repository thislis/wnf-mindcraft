package com.isttech.firewater.stage;

/** Observation contract for a gem collected by the stage's existing game logic. */
public record GemDefinition(BlockPosition position, String material, TriggerAccess access,
                            double offsetY, double radius) {
    public GemDefinition {
        if (position == null || access == null || material == null ||
            !material.matches("[a-z_]+") || !Double.isFinite(offsetY) || Math.abs(offsetY) > 2 ||
            !Double.isFinite(radius) || radius <= 0.5 || radius > 4) {
            throw new IllegalArgumentException("Invalid gem observation/collection contract");
        }
    }
}
