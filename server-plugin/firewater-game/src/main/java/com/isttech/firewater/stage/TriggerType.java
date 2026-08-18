package com.isttech.firewater.stage;

public enum TriggerType {
    PAD,
    LEVER,
    BUTTON;

    public static TriggerType parse(String value) {
        return TriggerType.valueOf(value.trim().toUpperCase());
    }

    public String key() {
        return name().toLowerCase();
    }
}
