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
            + "; goal=" + clean(stage.goal()) + "; brief=" + clean(stage.botBrief());
    }

    public static String clean(String value) {
        return value.replace('\n', ' ').replace('\r', ' ').replace(';', ',').strip();
    }
}
