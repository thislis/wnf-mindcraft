package com.isttech.firewater.builder;

import com.isttech.firewater.stage.BlockPosition;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public final class BuilderSelection {
    private final Map<UUID, Selection> selections = new HashMap<>();

    public void setFirst(UUID player, BlockPosition position, String world) {
        Selection old = selections.getOrDefault(player, new Selection(null, null, world));
        BlockPosition second = world.equals(old.world()) ? old.second() : null;
        selections.put(player, new Selection(position, second, world));
    }

    public void setSecond(UUID player, BlockPosition position, String world) {
        Selection old = selections.getOrDefault(player, new Selection(null, null, world));
        BlockPosition first = world.equals(old.world()) ? old.first() : null;
        selections.put(player, new Selection(first, position, world));
    }

    public Selection get(UUID player) {
        return selections.get(player);
    }

    public record Selection(BlockPosition first, BlockPosition second, String world) {
        public boolean complete() {
            return first != null && second != null && world != null;
        }
    }
}
