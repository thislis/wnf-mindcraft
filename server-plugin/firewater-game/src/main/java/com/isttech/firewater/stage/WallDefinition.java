package com.isttech.firewater.stage;

import java.util.ArrayList;
import java.util.List;

public final class WallDefinition {
    private boolean defaultVisible;
    private final List<WallBlockSnapshot> blocks = new ArrayList<>();
    private final List<TriggerDefinition> triggers = new ArrayList<>();

    public WallDefinition(boolean defaultVisible) {
        this.defaultVisible = defaultVisible;
    }

    public boolean defaultVisible() {
        return defaultVisible;
    }

    public void setDefaultVisible(boolean defaultVisible) {
        this.defaultVisible = defaultVisible;
    }

    public List<WallBlockSnapshot> blocks() {
        return blocks;
    }

    public List<TriggerDefinition> triggers() {
        return triggers;
    }
}
