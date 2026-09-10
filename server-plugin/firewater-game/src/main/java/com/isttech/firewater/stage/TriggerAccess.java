package com.isttech.firewater.stage;

import com.isttech.firewater.domain.Role;

import java.util.Locale;
import java.util.Optional;

public enum TriggerAccess {
    ANY(null),
    WADE(Role.WADE),
    EMBER(Role.EMBER);

    private final Role requiredRole;

    TriggerAccess(Role requiredRole) {
        this.requiredRole = requiredRole;
    }

    public boolean allows(Role role) {
        return this == ANY || requiredRole == role;
    }

    public Optional<Role> requiredRole() {
        return Optional.ofNullable(requiredRole);
    }

    public String key() {
        return name().toLowerCase(Locale.ROOT);
    }

    public static TriggerAccess parse(String value) {
        if (value == null || value.isBlank()) return ANY;
        return TriggerAccess.valueOf(value.trim().toUpperCase(Locale.ROOT));
    }
}
