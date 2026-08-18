const requiredMajor = 22;
const actualMajor = Number.parseInt(process.versions.node.split('.')[0], 10);

if (actualMajor !== requiredMajor) {
    throw new Error(
        `Firewater vision requires Node ${requiredMajor}.x; current runtime is ${process.version}. `
        + 'Run npm install so the pinned local Node runtime is available, then use npm start.',
    );
}

await import('../src/agent/vision/camera.js');
console.log(`FIREWATER_NATIVE_RUNTIME_OK node=${process.version} camera=imported`);
