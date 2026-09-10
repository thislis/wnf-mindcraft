package com.isttech.firewater.stage;

import com.isttech.firewater.domain.Role;
import com.isttech.firewater.runtime.BotProtocol;
import com.isttech.firewater.runtime.StageSession;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.io.File;
import java.util.List;
import java.util.logging.Logger;
import static org.junit.jupiter.api.Assertions.*;

class GemContractTest {
    @TempDir File directory;

    @Test
    void persistsAndTransmitsExactGemCentersAndDeviceRoles() throws Exception {
        StageRepository repository = new StageRepository(directory, Logger.getAnonymousLogger(), List.of("lime_carpet"));
        StageDefinition stage = repository.create("gems", "world");
        stage.setBounds(new StageBounds(new BlockPosition(1600, -64, 0), new BlockPosition(1674, -46, 30)));
        stage.finishes().put(Role.WADE, new FinishDefinition(new BlockPosition(1672, -51, 13), "light_blue_glazed_terracotta"));
        stage.finishes().put(Role.EMBER, new FinishDefinition(new BlockPosition(1672, -51, 17), "orange_glazed_terracotta"));
        stage.gems().add(new GemDefinition(new BlockPosition(1614, -59, 7), "blue_stained_glass", TriggerAccess.WADE, -0.5, 2.1));
        stage.gems().add(new GemDefinition(new BlockPosition(1614, -59, 23), "red_stained_glass", TriggerAccess.EMBER, -0.5, 2.1));
        stage.gems().add(new GemDefinition(new BlockPosition(1669, -49, 15), "emerald_block", TriggerAccess.ANY, -0.5, 2.1));
        WallDefinition wall = new WallDefinition(true);
        wall.triggers().add(new TriggerDefinition(TriggerType.LEVER, new BlockPosition(1621, -60, 7), TriggerAccess.WADE));
        wall.triggers().add(new TriggerDefinition(TriggerType.LEVER, new BlockPosition(1621, -60, 23), TriggerAccess.EMBER));
        stage.walls().put("gate", wall);
        repository.save(stage);
        repository.reload();
        StageDefinition loaded = repository.find("gems").orElseThrow();
        assertEquals(stage.gems(), loaded.gems());
        String message = BotProtocol.start(new StageSession(loaded), "Wade", "Ember");
        assertTrue(message.contains("interaction-roles=1621,-60,7,wade|1621,-60,23,ember"));
        assertTrue(message.contains("1614,-59,7,blue_stained_glass,wade,-0.5,2.1"));
        assertTrue(message.contains("1614,-59,23,red_stained_glass,ember,-0.5,2.1"));
        assertTrue(message.contains("1669,-49,15,emerald_block,any,-0.5,2.1"));
    }

    @Test
    void rejectsInvalidCollectionRadiusAndPositionContracts() {
        assertThrows(IllegalArgumentException.class, () -> new GemDefinition(new BlockPosition(0, 0, 0), "blue_stained_glass", TriggerAccess.WADE, -0.5, Double.NaN));
        assertThrows(IllegalArgumentException.class, () -> new GemDefinition(new BlockPosition(0, 0, 0), "blue_stained_glass", TriggerAccess.WADE, 9, 2.1));
        StageDefinition stage = new StageDefinition("gems", "world");
        stage.setBounds(new StageBounds(new BlockPosition(0, 0, 0), new BlockPosition(10, 10, 10)));
        stage.gems().add(new GemDefinition(new BlockPosition(20, 0, 0), "blue_stained_glass", TriggerAccess.WADE, -0.5, 2.1));
        assertTrue(StageValidator.validateStructure(stage, 1000).stream().anyMatch(error -> error.contains("gem") && error.contains("outside")));
    }
}
