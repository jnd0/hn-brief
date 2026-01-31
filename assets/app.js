// HN-Brief App JavaScript

const contentDiv = document.getElementById('content');
const loadingDiv = document.getElementById('loading');
const btnArticles = document.getElementById('btn-articles');
const btnDigest = document.getElementById('btn-digest');
const btnCalendar = document.getElementById('btn-calendar');
const calendarPopup = document.getElementById('calendar-popup');
const calendarDays = document.getElementById('calendar-days');
const calendarTitle = document.getElementById('calendar-title');
const prevMonthBtn = document.getElementById('prev-month');
const nextMonthBtn = document.getElementById('next-month');

let currentMode = 'digest';
let currentDate = null;
let archiveData = [];
let availableDates = new Set();
let viewYear, viewMonth;
const fileCache = {}; // Simple in-memory cache for fetched files

function getDomain(url) {
    if (!url || url === 'undefined') return '';
    try {
        return new URL(url).hostname.replace('www.', '');
    } catch { return ''; }
}

function parseArticleMarkdown(md) {
    const stories = [];
    let story = null;

    // Helper: append text to the current active section (discussion first, then summary)
    const appendTo = (text, separator = '\n') => {
        if (!story) return;
        if (story.discussion) {
            story.discussion += separator + text;
        } else if (story.summary) {
            story.summary += separator + text;
        }
    };

    for (const line of md.split('\n')) {
        // Skip empty lines and separators
        if (!line.trim() || line.startsWith('---') || line.startsWith('#') && !line.startsWith('## [')) {
            continue;
        }

        // New story header: ## [Title](url)
        const titleMatch = line.match(/^## \[(.+?)\]\((.+?)\)/);
        if (titleMatch) {
            if (story) stories.push(story);
            story = {
                title: titleMatch[1],
                url: titleMatch[2],
                score: 0,
                comments: 0,
                hnId: null,
                summary: '',
                summaryLabel: 'Article',
                discussion: ''
            };
            continue;
        }

        if (!story) continue;

        // Meta line: **Score:** N | **Comments:** N | **ID:** N
        const metaMatch = line.match(/\*\*Score:\*\* (\d+) \| \*\*Comments:\*\* (\d+)(?:\s*\|\s*\*\*ID:\*\*\s*(\d+))?/);
        if (metaMatch) {
            story.score = parseInt(metaMatch[1]);
            story.comments = parseInt(metaMatch[2]);
            story.hnId = metaMatch[3] || null;
            continue;
        }

        // Blockquote lines: > content
        if (line.startsWith('> ')) {
            const content = line.slice(2);
            const labelMatch = content.match(/^\*\*(Article|Question|Project|Post|Launch):\*\*/);

            if (labelMatch) {
                story.summaryLabel = labelMatch[1];
                story.summary = content.replace(labelMatch[0], '').trim();
            } else if (content.startsWith('**Discussion:**')) {
                story.discussion = content.replace('**Discussion:**', '').trim();
            } else {
                appendTo(content);
            }
            continue;
        }

        // List items (bullets or numbered)
        const isListItem = /^(\*|-(?!--)|\d+\.)\s/.test(line);
        if (isListItem) {
            appendTo(line);
            continue;
        }

        // Plain text continuation paragraphs
        appendTo(line.trim(), '\n\n');
    }

    if (story) stories.push(story);
    return stories;
}

function renderStories(stories) {
    let html = '<div class="itemlist">';

    stories.forEach((story, i) => {
        const domain = getDomain(story.url);
        const domainHtml = domain ? ` <span class="sitebit">(<a href="https://${domain}">${domain}</a>)</span>` : '';
        const hnUrl = story.hnId ? `https://news.ycombinator.com/item?id=${story.hnId}` : '#';
        const statsHtml = story.hnId
            ? `<a href="${hnUrl}" target="_blank" class="subtext-link">${story.score} points | ${story.comments} comments</a>`
            : `${story.score} points | ${story.comments} comments`;

        html += `
            <div class="athing">
                <span class="rank">${i + 1}.</span>
                <span class="titleline">
                    <a href="${story.url}" target="_blank">${story.title}</a>${domainHtml}
                    <span class="subtext-inline">${statsHtml}</span>
                </span>
            </div>
            <div class="summary-row">
                <div class="summary-content">
                <div class="summary-block">
                        <span class="summary-label">${story.summaryLabel}:</span> ${marked.parse(story.summary)}
                    </div>
                    <div class="summary-block">
                        <span class="summary-label">Discussion:</span> ${marked.parse(story.discussion)}
                    </div>
                </div>
            </div>
        `;
    });

    html += '</div>';
    return html;
}

// Calendar functions
function renderCalendar() {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    calendarTitle.textContent = `${monthNames[viewMonth]} ${viewYear}`;

    const firstDay = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const today = new Date().toISOString().split('T')[0];

    let html = '';

    // Empty cells for days before first of month
    for (let i = 0; i < firstDay; i++) {
        html += '<div class="cal-day"></div>';
    }

    // Days of the month
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const isAvailable = availableDates.has(dateStr);
        const isSelected = dateStr === currentDate;
        const isToday = dateStr === today;

        let classes = 'cal-day';
        if (isAvailable) classes += ' available';
        if (isSelected) classes += ' selected';
        if (isToday) classes += ' today';

        html += `<div class="${classes}" data-date="${dateStr}">${day}</div>`;
    }

    calendarDays.innerHTML = html;

    // Add click handlers
    calendarDays.querySelectorAll('.cal-day.available').forEach(el => {
        el.addEventListener('click', () => {
            const date = el.dataset.date;
            loadSummary(date);
            calendarPopup.style.display = 'none';
        });
    });
}

