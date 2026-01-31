const { formatTime } = require('../assets/utils.js');

// Mock DOM element
class MockElement {
    constructor() {
        this._textContent = '';
        this.writeCount = 0;
    }

    get textContent() {
        return this._textContent;
    }

    set textContent(value) {
        this._textContent = value;
        this.writeCount++;
    }
}

// Simulation parameters
const DURATION_SECONDS = 60;
const FREQUENCIES = [4, 15, 60]; // Hz

console.log(`\n--- DOM Update Benchmark (${DURATION_SECONDS}s audio) ---\n`);

FREQUENCIES.forEach(freq => {
    console.log(`Frequency: ${freq} Hz (${freq * DURATION_SECONDS} events)`);

    // Baseline Run
    const baselineSpan = new MockElement();
    let currentTime = 0;
    const timeStep = 1 / freq;

    for (let i = 0; i < freq * DURATION_SECONDS; i++) {
        // Current logic: Unconditional update
        baselineSpan.textContent = formatTime(currentTime);
        currentTime += timeStep;
    }

    // Optimized Run
    const optimizedSpan = new MockElement();
    let lastTimeDisplay = '';
    currentTime = 0;

    for (let i = 0; i < freq * DURATION_SECONDS; i++) {
        // Optimized logic: Conditional update
        const newTimeStr = formatTime(currentTime);
        if (newTimeStr !== lastTimeDisplay) {
            optimizedSpan.textContent = newTimeStr;
            lastTimeDisplay = newTimeStr;
        }
        currentTime += timeStep;
    }

    const reduction = ((baselineSpan.writeCount - optimizedSpan.writeCount) / baselineSpan.writeCount * 100).toFixed(1);

    console.log(`  Baseline Writes:  ${baselineSpan.writeCount}`);
    console.log(`  Optimized Writes: ${optimizedSpan.writeCount}`);
    console.log(`  Reduction:        ${reduction}%\n`);
});
