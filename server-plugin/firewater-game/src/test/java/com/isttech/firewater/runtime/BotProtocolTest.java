package com.isttech.firewater.runtime;

import com.isttech.firewater.domain.Role;
import com.isttech.firewater.stage.BlockPosition;
import com.isttech.firewater.stage.FinishDefinition;
import com.isttech.firewater.stage.StageBounds;
import com.isttech.firewater.stage.StageDefinition;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertTrue;

class BotProtocolTest {
    @Test
    void startIncludesAuthoritativeWorldAndPlayBounds() {
        StageDefinition stage = new StageDefinition("protocol", "world_test");
        stage.setBounds(new StageBounds(new BlockPosition(-2, 64, -3), new BlockPosition(9, 80, 12)));
        stage.finishes().put(Role.WADE,
            new FinishDefinition(new BlockPosition(8, 64, 10), "light_blue_glazed_terracotta"));
        stage.finishes().put(Role.EMBER,
            new FinishDefinition(new BlockPosition(8, 64, 11), "orange_glazed_terracotta"));
        stage.poisonMaterials().add("lime_carpet");

        String message = BotProtocol.start(new StageSession(stage), "WadeBot", "EmberBot");
        assertTrue(message.contains("; wade-player=WadeBot; ember-player=EmberBot; lead-role=wade; lead=WadeBot;"));

        assertTrue(message.contains("; world=world_test;"));
        assertTrue(message.contains("; min-x=-2; min-y=64; min-z=-3;"));
        assertTrue(message.contains("; hold-ticks=10;"));
        assertTrue(message.contains("; max-x=9; max-y=80; max-z=12;"));
    }
}