function toggleCalendar() {
    if (calendarPopup.style.display === 'none') {
        // Set view to current date's month or latest available
        if (currentDate) {
            const [year, month] = currentDate.split('-').map(Number);
            viewYear = year;
            viewMonth = month - 1;
        } else {
            const now = new Date();
            viewYear = now.getFullYear();
            viewMonth = now.getMonth();
        }
        renderCalendar();
        calendarPopup.style.display = 'block';
    } else {
        calendarPopup.style.display = 'none';
    }
}

async function loadArchiveIndex() {
    try {
        const res = await fetch('summaries/archive.json');
        if (!res.ok) throw new Error("Failed to load archive");
        archiveData = await res.json();

        // Build set of available dates
        archiveData.forEach(entry => {
            const date = typeof entry === 'string' ? entry : entry.date;
            availableDates.add(date);
        });

        const urlParams = new URLSearchParams(window.location.search);
        const queryDate = urlParams.get('date');
        const queryMode = urlParams.get('mode');

        const dates = archiveData.map(e => typeof e === 'string' ? e : e.date);
        const initialDate = dates.includes(queryDate) ? queryDate : dates[0];

        if (queryMode === 'articles') {
            currentMode = 'articles';
            btnArticles.classList.add('active');
            btnDigest.classList.remove('active');
        } else if (queryMode === 'digest') {
            currentMode = 'digest';
            btnDigest.classList.add('active');
            btnArticles.classList.remove('active');
        }

        if (initialDate) {
            currentDate = initialDate;
            await fetchAndDisplayDate(initialDate);
        } else {
            contentDiv.innerHTML = '<p class="error">No summaries available yet.</p>';
        }
    } catch (error) {
        console.error(error);
        contentDiv.innerHTML = '<p class="error">Failed to load archive.</p>';
    }
}

// Helper to get file paths for a date
function getFilePaths(date) {
    const [year, month, day] = date.split('-');
    return {
        articles: `summaries/${year}/${month}/${day}.md`,
        digest: `summaries/${year}/${month}/${day}-digest.md`
    };
}

// Fetch current mode, display, and preload other in background
async function fetchAndDisplayDate(date) {
    const paths = getFilePaths(date);
    const currentPath = currentMode === 'digest' ? paths.digest : paths.articles;
    const otherPath = currentMode === 'digest' ? paths.articles : paths.digest;

    // Fetch current mode if not cached
    if (!fileCache[currentPath]) {
        const res = await fetch(currentPath);
        if (res.ok) fileCache[currentPath] = await res.text();
    }
    displayCurrentMode();

    // Background preload other mode
    if (!fileCache[otherPath]) {
        fetch(otherPath).then(r => r.ok ? r.text() : null).then(md => { if (md) fileCache[otherPath] = md; });
    }
}

