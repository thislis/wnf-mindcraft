package com.isttech.firewater.builder;

import com.isttech.firewater.stage.BlockPosition;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

class BuilderSelectionTest {
    @Test
    void changingWorldClearsTheOppositePoint() {
        BuilderSelection selections = new BuilderSelection();
        UUID player = UUID.randomUUID();
        selections.setFirst(player, new BlockPosition(1, 2, 3), "world");
        selections.setSecond(player, new BlockPosition(4, 5, 6), "world_nether");

        BuilderSelection.Selection selection = selections.get(player);
        assertNull(selection.first());
        assertFalse(selection.complete());
    }
}
