package com.isttech.firewater.domain;

public enum Role {
    WADE,
    EMBER;

    public static Role parse(String value) {
        return Role.valueOf(value.trim().toUpperCase());
    }

    public String key() {
        return name().toLowerCase();
    }
}
