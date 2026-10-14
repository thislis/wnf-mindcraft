package com.isttech.firewater.runtime;

import com.isttech.firewater.domain.Role;
import org.bukkit.entity.Player;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class RoleTagSyncTest {
    @Test
    void configuredRolesRepairSwappedMissingAndSpectatorTagsWithoutReadingPosition() {
        TaggedPlayer wade = new TaggedPlayer("wAdE", "fw_ember", "unrelated");
        TaggedPlayer ember = new TaggedPlayer("Ember");
        TaggedPlayer spectator = new TaggedPlayer("Visitor", "fw_wade", "fw_ember", "unrelated");
        RoleService roles = service(wade, ember, spectator);
        roles.syncOnlineRoleTags();
        assertEquals(Set.of("fw_wade", "unrelated"), wade.tags);
        assertEquals(Set.of("fw_ember"), ember.tags);
        assertEquals(Set.of("unrelated"), spectator.tags);
        int writes = wade.writes + ember.writes + spectator.writes;
        roles.syncOnlineRoleTags();
        assertEquals(writes, wade.writes + ember.writes + spectator.writes);
        wade.tags.clear(); // Respawn or an external command removed the tag.
        ember.tags.add("fw_wade");
        roles.syncOnlineRoleTags();
        assertEquals(Set.of("fw_wade"), wade.tags);
        assertEquals(Set.of("fw_ember"), ember.tags);
    }

    @Test
    void assignmentTransfersTagsAndClearRestoresDedicatedAccountImmediately() {
        TaggedPlayer bot = new TaggedPlayer("Wade");
        TaggedPlayer first = new TaggedPlayer("Builder", "unrelated");
        TaggedPlayer second = new TaggedPlayer("Replacement");
        RoleService roles = service(bot, first, second);
        roles.loadAssignments(Map.of(Role.WADE, "Builder"));
        assertTrue(bot.tags.isEmpty());
        assertEquals(Set.of("fw_wade", "unrelated"), first.tags);
        roles.assign(Role.WADE, "Replacement");
        assertEquals(Set.of("unrelated"), first.tags);
        assertEquals(Set.of("fw_wade"), second.tags);
        roles.clearAssignment(Role.WADE);
        assertEquals(Set.of("fw_wade"), bot.tags);
        assertTrue(second.tags.isEmpty());
    }

    @Test
    void invalidAssignmentDoesNotChangeTagsAndSavedSwappedRolesAreSupported() {
        TaggedPlayer wade = new TaggedPlayer("Wade");
        TaggedPlayer ember = new TaggedPlayer("Ember");
        RoleService roles = service(wade, ember);
        roles.loadAssignments(Map.of(Role.WADE, "Ember", Role.EMBER, "Wade"));
        assertEquals(Set.of("fw_ember"), wade.tags);
        assertEquals(Set.of("fw_wade"), ember.tags);
        assertThrows(IllegalArgumentException.class, () -> roles.assign(Role.WADE, "Wade"));
        assertThrows(IllegalArgumentException.class, () -> roles.clearAssignment(Role.WADE));
        assertThrows(IllegalArgumentException.class,
            () -> roles.loadAssignments(Map.of(Role.WADE, "Same", Role.EMBER, "same")));
        assertEquals(Set.of("fw_ember"), wade.tags);
        assertEquals(Set.of("fw_wade"), ember.tags);
    }

    @Test
    void reconnectRemovesStaleOfflineAssignmentAndShutdownPreservesOtherTags() {
        TaggedPlayer builder = new TaggedPlayer("Builder", "unrelated");
        List<Player> online = new ArrayList<>(List.of(builder.player));
        RoleService roles = new RoleService("Wade", "Ember", () -> online);
        roles.assign(Role.WADE, "Builder");
        roles.clearRoleTags(builder.player); // Quit cleanup.
        assertEquals(Set.of("unrelated"), builder.tags);
        online.clear();
        builder.tags.add("fw_wade"); // Old persisted tag after an unclean disconnect.
        roles.clearAssignment(Role.WADE);
        roles.syncRoleTags(builder.player); // Join must clean even an unassigned player.
        assertEquals(Set.of("unrelated"), builder.tags);
        online.add(builder.player);
        roles.assign(Role.EMBER, "Builder");
        assertEquals(Set.of("fw_ember", "unrelated"), builder.tags);
        roles.clearOnlineRoleTags();
        assertEquals(Set.of("unrelated"), builder.tags);
    }

    private static RoleService service(TaggedPlayer... players) {
        List<Player> online = java.util.Arrays.stream(players).map(p -> p.player).toList();
        return new RoleService("Wade", "Ember", () -> online);
    }

    private static final class TaggedPlayer {
        final Set<String> tags;
        final Player player;
        int writes;

        TaggedPlayer(String name, String... initialTags) {
            tags = new HashSet<>(List.of(initialTags));
            player = (Player) Proxy.newProxyInstance(Player.class.getClassLoader(), new Class<?>[]{Player.class},
                (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "getName": return name;
                        case "getScoreboardTags": return Set.copyOf(tags);
                        case "addScoreboardTag": writes++; return tags.add((String) args[0]);
                        case "removeScoreboardTag": writes++; return tags.remove((String) args[0]);
                        default: throw new AssertionError("Unexpected player access: " + method.getName());
                    }
                });
        }
    }
}
