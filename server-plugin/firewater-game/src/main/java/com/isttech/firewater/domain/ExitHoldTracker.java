package com.isttech.firewater.domain;

public final class ExitHoldTracker {
    private final int requiredTicks;
    private int heldTicks;
    private boolean wadeOnExit;
    private boolean emberOnExit;

    public ExitHoldTracker(int requiredTicks) {
        if (requiredTicks < 1) {
            throw new IllegalArgumentException("requiredTicks must be positive");
        }
        this.requiredTicks = requiredTicks;
    }

    public boolean tick(boolean wadeOnExit, boolean emberOnExit) {
        this.wadeOnExit = wadeOnExit;
        this.emberOnExit = emberOnExit;
        heldTicks = wadeOnExit && emberOnExit ? heldTicks + 1 : 0;
        return heldTicks >= requiredTicks;
    }

    public void reset() {
        heldTicks = 0;
        wadeOnExit = false;
        emberOnExit = false;
    }

    public int heldTicks() {
        return heldTicks;
    }

    public boolean wadeOnExit() {
        return wadeOnExit;
    }

    public boolean emberOnExit() {
        return emberOnExit;
    }
}
