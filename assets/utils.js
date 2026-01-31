// Shared utility functions for HN-Brief

/**
 * Formats seconds into MM:SS format
 * @param {number} seconds
 * @returns {string} e.g. "5:30"
 */
function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Export for Node/Bun environments (benchmarks/tests)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { formatTime };
}
