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
    const lines = md.split('\n');
    const stories = [];
    let currentStory = null;

    for (const line of lines) {
        const titleMatch = line.match(/^## \[(.+?)\]\((.+?)\)/);
        if (titleMatch) {
            if (currentStory) stories.push(currentStory);
            currentStory = {
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

        // Match meta line with optional ID
        const metaMatch = line.match(/\*\*Score:\*\* (\d+) \| \*\*Comments:\*\* (\d+)(?:\s*\|\s*\*\*ID:\*\*\s*(\d+))?/);
        if (metaMatch && currentStory) {
            currentStory.score = parseInt(metaMatch[1]);
            currentStory.comments = parseInt(metaMatch[2]);
            currentStory.hnId = metaMatch[3] || null;
            continue;
        }

        if (line.startsWith('> ')) {
            const content = line.substring(2);
            // Match dynamic labels: Article, Question, Project, Post, Launch
            const labelMatch = content.match(/^\*\*(Article|Question|Project|Post|Launch):\*\*/);
            if (labelMatch) {
                currentStory.summaryLabel = labelMatch[1];
                currentStory.summary = content.replace(/^\*\*(Article|Question|Project|Post|Launch):\*\*/, '').trim();
            } else if (content.startsWith('**Discussion:**')) {
                currentStory.discussion = content.replace('**Discussion:**', '').trim();
            } else if (currentStory) {
                if (currentStory.discussion) {
                    currentStory.discussion += ' ' + content;
                } else if (currentStory.summary) {
                    currentStory.summary += ' ' + content;
                }
            }
        }
    }

    if (currentStory) stories.push(currentStory);
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
                        <span class="summary-label">${story.summaryLabel}:</span> ${marked.parseInline(story.summary)}
                    </div>
                    <div class="summary-block">
                        <span class="summary-label">Discussion:</span> ${marked.parseInline(story.discussion)}
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

        if (queryMode === 'digest') {
            currentMode = 'digest';
            btnDigest.classList.add('active');
            btnArticles.classList.remove('active');
        }

        if (initialDate) {
            currentDate = initialDate;
            loadSummary(initialDate);
        } else {
            contentDiv.innerHTML = '<p class="error">No summaries available yet.</p>';
        }
    } catch (error) {
        console.error(error);
        contentDiv.innerHTML = '<p class="error">Failed to load archive.</p>';
    }
}

async function loadSummary(date) {
    loadingDiv.style.display = 'block';
    contentDiv.innerHTML = '';
    currentDate = date;

    const url = new URL(window.location);
    url.searchParams.set('date', date);
    url.searchParams.set('mode', currentMode);
    window.history.pushState({}, '', url);

    // Build path: summaries/YYYY/MM/DD.md or DD-digest.md
    const [year, month, day] = date.split('-');
    const filename = currentMode === 'digest' ? `${day}-digest.md` : `${day}.md`;
    const filePath = `summaries/${year}/${month}/${filename}`;

    try {
        // Use cache if available
        let md = fileCache[filePath];
        if (!md) {
            const res = await fetch(filePath);
            if (!res.ok) throw new Error("Summary not found");
            md = await res.text();
            fileCache[filePath] = md;
        }

        if (currentMode === 'articles') {
            const stories = parseArticleMarkdown(md);
            contentDiv.innerHTML = renderStories(stories);
        } else {
            const html = marked.parse(md);
            contentDiv.innerHTML = `<div class="digest-content">${html}</div>`;
        }
    } catch (error) {
        if (currentMode === 'digest') {
            contentDiv.innerHTML = `<p class="error">No digest available for ${date}.</p>`;
        } else {
            contentDiv.innerHTML = `<p class="error">Error loading summary for ${date}.</p>`;
        }
    } finally {
        loadingDiv.style.display = 'none';
    }
}

function setMode(mode) {
    currentMode = mode;
    btnArticles.classList.toggle('active', mode === 'articles');
    btnDigest.classList.toggle('active', mode === 'digest');
    if (currentDate) loadSummary(currentDate);
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

// Initialize
loadArchiveIndex();
