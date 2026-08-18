import { Viewer } from 'prismarine-viewer/viewer/lib/viewer.js';
import { WorldView } from 'prismarine-viewer/viewer/lib/worldView.js';
import { getBufferFromStream } from 'prismarine-viewer/viewer/lib/simpleUtils.js';

import THREE from 'three';
import { createCanvas } from 'node-canvas-webgl/lib/index.js';
import fs from 'fs/promises';
import { Vec3 } from 'vec3';
import { EventEmitter } from 'events';
import { screenshotsToPrune } from './screenshot_retention.js';

import worker_threads from 'worker_threads';
global.Worker = worker_threads.Worker;
// prismarine-viewer's CommonJS entity renderer expects THREE as a global.
// Supplying it here prevents entity spawn/update events from throwing while
// the headless camera captures the four Firewater views.
globalThis.THREE = THREE;

export class Camera extends EventEmitter {
    constructor (bot, fp, options = {}) {
        super();
        this.bot = bot;
        this.fp = fp;
        this.viewDistance = options.viewDistance ?? 16;
        this.maxScreenshots = options.maxScreenshots ?? 40;
        this.captureSequence = 0;
        this.width = 800;
        this.height = 512;
        this.canvas = createCanvas(this.width, this.height);
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas });
        this.viewer = new Viewer(this.renderer);
        this.readyPromise = this._init().then(() => {
            this.emit('ready');
        }).catch(error => {
            this.emit('cameraError', error);
            throw error;
        });
    }

    async waitUntilReady() {
        await this.readyPromise;
    }
  
    async _init () {
        const botPos = this.bot.entity.position;
        const center = new Vec3(botPos.x, botPos.y+this.bot.entity.height, botPos.z);
        this.viewer.setVersion(this.bot.version);
        // Load world
        const worldView = new WorldView(this.bot.world, this.viewDistance, center);
        this.viewer.listen(worldView);
        worldView.listenToBot(this.bot);
        await worldView.init(center);
        this.worldView = worldView;
    }
  
    async capture() {
        await this.waitUntilReady();
        const center = new Vec3(this.bot.entity.position.x, this.bot.entity.position.y+this.bot.entity.height, this.bot.entity.position.z);
        this.viewer.camera.position.set(center.x, center.y, center.z);
        await this.worldView.updatePosition(center);
        this.viewer.setFirstPersonCamera(this.bot.entity.position, this.bot.entity.yaw, this.bot.entity.pitch);
        this.viewer.update();
        this.renderer.render(this.viewer.scene, this.viewer.camera);

        const imageStream = this.canvas.createJPEGStream({
            bufsize: 4096,
            quality: 100,
            progressive: false
        });
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `screenshot_${timestamp}_${String(this.captureSequence++).padStart(4, '0')}`;

        const buf = await getBufferFromStream(imageStream);
        await this._ensureScreenshotDirectory();
        await fs.writeFile(`${this.fp}/${filename}.jpg`, buf);
        await this._pruneScreenshots();
        console.log('saved', filename);
        return filename;
    }

    async _ensureScreenshotDirectory() {
        let stats;
        try {
            stats = await fs.stat(this.fp);
        } catch (e) {
            if (!stats?.isDirectory()) {
                await fs.mkdir(this.fp, { recursive: true });
            }
        }
    }

    async _pruneScreenshots() {
        const entries = await fs.readdir(this.fp);
        const excess = screenshotsToPrune(entries, this.maxScreenshots);
        await Promise.all(excess.map(name => fs.unlink(`${this.fp}/${name}`)));
    }
}
  
