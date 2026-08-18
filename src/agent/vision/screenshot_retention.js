export function screenshotsToPrune(entries, maxScreenshots = 40) {
    const screenshots = entries
        .filter(name => /^screenshot_.*\.jpg$/i.test(name))
        .sort();
    return screenshots.slice(0, Math.max(0, screenshots.length - maxScreenshots));
}
