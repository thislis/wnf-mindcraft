package com.isttech.firewater.stage;

public record StageLocation(double x, double y, double z, float yaw, float pitch) {
    public BlockPosition blockPosition() {
        return new BlockPosition(floor(x), floor(y), floor(z));
    }

    private static int floor(double value) {
        int integer = (int) value;
        return value < integer ? integer - 1 : integer;
    }
}
