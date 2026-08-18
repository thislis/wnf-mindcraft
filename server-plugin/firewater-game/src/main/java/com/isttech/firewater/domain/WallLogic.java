package com.isttech.firewater.domain;

import java.util.Collection;

public final class WallLogic {
    private WallLogic() {
    }

    public static boolean isVisible(boolean defaultVisible, boolean anyTriggerActive) {
        return defaultVisible ^ anyTriggerActive;
    }

    public static boolean isVisible(boolean defaultVisible, Collection<Boolean> triggerStates) {
        return isVisible(defaultVisible, triggerStates.stream().anyMatch(Boolean.TRUE::equals));
    }
}
