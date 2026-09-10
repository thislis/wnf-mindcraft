package com.isttech.firewater.runtime;

import com.isttech.firewater.domain.Role;
import com.isttech.firewater.stage.StageDefinition;

public final class BotProtocol {
    private BotProtocol() {
    }

    public static String start(StageSession session, String wadeName, String emberName) {
        StageDefinition stage = session.stage();
        var bounds = stage.bounds();
        return "[FWG:START] session=" + session.sessionId() + "; stage=" + stage.id() + "; attempt=" + session.attempt()
            + "; wade-player=" + clean(wadeName) + "; ember-player=" + clean(emberName)
            + "; lead-role=wade; lead=" + clean(wadeName) + "; world=" + clean(stage.world())
            + "; min-x=" + bounds.min().x() + "; min-y=" + bounds.min().y() + "; min-z=" + bounds.min().z()
            + "; max-x=" + bounds.max().x() + "; max-y=" + bounds.max().y() + "; max-z=" + bounds.max().z()
            + "; wade-exit=" + clean(stage.finishes().get(Role.WADE).material())
            + "; ember-exit=" + clean(stage.finishes().get(Role.EMBER).material())
            + "; hold-ticks=" + stage.finishHoldTicks()
            + "; poison=" + clean(String.join(",", stage.poisonMaterials()))
            + "; interaction-roles=" + stage.walls().values().stream()
                .flatMap(wall -> wall.triggers().stream()).distinct()
                .map(trigger -> trigger.position().x() + "," + trigger.position().y() + "," + trigger.position().z()
                    + "," + trigger.access().key()).collect(java.util.stream.Collectors.joining("|"))
            + "; gems=" + stage.gems().stream()
                .map(gem -> gem.position().x() + "," + gem.position().y() + "," + gem.position().z()
                    + "," + gem.material() + "," + gem.access().key() + "," + gem.offsetY() + "," + gem.radius())
                .collect(java.util.stream.Collectors.joining("|"))
            + "; goal=" + clean(stage.goal()) + "; brief=" + clean(stage.botBrief());
    }

    public static String clean(String value) {
        return value.replace('\n', ' ').replace('\r', ' ').replace(';', ',').strip();
    }
}