// Display content for current mode (assumes data is cached or handles missing)
function displayCurrentMode() {
    const paths = getFilePaths(currentDate);
    const filePath = currentMode === 'digest' ? paths.digest : paths.articles;
    const md = fileCache[filePath];

    if (!md) {
        contentDiv.innerHTML = currentMode === 'digest'
            ? `<p class="error">No digest available for ${currentDate}.</p>`
            : `<p class="error">No articles available for ${currentDate}.</p>`;
        return;
    }

    if (currentMode === 'articles') {
        const stories = parseArticleMarkdown(md);
        contentDiv.innerHTML = renderStories(stories);
    } else {
        const html = marked.parse(md);
        contentDiv.innerHTML = `<div class="digest-content">${html}</div>`;

        // Insert audio player bar aligned with H1
        const h1 = contentDiv.querySelector('h1');
        if (h1) {
            const headerContainer = document.createElement('div');
            headerContainer.className = 'digest-header-container';

            // Move H1 into container
            h1.parentNode.insertBefore(headerContainer, h1);
            headerContainer.appendChild(h1);

            const audioBar = document.createElement('div');
            audioBar.className = 'audio-player';
            audioBar.innerHTML = `
                <button class="audio-play-btn" id="audio-play-btn" title="Play">
                    <span class="play-icon">▶</span>
                </button>
                <span class="audio-time" id="audio-current">0:00</span>
                <input type="range" class="audio-slider" id="audio-slider" min="0" max="100" value="0">
                <span class="audio-time" id="audio-duration">0:00</span>
                <button class="audio-speed-btn" id="audio-speed-btn">1×</button>
            `;
            headerContainer.appendChild(audioBar);
        }
        initAudioPlayer();
    }
}

// Update URL to reflect current state
function updateUrl() {
    const url = new URL(window.location);
    url.searchParams.set('date', currentDate);
    url.searchParams.set('mode', currentMode);
    window.history.pushState({}, '', url);
}

// Load and display a date (used by calendar picker)
async function loadSummary(date) {
    resetAudioPlayer();
    currentDate = date;
    updateUrl();
    await fetchAndDisplayDate(date);
    loadingDiv.style.display = 'none';
}

// Switch between article and digest modes
function setMode(mode) {
    resetAudioPlayer();
    currentMode = mode;
    btnArticles.classList.toggle('active', mode === 'articles');
    btnDigest.classList.toggle('active', mode === 'digest');
    updateUrl();
    displayCurrentMode();
}


// Event Listeners
btnArticles.addEventListener('click', () => setMode('articles'));
btnDigest.addEventListener('click', () => setMode('digest'));
btnCalendar.addEventListener('click', toggleCalendar);

prevMonthBtn.addEventListener('click', () => {
    viewMonth--;
    if (viewMonth < 0) {
        viewMonth = 11;
        viewYear--;
    }
    renderCalendar();
});

nextMonthBtn.addEventListener('click', () => {
    viewMonth++;
    if (viewMonth > 11) {
        viewMonth = 0;
        viewYear++;
    }
    renderCalendar();
});

// Close calendar when clicking outside
document.addEventListener('click', (e) => {
    if (!calendarPopup.contains(e.target) && e.target !== btnCalendar) {
        calendarPopup.style.display = 'none';
    }
});

// ============================================================================
// Audio Player for TTS
// ============================================================================

// Detect environment and set TTS worker URL accordingly
const TTS_WORKER_URL = window.location.hostname === 'localhost'
    ? 'http://localhost:8787'
    : 'https://tts.hn-brief.com';
let audioPlayer = null;
let isPlaying = false;
let isLoading = false;

