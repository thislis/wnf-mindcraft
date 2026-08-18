package com.isttech.firewater.domain;

import java.util.HashSet;
import java.util.Set;

public final class MessageDeduplicator {
    private final Set<String> sentKeys = new HashSet<>();

    public boolean shouldSend(String key) {
        return sentKeys.add(key);
    }

    public void clear() {
        sentKeys.clear();
    }
}
