package com.isttech.firewater.domain;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LatchAndMessageTest {
    @Test
    void failureIsLatchedOncePerAttempt() {
        FailureLatch<String> latch = new FailureLatch<>();
        assertTrue(latch.latch("Wade"));
        assertFalse(latch.latch("Wade"));
        latch.reset();
        assertTrue(latch.latch("Wade"));
    }

    @Test
    void messagesAreDeduplicatedByProtocolKey() {
        MessageDeduplicator deduplicator = new MessageDeduplicator();
        assertTrue(deduplicator.shouldSend("session:start:1"));
        assertFalse(deduplicator.shouldSend("session:start:1"));
        assertTrue(deduplicator.shouldSend("session:reset:2"));
    }
}
