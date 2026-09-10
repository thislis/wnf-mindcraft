package com.isttech.firewater.runtime;

import com.isttech.firewater.domain.Role;
import org.bukkit.entity.Player;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class RoleServiceTest {
    @Test
    void assignmentReplacesBotAndClearRestoresIt() {
        RoleService roles = new RoleService("Wade", "Ember");
        roles.assign(Role.WADE, "Builder");
        assertEquals(Role.WADE, roles.roleOf("builder").orElseThrow());
        assertTrue(roles.roleOf("Wade").isEmpty());
        assertTrue(roles.isManual(Role.WADE));
        assertFalse(roles.isManual(Role.EMBER));
        roles.clearAssignment(Role.WADE);
        assertEquals("Wade", roles.name(Role.WADE));
        assertTrue(roles.roleOf("Builder").isEmpty());
        assertFalse(roles.isManual(Role.WADE));
    }

    @Test
    void invalidAssignmentsLeavePreviousAssignmentsIntact() {
        RoleService roles = new RoleService("Wade", "Ember");
        roles.assign(Role.WADE, "Builder");
        assertThrows(IllegalArgumentException.class, () -> roles.assign(Role.EMBER, "builder"));
        assertThrows(IllegalArgumentException.class, () -> roles.assign(Role.WADE, "bad name"));
        assertEquals("Builder", roles.name(Role.WADE));
        assertEquals("Ember", roles.name(Role.EMBER));
        roles.assign(Role.EMBER, "Wade");
        assertThrows(IllegalArgumentException.class, () -> roles.clearAssignment(Role.WADE));
        assertEquals("Builder", roles.name(Role.WADE));
    }

    @Test
    void savedAssignmentsLoadAtomicallyEvenWhenTheyUseOtherDefaultNames() {
        RoleService roles = new RoleService("Wade", "Ember");
        roles.loadAssignments(Map.of(Role.WADE, "Ember", Role.EMBER, "Wade"));
        assertEquals(Role.WADE, roles.roleOf("Ember").orElseThrow());
        assertEquals(Role.EMBER, roles.roleOf("Wade").orElseThrow());
        assertThrows(IllegalArgumentException.class,
            () -> roles.loadAssignments(Map.of(Role.WADE, "Same", Role.EMBER, "same")));
        assertEquals("Ember", roles.name(Role.WADE));
    }

    @Test
    void manualPlayersAreNeverModifiedByBaselineOrIdleCleanup() {
        RoleService roles = new RoleService("Wade", "Ember");
        // Also support explicitly opting the usual bot name into manual mode.
        roles.assign(Role.WADE, "Wade");
        Player player = (Player) Proxy.newProxyInstance(Player.class.getClassLoader(), new Class<?>[]{Player.class},
            (proxy, method, args) -> {
                if (method.getName().equals("getName")) return "Wade";
                throw new AssertionError("Manual player's state was accessed: " + method.getName());
            });
        assertTrue(roles.isManual(player));
        assertFalse(roles.isDedicated(player));
        roles.enforceDedicatedBaseline(player);
        roles.restore(player);
    }
}