function initAudioPlayer() {
    const playBtn = document.getElementById('audio-play-btn');
    const currentSpan = document.getElementById('audio-current');
    const durationSpan = document.getElementById('audio-duration');
    const slider = document.getElementById('audio-slider');
    const speedBtn = document.getElementById('audio-speed-btn');

    if (!playBtn) return;

    // Speed cycle: 1 → 1.25 → 1.5 → 2 → 1
    const speeds = [1, 1.25, 1.5, 2];
    let speedIndex = 0;

    // Speed cycle
    speedBtn.addEventListener('click', () => {
        speedIndex = (speedIndex + 1) % speeds.length;
        const newSpeed = speeds[speedIndex];
        speedBtn.textContent = newSpeed === 1 ? '1×' : newSpeed + '×';
        if (audioPlayer) {
            audioPlayer.playbackRate = newSpeed;
        }
    });

    let isDragging = false;

    // Slider scrubbing logic
    // 1. Dragging start
    slider.addEventListener('mousedown', () => isDragging = true);
    slider.addEventListener('touchstart', () => isDragging = true);

    // 2. Dragging (visual update only)
    slider.addEventListener('input', () => {
        isDragging = true;
        if (audioPlayer && audioPlayer.duration) {
            const seekTime = (slider.value / 100) * audioPlayer.duration;
            currentSpan.textContent = formatTime(seekTime);
        }
    });

    // 3. Dragging end (commit seek)
    slider.addEventListener('change', () => {
        if (audioPlayer && audioPlayer.duration) {
            audioPlayer.currentTime = (slider.value / 100) * audioPlayer.duration;
        }
        isDragging = false;
    });

    // Ensure state resets on mouseup even if not moved
    slider.addEventListener('mouseup', () => isDragging = false);
    slider.addEventListener('touchend', () => isDragging = false);


    playBtn.addEventListener('click', async () => {
        if (isLoading) return;

        if (audioPlayer && isPlaying) {
            audioPlayer.pause();
            isPlaying = false;
            updatePlayButton(playBtn, 'paused');
            return;
        }

        if (audioPlayer && !isPlaying) {
            audioPlayer.play();
            isPlaying = true;
            updatePlayButton(playBtn, 'playing');
            return;
        }

        // First play - fetch audio
        isLoading = true;
        updatePlayButton(playBtn, 'loading');

        try {
            const audioUrl = `${TTS_WORKER_URL}/tts/${currentDate}`;

            // Explicitly fetch first to catch errors (404/500)
            const res = await fetch(audioUrl);
            if (!res.ok) {
                const errText = await res.text();
                // If 404, maybe digest not found. If 500, worker error.
                console.error(`TTS Error ${res.status}:`, errText);
                throw new Error(`Audio load failed (${res.status}): ${errText.slice(0, 100)}`);
            }

            const blob = await res.blob();
            // Force audio/mpeg type to help browser detection
            const mp3Blob = new Blob([blob], { type: 'audio/mpeg' });
            const blobUrl = URL.createObjectURL(mp3Blob);
            audioPlayer = new Audio(blobUrl);
            audioPlayer.blobUrl = blobUrl; // Store for cleanup

            audioPlayer.addEventListener('loadedmetadata', () => {
                durationSpan.textContent = formatTime(audioPlayer.duration);
            });

            let lastTimeDisplay = '';
            audioPlayer.addEventListener('timeupdate', () => {
                if (!audioPlayer) return; // Prevent error if player reset
                // Only update slider if user is NOT dragging it
                if (!isDragging) {
                    const newTimeDisplay = formatTime(audioPlayer.currentTime);
                    if (newTimeDisplay !== lastTimeDisplay) {
                        currentSpan.textContent = newTimeDisplay;
                        lastTimeDisplay = newTimeDisplay;
                    }
                    if (audioPlayer.duration) {
                        slider.value = (audioPlayer.currentTime / audioPlayer.duration) * 100;
                    }
                }
            });

            audioPlayer.addEventListener('ended', () => {
                isPlaying = false;
                updatePlayButton(playBtn, 'paused');
            });

            audioPlayer.addEventListener('error', (e) => {
                console.error('Audio error:', e);
                isLoading = false;
                audioPlayer = null;
                updatePlayButton(playBtn, 'paused');
                currentSpan.textContent = 'Error';
            });

            await audioPlayer.play();
            isLoading = false;
            isPlaying = true;
            updatePlayButton(playBtn, 'playing');

        } catch (error) {
            console.error('TTS error:', error);
            isLoading = false;
            updatePlayButton(playBtn, 'paused');
            currentSpan.textContent = 'Error';
        }
    });
}

function updatePlayButton(btn, state) {
    btn.classList.remove('playing');
    btn.disabled = false;

    switch (state) {
        case 'loading':
            btn.innerHTML = '<span class="audio-spinner"></span>';
            btn.disabled = true;
            break;
        case 'playing':
            btn.innerHTML = '<span class="play-icon">⏸</span>';
            btn.classList.add('playing');
            break;
        case 'paused':
        default:
            btn.innerHTML = '<span class="play-icon">▶</span>';
            break;
    }
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Reset audio player when changing dates
function resetAudioPlayer() {
    if (audioPlayer) {
        audioPlayer.pause();
        if (audioPlayer.blobUrl) {
            URL.revokeObjectURL(audioPlayer.blobUrl);
        }
        audioPlayer = null;
    }
    isPlaying = false;
    isLoading = false;
}

// Initialize
loadArchiveIndex();
