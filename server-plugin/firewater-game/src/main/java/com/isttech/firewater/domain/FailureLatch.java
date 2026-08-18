package com.isttech.firewater.domain;

import java.util.HashSet;
import java.util.Set;

public final class FailureLatch<T> {
    private final Set<T> latched = new HashSet<>();

    public boolean latch(T key) {
        return latched.add(key);
    }

    public boolean isLatched(T key) {
        return latched.contains(key);
    }

    public void reset() {
        latched.clear();
    }
}
