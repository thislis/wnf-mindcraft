package com.isttech.firewater.stage;

import com.isttech.firewater.domain.Role;

import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public final class StageDefinition {
    public static final int SCHEMA_VERSION = 1;

    private final String id;
    private String world;
    private boolean enabled;
    private String goal = "Both players must reach their matching exits.";
    private String botBrief = "Coordinate switches and use only your safe liquid route.";
    private StageBounds bounds;
    private TriggerDefinition startTrigger;
    private final Map<Role, StageLocation> spawns = new EnumMap<>(Role.class);
    private final Map<Role, FinishDefinition> finishes = new EnumMap<>(Role.class);
    private int finishHoldTicks = 10;
    private final Map<String, WallDefinition> walls = new LinkedHashMap<>();
    private final List<String> poisonMaterials = new ArrayList<>();

    public StageDefinition(String id, String world) {
        if (id == null || !id.matches("[a-z0-9][a-z0-9_-]{0,31}")) {
            throw new IllegalArgumentException("Stage id must match [a-z0-9][a-z0-9_-]{0,31}");
        }
        this.id = id;
        this.world = Objects.requireNonNull(world, "world");
    }

    public String id() { return id; }
    public String world() { return world; }
    public void setWorld(String world) { this.world = Objects.requireNonNull(world); }
    public boolean enabled() { return enabled; }
    public void setEnabled(boolean enabled) { this.enabled = enabled; }
    public String goal() { return goal; }
    public void setGoal(String goal) { this.goal = Objects.requireNonNull(goal).strip(); }
    public String botBrief() { return botBrief; }
    public void setBotBrief(String botBrief) { this.botBrief = Objects.requireNonNull(botBrief).strip(); }
    public StageBounds bounds() { return bounds; }
    public void setBounds(StageBounds bounds) { this.bounds = bounds; }
    public TriggerDefinition startTrigger() { return startTrigger; }
    public void setStartTrigger(TriggerDefinition startTrigger) { this.startTrigger = startTrigger; }
    public Map<Role, StageLocation> spawns() { return spawns; }
    public Map<Role, FinishDefinition> finishes() { return finishes; }
    public int finishHoldTicks() { return finishHoldTicks; }
    public void setFinishHoldTicks(int finishHoldTicks) {
        if (finishHoldTicks < 1) throw new IllegalArgumentException("finish hold ticks must be positive");
        this.finishHoldTicks = finishHoldTicks;
    }
    public Map<String, WallDefinition> walls() { return walls; }
    public List<String> poisonMaterials() { return poisonMaterials; }
}
