package com.isttech.firewater.stage;

public record StageBounds(BlockPosition min, BlockPosition max) {
    public StageBounds {
        if (min == null || max == null) {
            throw new IllegalArgumentException("Bounds require min and max positions");
        }
        BlockPosition low = new BlockPosition(
            Math.min(min.x(), max.x()), Math.min(min.y(), max.y()), Math.min(min.z(), max.z()));
        BlockPosition high = new BlockPosition(
            Math.max(min.x(), max.x()), Math.max(min.y(), max.y()), Math.max(min.z(), max.z()));
        min = low;
        max = high;
    }

    public boolean contains(BlockPosition position) {
        return position != null
            && position.x() >= min.x() && position.x() <= max.x()
            && position.y() >= min.y() && position.y() <= max.y()
            && position.z() >= min.z() && position.z() <= max.z();
    }

    public boolean contains(double minX, double minY, double minZ, double maxX, double maxY, double maxZ) {
        double epsilon = 1.0e-7;
        return minX >= min.x() - epsilon
            && minY >= min.y() - epsilon
            && minZ >= min.z() - epsilon
            && maxX <= max.x() + 1.0 + epsilon
            && maxY <= max.y() + 1.0 + epsilon
            && maxZ <= max.z() + 1.0 + epsilon;
    }

    public boolean overlaps(StageBounds other) {
        return other != null
            && min.x() <= other.max.x() && max.x() >= other.min.x()
            && min.y() <= other.max.y() && max.y() >= other.min.y()
            && min.z() <= other.max.z() && max.z() >= other.min.z();
    }
}
