package com.isttech.firewater.domain;

public final class HazardRules {
    private HazardRules() {
    }

    public static boolean isFatal(Role role, Hazard hazard) {
        return hazard == Hazard.POISON
            || (role == Role.WADE && hazard == Hazard.LAVA)
            || (role == Role.EMBER && hazard == Hazard.WATER);
    }
}
