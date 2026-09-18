/** Wait for the camera column, worker geometry, and texture image before capture. */
export async function waitForWorldRender(world, position, options = {}) {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const pollIntervalMs = options.pollIntervalMs ?? 25;
    const deadline = Date.now() + timeoutMs;
    const x = Math.floor(position.x / 16) * 16;
    const z = Math.floor(position.z / 16) * 16;
    const key = `${x},${z}`;
    while (true) {
        if (options.isInterrupted?.()) throw new Error('Screenshot rendering interrupted.');
        const error = options.getError?.();
        if (error) throw new Error(`Screenshot renderer failed: ${error.message}`);
        const columnReady = !!world.loadedChunks[key];
        const meshReady = Object.keys(world.sectionMeshs).some(section =>
            section.startsWith(`${x},`) && section.endsWith(`,${z}`));
        const pending = world.sectionsOutstanding.size;
        const textureReady = !!(world.material.map?.image?.width && world.material.map?.image?.height);
        if (columnReady && meshReady && pending === 0 && textureReady) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            throw new Error(`Screenshot render not ready after ${timeoutMs}ms: ` +
                `column=${key} loaded=${columnReady} mesh=${meshReady} pending=${pending} texture=${textureReady}. Retry observation after the world loads.`);
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
    }
}
