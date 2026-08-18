package com.isttech.firewater.stage;

public record WallBlockSnapshot(BlockPosition position, String blockData) {
    public WallBlockSnapshot {
        if (position == null || blockData == null || blockData.isBlank()) {
            throw new IllegalArgumentException("Wall snapshot requires position and block data");
        }
    }
}
